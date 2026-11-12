// Shared adapter helpers: bundle version and binary hash for installCheck(), plus the "not calibrated" stub.
// Adapters drive an ADE and never measure (TESTS.md 1.7).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AdapterContext, InstallInfo, NativeProc, ProcessHints } from "../core/contracts.ts";
import { hashFile } from "../core/hash.ts";
import { repoRoot } from "../core/paths.ts";
import { AGENT_EXECUTABLES } from "../core/agents.ts";

export interface BundleInfo {
  path: string;
  version: string | null;
  bundleId: string | null;
  executable: string | null;
}

export function appPathFor(appName: string): string {
  return `/Applications/${appName}.app`;
}

// plutil converts both XML and binary plists to JSON and never writes anything.
export function readBundleInfo(appPath: string): BundleInfo | null {
  const plist = `${appPath}/Contents/Info.plist`;
  if (!existsSync(plist)) return null;
  const result = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plist], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  const info = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  const executable = typeof info.CFBundleExecutable === "string" ? info.CFBundleExecutable : null;
  return {
    path: appPath,
    version: typeof info.CFBundleShortVersionString === "string" ? info.CFBundleShortVersionString : null,
    bundleId: typeof info.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : null,
    executable: executable === null ? null : `${appPath}/Contents/MacOS/${executable}`,
  };
}

export function notInstalled(path: string | null = null): InstallInfo {
  return { installed: false, version: null, path, binarySha256: null };
}

export async function checkApp(appName: string, appPath: string = appPathFor(appName)): Promise<InstallInfo> {
  const info = readBundleInfo(appPath);
  if (info === null) return notInstalled(appPath);
  const sha = info.executable !== null && existsSync(info.executable) ? hashFile(info.executable) : null;
  return { installed: true, version: info.version, path: info.path, binarySha256: sha };
}

// "2.1.303 (Claude Code)" -> "2.1.303"; "codex-cli 0.163.0" -> "0.163.0".
export function parseVersionOutput(output: string): string | null {
  const match = output.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

export function versionOf(command: string): { version: string | null; path: string | null } {
  const binary = Bun.which(command);
  if (binary === null) return { version: null, path: null };
  const result = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return { version: null, path: binary };
  return { version: parseVersionOutput(result.stdout.toString()), path: binary };
}

// The Bare CLI control: Claude Code, Codex and Ghostty (ADES.md 3.0).
export async function checkBareCli(): Promise<InstallInfo> {
  const claude = versionOf("claude");
  const codex = versionOf("codex");
  const ghostty = await checkApp("Ghostty");
  const installed = claude.version !== null && codex.version !== null && ghostty.installed;
  const parts = [
    claude.version === null ? null : `claude ${claude.version}`,
    codex.version === null ? null : `codex ${codex.version}`,
    ghostty.version === null ? null : `ghostty ${ghostty.version}`,
  ].filter((part): part is string => part !== null);
  return {
    installed,
    version: parts.length > 0 ? parts.join(", ") : null,
    path: claude.path,
    binarySha256: claude.path !== null ? hashFile(claude.path) : null,
  };
}

// Attribution hints from the ADE's section in ADES.md. Team IDs are not published there, so they stay null.
export function processHints(partial: Partial<ProcessHints>): ProcessHints {
  return {
    bundlePaths: partial.bundlePaths ?? [],
    vendorDirs: partial.vendorDirs ?? [],
    launchAgentLabels: partial.launchAgentLabels ?? [],
    teamId: partial.teamId ?? null,
    agentExecutables: partial.agentExecutables ?? [...AGENT_EXECUTABLES],
  };
}

export function notCalibrated(method: string): (...args: never[]) => Promise<never> {
  return async () => {
    throw new Error(`not calibrated: ${method}`);
  };
}

// ---------- Dry run, plan lines and the missing-value rule (AGENT_GUIDE.md) ----------

// One shape for every plan line: `plan: <action> <args>` (ADES.md 1.1, adapter brief).
export function planMessage(action: string, args: readonly string[] = []): string {
  return ["plan:", action, ...args].join(" ");
}

// ADES.md marks a fact we do not have as "find in pilot". Dry run says so and continues; real mode refuses.
// The placeholder is only for a caller that wants to show the gap inside a planned command.
export function missingValue(ctx: AdapterContext, field: string, wording: string, placeholder = ""): string {
  if (ctx.dryRun) {
    ctx.log(`plan: MISSING ${field} (${wording})`);
    return placeholder;
  }
  throw new Error(`not calibrated: ${field}`);
}

// RUNBOOK.md 4.12: the clean snapshot of ~/.claude, ~/.codex and ~/.agents that reset() restores.
export function cleanSnapshotDir(): string {
  return process.env.ADEMARK_SNAPSHOT ?? resolve(repoRoot, "snapshots", "clean");
}

// A kill list must never carry the harness's own parent chain: the owner's shell, an agent that started
// this run, or anything above it (ADES.md 3.0 reset).
export function ancestorPids(procs: readonly NativeProc[], root: number = process.pid): Set<number> {
  const parents = new Map(procs.map((proc) => [proc.pid, proc.ppid]));
  const out = new Set<number>();
  let current = parents.get(root);
  for (let depth = 0; depth < 64 && current !== undefined && current > 1; depth++) {
    out.add(current);
    current = parents.get(current);
  }
  return out;
}

export function withoutAncestors(procs: readonly NativeProc[], root: number = process.pid): NativeProc[] {
  const skip = ancestorPids(procs, root);
  return procs.filter((proc) => proc.pid !== root && !skip.has(proc.pid));
}
