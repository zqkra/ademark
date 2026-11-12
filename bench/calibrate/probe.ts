// `ademark calibrate probe --ade <id>`: what the app bundle alone says about an ADE.
// Reads files only. It never launches, opens, quits or attaches to the app, and never posts keys or clicks.
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Adapter } from "../core/contracts.ts";
import { countBytes, readAt } from "./binary.ts";
import {
  asarHeaderLength,
  isJavaScript,
  listAsarFiles,
  parseAsarHeader,
  scanShortcuts,
  type AsarHeader,
  type ShortcutCandidate,
} from "./asar.ts";
import { readFuses, type FuseReport } from "./fuses.ts";

export interface ProbeTarget {
  ade: string;
  appName: string;
  appPath: string;
  bundleId: string | null;
}

export interface ProbeBundle {
  id: string | null;
  version: string | null;
  build: string | null;
  executable: string | null;
  minimumMacOS: string | null;
  urlSchemes: string[];
}

export interface StackMarkers {
  tauri: number;
  gpui: number;
}

export interface ProbeStack {
  kind: "Electron" | "Chromium (renamed)" | "Tauri" | "GPUI" | "native";
  version: string | null;
  framework: string | null;
  markers: StackMarkers | null;
}

export interface ProbeAsar {
  files: number;
  jsFiles: number;
  candidates: ShortcutCandidate[];
  truncated: boolean;
}

export interface ProbeDataFolder {
  path: string;
  bytes: number | null;
}

export interface ProbeResult {
  ade: string;
  appPath: string;
  bundle: ProbeBundle;
  stack: ProbeStack;
  fuses: FuseReport | null;
  asar: ProbeAsar | null;
  dataFolders: ProbeDataFolder[];
  executables: string[];
}

const MAX_CANDIDATES = 200;
const SCAN_CHUNK = 1 << 20;
const SCAN_OVERLAP = 1024;
const SCAN_BUDGET = 256 << 20;
const MAX_EXECUTABLES = 50;
const WANTED_EXECUTABLES = new Set(["claude", "codex", "node"]);

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readJsonPlist(path: string): Json | null {
  if (!existsSync(path)) return null;
  const result = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  try {
    return asObject(JSON.parse(result.stdout.toString()));
  } catch {
    return null;
  }
}

function urlSchemes(info: Json | null): string[] {
  const types = info?.CFBundleURLTypes;
  if (!Array.isArray(types)) return [];
  const schemes: string[] = [];
  for (const type of types) {
    const entry = asObject(type);
    const list = entry?.CFBundleURLSchemes;
    if (!Array.isArray(list)) continue;
    for (const scheme of list) {
      const value = text(scheme);
      if (value !== null && !schemes.includes(value)) schemes.push(value);
    }
  }
  return schemes;
}

function readBundle(appPath: string, fallbackId: string | null): ProbeBundle {
  const info = readJsonPlist(join(appPath, "Contents", "Info.plist"));
  return {
    id: text(info?.CFBundleIdentifier) ?? fallbackId,
    version: text(info?.CFBundleShortVersionString),
    build: text(info?.CFBundleVersion),
    executable: text(info?.CFBundleExecutable),
    minimumMacOS: text(info?.LSMinimumSystemVersion),
    urlSchemes: urlSchemes(info),
  };
}

function mainExecutable(appPath: string, bundle: ProbeBundle): string | null {
  if (bundle.executable !== null) {
    const path = join(appPath, "Contents", "MacOS", bundle.executable);
    if (existsSync(path)) return path;
  }
  const dir = join(appPath, "Contents", "MacOS");
  if (!existsSync(dir)) return null;
  try {
    const first = readdirSync(dir).sort()[0];
    return first === undefined ? null : join(dir, first);
  } catch {
    return null;
  }
}

function frameworkVersion(framework: string): string | null {
  for (const rel of ["Versions/A/Resources/Info.plist", "Versions/Current/Resources/Info.plist", "Resources/Info.plist"]) {
    const info = readJsonPlist(join(framework, rel));
    const version = text(info?.CFBundleShortVersionString) ?? text(info?.CFBundleVersion);
    if (version !== null) return version;
  }
  return null;
}

