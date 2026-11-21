// `pins record` writes ~/ademark-private/pins/versions.json from the apps installed on this Mac.
// `pins profiles` compares each profile's and gate's pinned version and bundle SHA-256 with the installed app.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../adapters/registry.ts";
import { appPathFor, checkApp, parseVersionOutput, readBundleInfo, versionOf, type InstallInfo } from "../adapters/support.ts";
import { hashFile } from "../core/hash.ts";
import { privateRoot, repoRoot } from "../core/paths.ts";
import { MEASURED_ADES } from "../control/real.ts";
import type { Pin, PinsFile } from "./doctor.ts";
import { readPins } from "./doctor.ts";
import type { OpsRunner } from "./runner.ts";
import { defaultOpsRunner } from "./runner.ts";

const RUN_USER = "ademark";
const PROFILE_DIR = join(repoRoot, "bench", "adapters", "profiles");
const GATE_DIR = join(repoRoot, "bench", "adapters", "gates");

function teamIdOf(runner: OpsRunner, appPath: string): string | null {
  const result = runner.run(["codesign", "-dv", "--verbose=2", appPath]);
  const text = `${result.stderr}\n${result.stdout}`;
  return text.match(/TeamIdentifier=(\S+)/)?.[1] ?? null;
}

// The pin of one .app bundle: Info.plist version and id, the executable SHA-256 the gates compare, the team id.
export function appPinAt(appPath: string, runner: OpsRunner): Pin | null {
  const info = readBundleInfo(appPath);
  if (info === null) return null;
  const pin: Pin = {};
  if (info.version !== null) pin.version = info.version;
  if (info.bundleId !== null) pin.bundle_id = info.bundleId;
  if (info.executable !== null && existsSync(info.executable)) pin.binary_sha256 = hashFile(info.executable);
  const team = teamIdOf(runner, appPath);
  if (team !== null) (pin as Record<string, unknown>).team_id = team;
  return pin;
}

export type CliResolve = (command: string) => { version: string | null; path: string | null };

// claude, codex and ghostty are command line tools or helpers, not field apps: the pin is the `--version` string
// doctor compares. codex is recorded only when installed; the bench measures Claude only, so it is never required.
export function cliPin(name: string, runner: OpsRunner, resolve: CliResolve = versionOf): Pin | null {
  const result = runner.run([name, "--version"]);
  const version = result.code === 0 ? parseVersionOutput(result.stdout) : null;
  const found = resolve(name);
  const pinned = version ?? found.version;
  if (pinned === null) return null;
  const pin: Pin = { version: pinned };
  if (found.path !== null && existsSync(found.path)) pin.binary_sha256 = hashFile(found.path);
  return pin;
}

