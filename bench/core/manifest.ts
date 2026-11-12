// Collects results/<run-id>/manifest.json (TESTS.md 1.1). Every command here is read-only.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAdapters } from "../adapters/registry.ts";
import type { Manifest } from "./contracts.ts";
import { hashFile, hashFolder } from "./hash.ts";
import { shuffle } from "./order.ts";
import { priceFile, repoRoot, tasksRoot } from "./paths.ts";

export interface ManifestOptions {
  runId: string;
  machineId?: string;
  orderSeed: string;
  order?: string[];
  reference?: boolean;
  /** `smoke` marks a one-repetition rehearsal run; missing means `full` (TESTS.md §0.1). */
  mode?: Manifest["mode"];
  startedAt?: string;
  adeVersions?: Record<string, { version: string; sha256: string | null }>;
  root?: string;
}

function run(argv: string[], cwd?: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${result.exitCode}): ${argv.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function tryRun(argv: string[], cwd?: string): string | null {
  try {
    return run(argv, cwd);
  } catch {
    return null;
  }
}

interface DisplayInfo {
  width: number;
  height: number;
  scale: number;
  refresh_hz: number;
}

export function parseDisplay(json: string): DisplayInfo {
  const parsed = JSON.parse(json) as { SPDisplaysDataType?: Array<{ spdisplays_ndrvs?: Array<Record<string, unknown>> }> };
  const adapters = parsed.SPDisplaysDataType ?? [];
  const screens = adapters.flatMap((adapter) => adapter.spdisplays_ndrvs ?? []);
  const screen = screens.find((entry) => entry.spdisplays_main === "spdisplays_yes") ?? screens[0];
  if (!screen) throw new Error("system_profiler reported no display");

  const resolution = String(screen._spdisplays_resolution ?? "");
  const match = resolution.match(/(\d+)\s*x\s*(\d+)(?:\s*@\s*([\d.]+)\s*Hz)?/i);
  if (!match) throw new Error(`cannot parse display resolution: ${resolution}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const refresh = match[3] ? Number(match[3]) : 60;

  const pixels = String(screen._spdisplays_pixels ?? "");
  const pixelMatch = pixels.match(/(\d+)\s*x\s*(\d+)/i);
  const scale = pixelMatch ? Math.max(1, Math.round(Number(pixelMatch[1]) / width)) : 1;

  return { width, height, scale, refresh_hz: refresh };
}

export function parseHardware(model: string, memoryBytes: string, chip: string): Manifest["hardware"] {
  const bytes = Number(memoryBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`bad hw.memsize: ${memoryBytes}`);
  return { model: model.trim(), chip: chip.trim(), ram_gb: Math.round(bytes / 1024 ** 3) };
}

export function parseCliVersion(name: string, output: string): [string, string] {
  return [name, output.trim()];
}

export function defaultMachineId(hardware: Manifest["hardware"]): string {
  if (hardware.model === "Mac16,10" && hardware.ram_gb === 16 && hardware.chip === "Apple M4") {
    return "ref-mac-mini-m4-16gb";
  }
  const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug(hardware.model)}-${slug(hardware.chip)}-${hardware.ram_gb}gb`;
}

// Async because installCheck() is async: TESTS.md 1.1 wants every ADE version in the manifest.
export async function collectManifest(options: ManifestOptions): Promise<Manifest> {
  const root = options.root ?? repoRoot;
  const hw = run(["sysctl", "-n", "hw.model", "hw.memsize", "machdep.cpu.brand_string"]).split("\n");
  const hardware = parseHardware(hw[0] ?? "", hw[1] ?? "", hw[2] ?? "");

  const macosBuild = run(["sw_vers", "-buildVersion"]);
  const display = parseDisplay(run(["system_profiler", "SPDisplaysDataType", "-json"]));

  const cliVersions: Record<string, string> = {};
  const claude = tryRun(["claude", "--version"]);
  if (claude !== null) cliVersions.claude = claude;
  const codex = tryRun(["codex", "--version"]);
  if (codex !== null) cliVersions.codex = codex;

  const tasksDir = tasksRoot();
  const taskHashes: Record<string, string> = {};
  if (existsSync(tasksDir)) {
    for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(tasksDir, entry.name);
      if (!statSync(dir).isDirectory()) continue;
      taskHashes[entry.name] = hashFolder(dir);
    }
  }

  let adeVersions = options.adeVersions;
  if (adeVersions === undefined) {
    adeVersions = {};
    for (const adapter of listAdapters()) {
      const info = await adapter.installCheck();
      if (info.installed) adeVersions[adapter.id] = { version: info.version ?? "unknown", sha256: info.binarySha256 };
    }
  }

  const prices = priceFile();
  const harnessCommit = tryRun(["git", "rev-parse", "HEAD"], root);
  const order = options.order ?? shuffle(listAdapters().map((adapter) => adapter.id), options.orderSeed);

  return {
    run_id: options.runId,
    machine_id: options.machineId ?? defaultMachineId(hardware),
    verified: options.reference === true,
    hardware,
    macos_build: macosBuild,
    display,
    harness_commit: harnessCommit,
    cli_versions: cliVersions,
    ade_versions: adeVersions,
    task_hashes: taskHashes,
    price_file_sha256: existsSync(prices) ? hashFile(prices) : null,
    order_seed: options.orderSeed,
    order,
    started_at: options.startedAt ?? new Date().toISOString(),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
}

export function writeManifest(runDir: string, manifest: Manifest): string {
  const dir = resolve(runDir);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