// App Translocation and shipped frameworks put the Chromium payload a few levels down; a bounded walk is enough.
function findNamed(root: string, name: string, maxDepth: number): string | null {
  const walk = (dir: string, depth: number): string | null => {
    if (depth > maxDepth) return null;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === name) return path;
      if (entry.isDirectory()) {
        const found = walk(path, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(root, 0);
}

// Names like `tauri` also appear in Rust dependency and source paths. These markers say the toolkit is the runtime.
const TAURI_MARKERS = ["__TAURI_INTERNALS__", "tauri://localhost"];
const GPUI_MARKERS = ["gpui::", "gpui/src"];
const STACK_MARKERS = [...TAURI_MARKERS, ...GPUI_MARKERS].map((marker) => new TextEncoder().encode(marker));

function countStackMarkers(executable: string): StackMarkers {
  const counts = countBytes(executable, STACK_MARKERS);
  return {
    tauri: (counts[0] ?? 0) + (counts[1] ?? 0),
    gpui: (counts[2] ?? 0) + (counts[3] ?? 0),
  };
}

function detectStack(appPath: string, executable: string | null): ProbeStack {
  const frameworks = join(appPath, "Contents", "Frameworks");
  const electron = join(frameworks, "Electron Framework.framework");
  if (existsSync(electron)) {
    return {
      kind: "Electron",
      version: frameworkVersion(electron),
      framework: "Electron Framework.framework",
      markers: null,
    };
  }
  if (existsSync(frameworks)) {
    let names: string[] = [];
    try {
      names = readdirSync(frameworks).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".framework")) continue;
      const framework = join(frameworks, name);
      if (findNamed(framework, "chrome_100_percent.pak", 6) === null) continue;
      return { kind: "Chromium (renamed)", version: frameworkVersion(framework), framework: name, markers: null };
    }
  }
  if (executable !== null) {
    const markers = countStackMarkers(executable);
    if (markers.tauri > markers.gpui) return { kind: "Tauri", version: null, framework: null, markers };
    if (markers.gpui > markers.tauri) return { kind: "GPUI", version: null, framework: null, markers };
    if (markers.gpui > 0) return { kind: "GPUI", version: null, framework: null, markers };
  }
  return { kind: "native", version: null, framework: null, markers: null };
}

function electronFrameworkBinary(appPath: string): string | null {
  const framework = join(appPath, "Contents", "Frameworks", "Electron Framework.framework");
  for (const rel of ["Versions/A/Electron Framework", "Versions/Current/Electron Framework", "Electron Framework"]) {
    const path = join(framework, rel);
    if (existsSync(path)) return path;
  }
  return null;
}

function readAsarHeader(asarPath: string): AsarHeader {
  const head = readAt(asarPath, 0, 16);
  const length = asarHeaderLength(head);
  return parseAsarHeader(readAt(asarPath, 0, length));
}

interface ScanBudget {
  left: number;
}