function samePin(a: Pin | undefined, b: Pin | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface CollectedPins {
  file: PinsFile;
  lines: string[];
}

export interface CollectDeps {
  install?: (id: string) => Promise<InstallInfo>;
  ghosttyPath?: string;
  cliResolve?: CliResolve;
}

// Reads every measured app plus claude, codex (when installed) and Ghostty. Old entries that differ move under
// "replaced".
export async function collectPins(runner: OpsRunner = defaultOpsRunner, privateRootPath: string = privateRoot(), deps: CollectDeps = {}): Promise<CollectedPins> {
  const installOf = deps.install ?? ((id: string) => getAdapter(id).installCheck());
  const cliResolve = deps.cliResolve ?? versionOf;
  const old = readPins(runner, privateRootPath);
  const apps: Record<string, Pin> = {};
  const clis: Record<string, Pin> = {};
  const lines: string[] = [];
  const note = (section: string, id: string, pin: Pin | null): void => {
    if (pin === null) {
      lines.push(`${section}.${id}: not installed, skipped`);
      return;
    }
    const before = old?.[section as "apps" | "clis" | "agents"]?.[id];
    const target = section === "apps" ? apps : section === "clis" ? clis : null;
    if (target !== null) target[id] = pin;
    const was = before?.version ?? "none";
    const now = pin.version ?? "none";
    lines.push(`${section}.${id}: ${was} -> ${now}${samePin(before, pin) ? " (unchanged)" : ""}`);
  };

  for (const id of MEASURED_ADES) {
    // bare-cli is the control, not an app; codex-app runs only OpenAI models and is not measured.
    if (id === "bare-cli" || id === "codex-app") continue;
    const install = await installOf(id);
    if (!install.installed || install.path === null) {
      note("apps", id, null);
      continue;
    }
    note("apps", id, appPinAt(install.path, runner));
  }
  const ghosttyPath = deps.ghosttyPath ?? appPathFor("Ghostty");
  note("apps", "ghostty", existsSync(ghosttyPath) ? appPinAt(ghosttyPath, runner) : null);
  note("clis", "claude", cliPin("claude", runner, cliResolve));
  note("clis", "codex", cliPin("codex", runner, cliResolve));

  const file: PinsFile = {
    apps,
    clis,
    agents: old?.agents ?? {},
    replaced: {},
  };
  const replaced = file.replaced as Record<string, Record<string, Pin>>;
  for (const section of ["apps", "clis"] as const) {
    const fresh = section === "apps" ? apps : clis;
    const before = old?.[section] ?? {};
    for (const [id, pin] of Object.entries(before)) {
      if (!samePin(pin, fresh[id])) {
        replaced[section] = replaced[section] ?? {};
        replaced[section][id] = pin;
        if (fresh[id] === undefined) lines.push(`${section}.${id}: ${pin.version ?? "?"} -> removed`);
      }
    }
  }
  if (Object.keys(replaced).length === 0) delete file.replaced;
  return { file, lines };
}

export function pinsPath(privateRootPath: string): string {
  return join(privateRootPath, "pins", "versions.json");
}

export async function recordPinsCommand(o: {
  apply: boolean;
  runner?: OpsRunner;
  privateRootPath?: string;
  deps?: CollectDeps;
}): Promise<{ code: number; text: string }> {
  const runner = o.runner ?? defaultOpsRunner;
  const root = o.privateRootPath ?? privateRoot();
  const { file, lines } = await collectPins(runner, root, o.deps);
  const path = pinsPath(root);
  if (!o.apply) {
    return {
      code: 0,
      text: [...lines, ``, `dry run: ${path}`, `pass --apply as ${RUN_USER} to write it`].join("\n"),
    };
  }
  if (runner.username() !== RUN_USER) {
    return {
      code: 2,
      text: `pins record: refusing to write as "${runner.username()}": pins are written only as the dedicated "${RUN_USER}" macOS user.`,
    };
  }
  runner.writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return { code: 0, text: [...lines, ``, `wrote ${path}`].join("\n") };
}

export interface ProfilePinStatus {
  id: string;
  kind: "profile" | "gate";
  pinnedVersion: string | null;
  pinnedSha: string | null;
  installedVersion: string | null;
  installedSha: string | null;
  differs: boolean;
}

export type InstalledLookup = (appPath: string) => Promise<InstallInfo>;

// checkApp's first argument is the display name; the path is the second. Same computation the gates use.
const realInstalled: InstalledLookup = (appPath) => checkApp("app", appPath);

// Every profile's app.version and app.bundleSha256, and every code adapter's gate version and bundleSha256,
// against the installed app.
export async function profilesStatus(o: {
  profilesDir?: string;
  gatesDir?: string;
  installed?: InstalledLookup;
} = {}): Promise<ProfilePinStatus[]> {
  const profilesDir = o.profilesDir ?? PROFILE_DIR;
  const gatesDir = o.gatesDir ?? GATE_DIR;
  const installed = o.installed ?? realInstalled;
  const statuses: ProfilePinStatus[] = [];
  const profileIds = new Set<string>();
  for (const file of readdirSync(profilesDir).filter((name) => name.endsWith(".json")).sort()) {
    const id = file.slice(0, -".json".length);
    // codex-app runs only OpenAI models and is not measured.
    if (id === "codex-app") continue;
    profileIds.add(id);
    const profile = JSON.parse(readFileSync(join(profilesDir, file), "utf8")) as { app?: { path?: string; version?: string; bundleSha256?: string | null } };
    const appPath = profile.app?.path;
    if (typeof appPath !== "string") continue;
    const info = await installed(appPath);
    const pinnedSha = profile.app?.bundleSha256 ?? null;
    statuses.push({
      id,
      kind: "profile",
      pinnedVersion: profile.app?.version ?? null,
      pinnedSha,
      installedVersion: info.installed ? info.version : null,
      installedSha: info.binarySha256,
      differs: !info.installed || info.version !== profile.app?.version || (pinnedSha !== null && info.binarySha256 !== pinnedSha),
    });
  }
  for (const id of MEASURED_ADES) {
    if (id === "bare-cli" || profileIds.has(id)) continue;
    const gatePath = join(gatesDir, `${id}.json`);
    if (!existsSync(gatePath)) continue;
    const gate = JSON.parse(readFileSync(gatePath, "utf8")) as { version?: string; bundleSha256?: string };
    const info = await getAdapter(id).installCheck();
    statuses.push({
      id,
      kind: "gate",
      pinnedVersion: gate.version ?? null,
      pinnedSha: gate.bundleSha256 ?? null,
      installedVersion: info.installed ? info.version : null,
      installedSha: info.binarySha256,
      differs: !info.installed || info.version !== gate.version || info.binarySha256 !== gate.bundleSha256,
    });
  }
  return statuses;
}

export function formatProfileStatus(statuses: readonly ProfilePinStatus[]): string {
  return statuses
    .map((s) => {
      const mark = s.differs ? "DIFFERS" : "match";
      const installed = s.installedVersion === null ? "not installed" : `${s.installedVersion} ${s.installedSha?.slice(0, 12) ?? ""}`;
      const pinned = `${s.pinnedVersion ?? "?"} ${s.pinnedSha?.slice(0, 12) ?? ""}`;
      return `${s.id.padEnd(20)} ${s.kind.padEnd(8)} ${mark.padEnd(8)} pinned ${pinned} | installed ${installed}`;
    })
    .join("\n");
}

// --write updates app.version and app.bundleSha256 in profiles/*.json only. Gate files belong to calibrate gate.
export async function writeProfiles(o: {
  profilesDir?: string;
  installed?: InstalledLookup;
  write: (path: string, text: string) => void;
}): Promise<{ code: number; text: string }> {
  const profilesDir = o.profilesDir ?? PROFILE_DIR;
  const installed = o.installed ?? realInstalled;
  const lines: string[] = [];
  for (const file of readdirSync(profilesDir).filter((name) => name.endsWith(".json")).sort()) {
    if (file === "codex-app.json") continue;
    const path = join(profilesDir, file);
    const profile = JSON.parse(readFileSync(path, "utf8")) as {
      app?: { path?: string; version?: string; bundleSha256?: string | null };
    };
    const appPath = profile.app?.path;
    if (typeof appPath !== "string" || profile.app === undefined) continue;
    const info = await installed(appPath);
    if (!info.installed) {
      lines.push(`${file}: app not installed, skipped`);
      continue;
    }
    const before = `${profile.app.version} ${profile.app.bundleSha256?.slice(0, 12) ?? ""}`;
    profile.app.version = info.version ?? profile.app.version;
    if (info.binarySha256 !== null) profile.app.bundleSha256 = info.binarySha256;
    const after = `${profile.app.version} ${profile.app.bundleSha256?.slice(0, 12) ?? ""}`;
    if (before !== after) {
      o.write(path, `${JSON.stringify(profile, null, 2)}\n`);
      lines.push(`${file}: ${before} -> ${after}`);
    } else {
      lines.push(`${file}: unchanged (${after})`);
    }
  }
  return { code: 0, text: lines.join("\n") };
}