function scanFile(
  file: string,
  size: number,
  read: (offset: number, length: number) => Uint8Array,
  budget: ScanBudget,
  seen: Set<string>,
  out: ShortcutCandidate[],
): boolean {
  for (let position = 0; position < size; position += SCAN_CHUNK) {
    if (budget.left <= 0 || out.length >= MAX_CANDIDATES) return false;
    const length = Math.min(SCAN_CHUNK + SCAN_OVERLAP, size - position);
    const buffer = read(position, length);
    budget.left -= buffer.length;
    const text = new TextDecoder().decode(buffer);
    for (const candidate of scanShortcuts(text, file)) {
      const key = `${candidate.file}|${candidate.match}|${candidate.commandId ?? ""}|${candidate.context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= MAX_CANDIDATES) return false;
    }
    if (buffer.length < length) return true;
  }
  return true;
}

function probeAsar(appPath: string): ProbeAsar | null {
  const asarPath = join(appPath, "Contents", "Resources", "app.asar");
  if (!existsSync(asarPath)) return null;
  const header = readAsarHeader(asarPath);
  const entries = listAsarFiles(header);
  // The app's own code first: bundled node_modules dwarfs it and would spend the scan budget before dist/.
  const jsFiles = entries
    .filter((entry) => isJavaScript(entry.path))
    .sort((left, right) => Number(left.path.includes("/node_modules/")) - Number(right.path.includes("/node_modules/")));
  const unpackedDir = join(appPath, "Contents", "Resources", "app.asar.unpacked");
  const budget: ScanBudget = { left: SCAN_BUDGET };
  const seen = new Set<string>();
  const candidates: ShortcutCandidate[] = [];
  let scannedAll = true;
  for (const entry of jsFiles) {
    if (budget.left <= 0 || candidates.length >= MAX_CANDIDATES) {
      scannedAll = false;
      break;
    }
    if (entry.unpacked) {
      const path = join(unpackedDir, entry.path);
      if (!existsSync(path)) continue;
      const size = statSync(path).size;
      scannedAll = scanFile(entry.path, size, (offset, length) => readAt(path, offset, length), budget, seen, candidates) && scannedAll;
    } else {
      const { offset } = entry;
      scannedAll =
        scanFile(
          entry.path,
          entry.size,
          (position, length) => readAt(asarPath, header.baseOffset + offset + position, length),
          budget,
          seen,
          candidates,
        ) && scannedAll;
    }
  }
  return { files: entries.length, jsFiles: jsFiles.length, candidates, truncated: !scannedAll };
}

function humanBytes(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

function directoryBytes(path: string): number | null {
  const result = Bun.spawnSync(["du", "-sk", path], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  const kb = Number(result.stdout.toString().trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

function dataFolderCandidates(appName: string, bundleId: string | null): string[] {
  const home = homedir();
  const paths = [join(home, "Library", "Application Support", appName)];
  if (bundleId !== null) {
    paths.push(
      join(home, "Library", "Application Support", bundleId),
      join(home, "Library", "Caches", bundleId),
    );
  }
  paths.push(join(home, `.${appName.toLowerCase()}`));
  return [...new Set(paths)];
}

function probeDataFolders(appName: string, bundleId: string | null): ProbeDataFolder[] {
  const found: ProbeDataFolder[] = [];
  for (const path of dataFolderCandidates(appName, bundleId)) {
    if (!existsSync(path)) continue;
    found.push({ path, bytes: directoryBytes(path) });
  }
  return found;
}

function probeExecutables(appPath: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= MAX_EXECUTABLES || depth > 6) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_EXECUTABLES) return;
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !WANTED_EXECUTABLES.has(entry.name)) continue;
      try {
        if ((statSync(path).mode & 0o111) === 0) continue;
      } catch {
        continue;
      }
      found.push(relative(appPath, path));
    }
  };
  walk(appPath, 0);
  return found.sort();
}

export function probeApp(target: ProbeTarget): ProbeResult {
  if (!existsSync(target.appPath)) throw new Error(`probe: ${target.appPath} is not installed`);
  const bundle = readBundle(target.appPath, target.bundleId);
  const executable = mainExecutable(target.appPath, bundle);
  const stack = detectStack(target.appPath, executable);
  const fusesBinary = stack.kind === "Electron" ? electronFrameworkBinary(target.appPath) : null;
  const fuses = fusesBinary === null ? null : readFuses(fusesBinary);
  return {
    ade: target.ade,
    appPath: target.appPath,
    bundle,
    stack,
    fuses,
    asar: probeAsar(target.appPath),
    dataFolders: probeDataFolders(target.appName, bundle.id),
    executables: probeExecutables(target.appPath),
  };
}

export function probeAdapter(adapter: Adapter): ProbeResult {
  const hints = adapter.processes();
  const appPath = hints.bundlePaths[0];
  if (appPath === undefined) throw new Error(`probe: ${adapter.id} has no app bundle path`);
  return probeApp({
    ade: adapter.id,
    appName: adapter.calibration.appName,
    appPath,
    bundleId: adapter.calibration.bundleId,
  });
}

function fusesLine(fuses: FuseReport): string {
  const states = fuses.fuses.map((fuse) =>
    fuse.state === "unknown" ? `${fuse.name}=0x${fuse.raw.toString(16)}` : `${fuse.name}=${fuse.state}`,
  );
  return `fuses: version ${fuses.version}, ${fuses.count} fuses: ${states.join(", ")}`;
}

export function formatProbe(result: ProbeResult): string {
  const lines: string[] = [];
  const { bundle, stack } = result;
  lines.push(`${result.ade} (${result.appPath})`);
  lines.push(
    `info: bundle id ${bundle.id ?? "unknown"}, version ${bundle.version ?? "unknown"} ` +
      `(build ${bundle.build ?? "unknown"}), executable ${bundle.executable ?? "unknown"}, ` +
      `minimum macOS ${bundle.minimumMacOS ?? "unknown"}, URL schemes ${bundle.urlSchemes.join(", ") || "none"}`,
  );
  let markerCounts = "";
  if (stack.markers !== null && stack.markers.tauri > 0 && stack.markers.gpui > 0) {
    markerCounts = ` (tauri ${stack.markers.tauri} markers, gpui ${stack.markers.gpui} markers)`;
  }
  lines.push(
    `stack: ${stack.kind}${stack.version !== null ? ` ${stack.version}` : ""}` +
      `${stack.framework !== null ? ` (${stack.framework})` : ""}${markerCounts}`,
  );
  if (result.fuses !== null) lines.push(fusesLine(result.fuses));
  if (result.asar === null) {
    lines.push("app.asar: none");
  } else {
    lines.push(
      `app.asar: ${result.asar.files} entries, ${result.asar.jsFiles} JS files, ` +
        `${result.asar.candidates.length} shortcut candidates${result.asar.truncated ? " (scan truncated)" : ""}`,
    );
    for (const candidate of result.asar.candidates) {
      const id = candidate.commandId === null ? "" : `  [${candidate.commandId}]`;
      lines.push(`  ${candidate.match}${id}  ${candidate.context}`);
    }
  }
  if (result.dataFolders.length === 0) lines.push("data folders: none");
  else {
    lines.push("data folders:");
    for (const folder of result.dataFolders) lines.push(`  ${folder.path}  ${humanBytes(folder.bytes)}`);
  }
  if (result.executables.length === 0) lines.push("executables: none");
  else {
    lines.push("executables:");
    for (const executable of result.executables) lines.push(`  ${executable}`);
  }
  return lines.join("\n");
}
