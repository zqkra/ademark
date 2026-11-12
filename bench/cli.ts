#!/usr/bin/env bun
// The only entry point of the ADEMark harness (TESTS.md 1.1).
// Track runners (A1-C6) arrive in the next phase; the run core of `ademark run` is in bench/run/.
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { ADAPTER_IDS, getAdapter, listAdapters } from "./adapters/registry.ts";
import { checkAdapter, formatCheck, loadAdapterModule } from "./adapters/check.ts";
import { checkProfile, isProfileAdapter } from "./adapters/profile.ts";
import { ADAPTER_ID, scaffoldAdapter } from "./adapters/new.ts";
import { GATE_RUNS, calibrateGate } from "./calibrate/gate.ts";
import { checkGates } from "./core/gates.ts";
import { UNTIL_TIME } from "./night/plan.ts";
import { collectManifest, writeManifest } from "./core/manifest.ts";
import { checkAccount, formatAccountTable, setupAccount } from "./ops/account.ts";
import { formatDoctorTable, runDoctor } from "./ops/doctor.ts";
import { machineCommand } from "./ops/machine.ts";
import { repoRoot, resultsRoot } from "./core/paths.ts";
import { shuffle } from "./core/order.ts";
import { summarizeRun, formatSummary } from "./core/summarize.ts";
import { diff, restore, save } from "./core/snapshot.ts";
import type { SnapshotOp } from "./core/snapshot.ts";
import { cutNetwork } from "./fault/cut-network.ts";
import { killAgent } from "./fault/kill-agent.ts";
import { restartApp } from "./fault/restart-app.ts";
import { RunWriter } from "./core/results.ts";
import type { Agent } from "./core/contracts.ts";
import { dryInstruments } from "./run/dry.ts";
import { runAll, TRACKS } from "./run/loop.ts";
import { realInstruments } from "./run/real.ts";
import { loadRunners, type TrackLetter } from "./run/registry.ts";
import { parseSmokeRepeats } from "./run/smoke.ts";

process.env.ADEMARK_HARNESS_PID ??= String(process.pid);

const HELP = `ademark: the ADEMark harness

Usage:
  ademark order --seed <s>
  ademark gates
  ademark manifest --run-id <id> [--seed <s>] [--reference] [--out <dir>]
  ademark snapshot save|restore|diff --dir <d> [--apply]
  ademark adapter list
  ademark adapter new <id>
  ademark adapter check <id>
  ademark adapter install-check [<id>]
  ademark profile check <id|all>
  ademark calibrate probe --ade <id> [--json]
  ademark calibrate gate --ade <id> [--runs 5] [--agent claude,codex,own] [--scratch] [--dry-run]
  ademark fault kill-agent --worktree <path> [--agent-exe <name>]... [--apply]
  ademark fault cut-network [--duration-s <n>] [--apply]
  ademark fault restart-app --app <name> [--bundle-id <id>] [--apply]
  ademark machine on|off|status [--apply]
  ademark account check|setup [--apply]
  ademark doctor [--agent claude,codex,own] [--json]
  ademark night [--tracks A] [--agent claude,codex,own] [--ungated] [--skip <id,...>] [--smoke] [--seed <s>] [--until HH:MM] [--no-repair] [--repair-minutes <n>] [--yes] [--dry-run]
  ademark summarize --run <dir>
  ademark settle [--minutes 5]
  ademark control [--port 7788] [--ade <id,...>] [--no-open] [--dry-run] [--continue]
  ademark qa --run <run id> [--ade <id,...>] [--out <dir>] [--dry-run]
  ademark report --run <run id> [--ade <id,...>] [--out <dir>]
  ademark build-id --ade <id>
  ademark watchdog --once [--dry-run] [--heartbeat-limit <s>] | install | uninstall | status
  ademark prepare [--tracks A,B] [--agent claude,own] [--ade <id,...>] [--skip <id,...>] [--rounds 3] [--dry-run]
  ademark run --ade <id|all> [--tracks A,B,C] [--agent claude,codex] [--dry-run] [--smoke] [--reference] [--run-id <id>] [--seed <s>] [--runners <dir>] [--tests A3,A11] [--smoke-reps A1=3,A2=3] [--resume]

A real run is only allowed as the dedicated "ademark" macOS user; --dry-run works for anyone and writes
results/<run-id>-dry/. --smoke runs one repetition per test with short windows, is only allowed with --tracks A,
writes results/<run-id>-smoke/ and is never published. --reference marks manifest.verified and cannot be combined
with --dry-run.
Faults and snapshot restore are dry runs unless --apply is given, and --apply only works as the ademark user.
machine and account are dry runs too; doctor changes nothing and exits 1 when a blocking check fails.
A calibration gate is --runs smoke runs of one ADE in a row. A real gate is only allowed as the ademark user and
refuses to record a pass on an uncommitted tree; --dry-run writes the gate file to a temp folder.
qa runs the QA check by day on the finished folders of a Control night, at most 4 at once, from any account
(ADEMARK_RESULTS points at the results folder). It writes qa.txt and qa-verdict.json beside the rows, or under --out.
--dry-run lists the folders and starts no reviewer. A verdict never starts a measurement: report puts it in
results/<run id>/report.md, which refuses a rehearsal. build-id prints the machine id and the app's build hash.
ademark night is one night for every ADE whose calibration gate is ok: machine on, doctor, a smoke rehearsal, the run
and machine off, with results/<run-id>/night.md at the end. A real night is only allowed as the ademark user;
--dry-run writes results/<run-id>-dry/ and plans the machine step.
`;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const AGENTS: readonly Agent[] = ["claude", "codex", "own"];

function agentsFlag(args: readonly string[], command: string): readonly Agent[] | undefined | null {
  const list = flag(args, "--agent");
  if (list === undefined) return undefined;
  const agents = list.split(",").map((name) => name.trim());
  if (agents.every((name): name is Agent => (AGENTS as readonly string[]).includes(name))) return agents;
  console.error(`${command}: --agent must be a comma-separated subset of ${AGENTS.join(",")}`);
  return null;
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function repeatableFlag(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) values.push(args[i + 1]!);
  }
  return values;
}

function unknown(command: string): never {
  console.error(`unknown command: ${command}\n`);
  console.error(HELP);
  process.exit(2);
  throw new Error("process.exit returned");
}

function formatOps(ops: readonly SnapshotOp[]): string {
  if (ops.length === 0) return "no changes";
  return ops
    .map((op) => (op.action === "copy" ? `copy     ${op.source} -> ${op.target}` : `${op.action.padEnd(8)} ${op.target}`))
    .join("\n");
}

function cmdOrder(args: string[]): number {
  const seed = flag(args, "--seed");
  if (!seed) {
    console.error("order: --seed <s> is required");
    return 2;
  }
  console.log(JSON.stringify({ seed, order: shuffle(ADAPTER_IDS, seed) }, null, 2));
  return 0;
}

function cmdGates(): number {
  console.log(JSON.stringify(checkGates({ quietWaitMs: 0 }), null, 2));
  return 0;
}

async function cmdManifest(args: string[]): Promise<number> {
  const runId = flag(args, "--run-id");
  if (!runId) {
    console.error("manifest: --run-id <id> is required");
    return 2;
  }
  const seed = flag(args, "--seed") ?? runId;
  const manifest = await collectManifest({ runId, orderSeed: seed, reference: has(args, "--reference") });
  const path = writeManifest(flag(args, "--out") ?? resolve(resultsRoot(), runId), manifest);
  console.error(`wrote ${path}`);
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}

function cmdSnapshot(args: string[]): number {
  const action = args[0];
  const dir = flag(args, "--dir");
  if (!action || !["save", "restore", "diff"].includes(action)) {
    console.error("snapshot: expected save|restore|diff");
    return 2;
  }
  if (!dir) {
    console.error("snapshot: --dir <d> is required");
    return 2;
  }
  const apply = has(args, "--apply");
  try {
    if (action === "save") {
      const ops = save(dir, undefined, { apply });
      console.log(`${apply ? "applied" : "dry run, would apply"} ${ops.length} operation(s):`);
      console.log(formatOps(ops));
    } else if (action === "restore") {
      const ops = restore(dir, undefined, { apply });
      console.log(`${apply ? "applied" : "dry run, would apply"} ${ops.length} operation(s):`);
      console.log(formatOps(ops));
    } else {
      const entries = diff(dir);
      if (entries.length === 0) console.log(`no differences against ${resolve(dir)}`);
      else {
        const limit = 40;
        console.log(entries.slice(0, limit).map((entry) => `${entry.status.padEnd(8)} ${entry.path}`).join("\n"));
        if (entries.length > limit) console.log(`... ${entries.length - limit} more (${entries.length} total)`);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function cmdAdapter(args: string[]): Promise<number> {
  const action = args[0];
  if (action === "list") {
    for (const adapter of listAdapters()) {
      console.log(`${adapter.id.padEnd(20)} ${adapter.family.padEnd(8)} ${adapter.name}`);
    }
    return 0;
  }
  if (action === "new") {
    const id = args[1];
    if (!id) {
      console.error("adapter new: <id> is required");
      return 2;
    }
    try {
      const result = scaffoldAdapter(id);
      console.log(`created ${result.adapterPath}`);
      console.log(`created ${result.briefPath}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (action === "check") {
    const id = args[1];
    if (!id) {
      console.error("adapter check: <id> is required");
      return 2;
    }
    return await adapterCheck(id);
  }
  if (action === "install-check") {
    return await installCheck(args[1]);
  }
  console.error("adapter: expected list|new|check|install-check");
  return 2;
}

async function cmdProfile(args: string[]): Promise<number> {
  const action = args[0];
  if (action !== "check") {
    console.error("profile: expected check");
    return 2;
  }
  const target = args[1];
  if (!target) {
    console.error("profile check: <id|all> is required");
    return 2;
  }
  const ids = target === "all" ? ADAPTER_IDS : [target];
  for (const id of ids) {
    if (!ADAPTER_IDS.includes(id)) {
      console.error(`unknown adapter "${id}"; known: ${ADAPTER_IDS.join(", ")}`);
      return 2;
    }
  }
  let invalid = 0;
  for (const id of ids) {
    const adapter = getAdapter(id);
    if (!isProfileAdapter(adapter)) {
      console.log(`${id.padEnd(20)} code adapter`);
      continue;
    }
    const check = checkProfile(id, adapter.agents);
    console.log(`${id.padEnd(20)} ${check.status}`);
    for (const error of check.errors) console.log(`  ${error}`);
    if (check.status === "invalid") invalid += 1;
  }
  return invalid > 0 ? 1 : 0;
}

async function cmdCalibrate(args: string[]): Promise<number> {
  const action = args[0];
  if (action === "gate") return await cmdCalibrateGate(args);
  if (action !== "probe") {
    console.error("calibrate: expected probe|gate");
    return 2;
  }
  const id = flag(args, "--ade");
  if (!id) {
    console.error("calibrate probe: --ade <id> is required");
    return 2;
  }
  if (!ADAPTER_IDS.includes(id)) {
    console.error(`unknown adapter "${id}"; known: ${ADAPTER_IDS.join(", ")}`);
    return 2;
  }
  try {
    const { probeAdapter, formatProbe } = await import("./calibrate/probe.ts");
    const result = probeAdapter(getAdapter(id));
    console.log(has(args, "--json") ? JSON.stringify(result, null, 2) : formatProbe(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function cmdCalibrateGate(args: string[]): Promise<number> {
  const id = flag(args, "--ade");
  if (!id) {
    console.error("calibrate gate: --ade <id> is required");
    return 2;
  }
  if (!ADAPTER_IDS.includes(id)) {
    console.error(`unknown adapter "${id}"; known: ${ADAPTER_IDS.join(", ")}`);
    return 2;
  }
  const runsFlag = flag(args, "--runs");
  const runs = runsFlag === undefined ? GATE_RUNS : Number(runsFlag);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error("calibrate gate: --runs must be a positive integer");
    return 2;
  }
  const agents = agentsFlag(args, "calibrate gate");
  if (agents === null) return 2;
  try {
    const outcome = await calibrateGate({ ade: id, runs, dryRun: has(args, "--dry-run"), scratch: has(args, "--scratch"), agents });
    return outcome.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function adapterCheck(id: string): Promise<number> {
  if (!ADAPTER_ID.test(id)) {
    console.error(`invalid adapter id "${id}"`);
    return 2;
  }
  try {
    const adapter = ADAPTER_IDS.includes(id) ? getAdapter(id) : await loadAdapterModule(id);
    const result = await checkAdapter(id, adapter);
    console.log(formatCheck(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function installCheck(only?: string): Promise<number> {
  const ids = only ? [only] : ADAPTER_IDS;
  for (const id of ids) {
    if (!ADAPTER_IDS.includes(id)) {
      console.error(`unknown adapter "${id}"; known: ${ADAPTER_IDS.join(", ")}`);
      return 2;
    }
  }
  const rows: Array<[string, string, string, string]> = [["id", "installed", "version", "path"]];
  for (const id of ids) {
    const info = await getAdapter(id).installCheck();
    rows.push([id, info.installed ? "yes" : "no", info.version ?? "-", info.path ?? "-"]);
  }
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
  }
  return 0;
}

async function cmdFault(args: string[]): Promise<number> {
  const action = args[0];
  try {
    if (action === "kill-agent") {
      const worktree = flag(args, "--worktree");
      if (!worktree) {
        console.error("fault kill-agent: --worktree <path> is required");
        return 2;
      }
      const executables = repeatableFlag(args, "--agent-exe");
      const result = killAgent({
        worktree,
        apply: has(args, "--apply"),
        agentExecutables: executables.length > 0 ? executables : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (action === "cut-network") {
      const duration = flag(args, "--duration-s");
      const result = await cutNetwork({
        apply: has(args, "--apply"),
        durationS: duration === undefined ? undefined : Number(duration),
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (action === "restart-app") {
      const app = flag(args, "--app");
      if (!app) {
        console.error("fault restart-app: --app <name> is required");
        return 2;
      }
      const result = await restartApp({
        appName: app,
        bundleId: flag(args, "--bundle-id"),
        apply: has(args, "--apply"),
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.error("fault: expected kill-agent|cut-network|restart-app");
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function cmdMachine(args: string[]): number {
  const action = args[0];
  if (action !== "on" && action !== "off" && action !== "status") {
    console.error("machine: expected on|off|status");
    return 2;
  }
  try {
    machineCommand(action, { apply: has(args, "--apply") });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function cmdAccount(args: string[]): number {
  const action = args[0];
  if (action !== "check" && action !== "setup") {
    console.error("account: expected check|setup");
    return 2;
  }
  try {
    const items = action === "check" ? checkAccount() : setupAccount({ apply: has(args, "--apply") });
    console.log(formatAccountTable(items));
    return items.some((entry) => entry.status === "missing" || entry.status === "differs") ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function cmdDoctor(args: string[]): Promise<number> {
  const agents = agentsFlag(args, "doctor");
  if (agents === null) return 2;
  try {
    const { results, exitCode } = await runDoctor({ agents });
    console.log(has(args, "--json") ? JSON.stringify(results, null, 2) : formatDoctorTable(results));
    return exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function cmdSummarize(args: string[]): number {
  const run = flag(args, "--run");
  if (!run) {
    console.error("summarize: --run <dir> is required");
    return 2;
  }
  try {
    const { path, summary } = summarizeRun(run);
    console.log(formatSummary(summary));
    console.log(`wrote ${path}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const RUN_USER = "ademark";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function gitShortHead(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "0000000";
}

function defaultRunId(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  return `${date}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}Z-${gitShortHead()}`;
}

function parseTracks(raw: string | undefined): TrackLetter[] | null {
  if (raw === undefined) return [...TRACKS];
  const tracks: TrackLetter[] = [];
  for (const part of raw.split(",")) {
    const track = part.trim().toUpperCase();
    if (track !== "A" && track !== "B" && track !== "C") return null;
    if (!tracks.includes(track)) tracks.push(track);
  }
  return tracks.length === 0 ? null : tracks;
}

function parseNightTracks(raw: string | undefined): TrackLetter[] | null {
  if (raw === undefined) return ["A"];
  const tracks: TrackLetter[] = [];
  for (const part of raw.split(",")) {
    const track = part.trim().toUpperCase();
    if (track !== "A" && track !== "B" && track !== "C") return null;
    if (!tracks.includes(track)) tracks.push(track);
  }
  return tracks.length === 0 ? null : tracks;
}

// `ademark settle`: waits for a quiet CPU, up to --minutes. It always ends in 0: the block's own gate has the last word.
function cmdSettle(args: string[]): number {
  const gates = checkGates({ quietWaitMs: Number(flag(args, "--minutes") ?? 5) * 60_000 });
  console.log(`settle: ${gates.cpu_quiet_ok ? "quiet" : "still busy"}, ${gates.cpu_cores_used} cores`);
  return 0;
}

// `ademark control`: the panel with one Start button. It stays up until Ctrl-C. Only one may run: on 2026-11-09 a
// second click started a second Ghostty, and Bare CLI's reset killed both. A second start opens the first panel.
// `--continue` goes on with the open run with no click, which is how the watchdog brings Control back.
async function cmdControl(args: string[]): Promise<number> {
  const dry = has(args, "--dry-run");
  if (!dry && userInfo().username !== RUN_USER) {
    console.error(`control: a real run only works in the "${RUN_USER}" account. Use --dry-run to see the panel.`);
    return 2;
  }
  const { startControl } = await import("./control/server.ts");
  const { controlFiles, releaseLock, takeLock, updateLock } = await import("./control/files.ts");
  const port = Number(flag(args, "--port") ?? 7788);
  const ades = flag(args, "--ade")?.split(",").map((id) => id.trim());
  const open = (url: string): void => {
    if (!has(args, "--no-open")) Bun.spawnSync(["open", url], { timeout: 10_000 });
  };
  const { mkdirSync } = await import("node:fs");
  mkdirSync(resultsRoot(), { recursive: true });
  const lockPath = controlFiles(dry).lock;
  const mine = { pid: process.pid, port, started_at: new Date().toISOString() };
  const taken = takeLock(lockPath, mine);
  if (!taken.ok) {
    const url = `http://127.0.0.1:${taken.holder.port}`;
    console.log(`ADEMark Control already runs (pid ${taken.holder.pid}, since ${taken.holder.started_at}): ${url}`);
    open(url);
    return 0;
  }
  let control: ReturnType<typeof startControl>;
  try {
    control = startControl({ port, dry, ades });
  } catch (error) {
    releaseLock(lockPath);
    throw error;
  }
  updateLock(lockPath, { ...mine, port: Number(new URL(control.url).port) });
  console.log(`ADEMark Control: ${control.url}`);
  open(control.url);
  if (has(args, "--continue")) control.continueRun();
  await new Promise<void>((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
  await control.stop();
  releaseLock(lockPath);
  return 0;
}

// `ademark watchdog --once | install | uninstall | status` (ADEMARK-36). `--once` is what the LaunchAgent runs every
// 60 s. `--dry-run` watches a dry Control, and `--heartbeat-limit <s>` shortens the 5 minutes for a check by hand.
async function cmdWatchdog(args: string[]): Promise<number> {
  const w = await import("./control/watchdog.ts");
  const dry = has(args, "--dry-run");
  if (has(args, "--once")) {
    const deps = w.realWatchdogDeps(dry);
    const limit = flag(args, "--heartbeat-limit");
    if (limit !== undefined) deps.heartbeatLimitMs = Number(limit) * 1000;
    console.log(`watchdog: ${await w.watchdogPass(deps)}`);
    return 0;
  }
  const action = args.find((arg) => !arg.startsWith("-"));
  try {
    if (action === "install") console.log(`watchdog: ${await w.watchdogInstall()}`);
    else if (action === "uninstall") console.log(`watchdog: ${await w.watchdogUninstall()}`);
    else if (action === "status") console.log(`watchdog: ${(await w.watchdogLoaded()) ? "loaded" : "not loaded"} (${w.plistPath()})`);
    else {
      console.error("watchdog: use --once, install, uninstall or status");
      return 2;
    }
  } catch (error) {
    console.error(`watchdog: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

// `ademark prepare`: proves each ADE on the real app and repairs it, so a night measures only what already works.
async function cmdPrepare(args: string[]): Promise<number> {
  const tracks = parseNightTracks(flag(args, "--tracks") ?? "A,B");
  if (tracks === null) {
    console.error("prepare: --tracks must be a comma-separated subset of A,B,C");
    return 2;
  }
  const agentList = agentsFlag(args, "prepare");
  if (agentList === null) return 2;
  const agents = agentList ?? (["claude", "own"] as const);
  const roundsRaw = flag(args, "--rounds");
  const rounds = roundsRaw === undefined ? undefined : Number(roundsRaw);
  if (rounds !== undefined && !(Number.isInteger(rounds) && rounds > 0)) {
    console.error("prepare: --rounds must be a positive integer");
    return 2;
  }
  const list = (name: string): string[] | undefined =>
    flag(args, name)?.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  const only = list("--ade");
  const skip = list("--skip") ?? [];
  const unknown = [...(only ?? []), ...skip].filter((id) => !ADAPTER_IDS.includes(id));
  if (unknown.length > 0) {
    console.error(`prepare: unknown adapter: ${unknown.join(",")}`);
    return 2;
  }
  const chosen = (only ?? ADAPTER_IDS).filter((id) => {
    const adapter = getAdapter(id);
    return !skip.includes(id) && adapter.agents.some((agent) => agents.includes(agent));
  });
  if (has(args, "--dry-run")) {
    console.log(`prepare: dry run, no app opens and no agent starts`);
    console.log(`prepare: tracks ${tracks.join(",")}, up to ${rounds ?? 3} round(s) per ADE`);
    console.log(`prepare: ${chosen.join(", ")}`);
    return 0;
  }
  const { runPrepare } = await import("./night/prepare-run.ts");
  return await runPrepare({ ades: chosen, tracks, agents, rounds });
}

async function cmdNight(args: string[]): Promise<number> {
  const tracks = parseNightTracks(flag(args, "--tracks"));
  if (tracks === null) {
    console.error("night: --tracks must be a comma-separated subset of A,B,C");
    return 2;
  }
  const until = flag(args, "--until");
  if (until !== undefined && !UNTIL_TIME.test(until)) {
    console.error(`night: --until must be a HH:MM local time, got "${until}"`);
    return 2;
  }
  const agents = agentsFlag(args, "night");
  if (agents === null) return 2;
  const skip = flag(args, "--skip")?.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  const unknown = skip?.filter((id) => !ADAPTER_IDS.includes(id)) ?? [];
  if (unknown.length > 0) {
    console.error(`night: --skip names an unknown adapter: ${unknown.join(",")}`);
    return 2;
  }
  const repairRaw = flag(args, "--repair-minutes");
  const repairMinutes = repairRaw === undefined ? undefined : Number(repairRaw);
  if (repairMinutes !== undefined && !(Number.isFinite(repairMinutes) && repairMinutes > 0)) {
    console.error("night: --repair-minutes must be a positive number");
    return 2;
  }
  try {
    const { runNight } = await import("./night/night.ts");
    const outcome = await runNight({
      tracks,
      seed: flag(args, "--seed"),
      until,
      yes: has(args, "--yes"),
      dryRun: has(args, "--dry-run"),
      agents,
      ungated: has(args, "--ungated"),
      skip,
      smoke: has(args, "--smoke"),
      repair: !has(args, "--no-repair"),
      repairMinutes,
    });
    return outcome.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const ade = flag(args, "--ade");
  if (ade === undefined) {
    console.error("run: --ade <id|all> is required");
    return 2;
  }
  const tracks = parseTracks(flag(args, "--tracks"));
  if (tracks === null) {
    console.error("run: --tracks must be a comma-separated subset of A,B,C");
    return 2;
  }
  const dryRun = has(args, "--dry-run");
  const smoke = has(args, "--smoke");
  const reference = has(args, "--reference");
  if (reference && dryRun) {
    console.error("run: --reference cannot be combined with --dry-run");
    return 2;
  }
  // Track B calls the real API and Track C is long: a rehearsal measures Track A only.
  if (smoke && !(tracks.length === 1 && tracks[0] === "A")) {
    console.error("run: --smoke is only allowed with --tracks A");
    return 2;
  }
  const smokeRepsText = flag(args, "--smoke-reps");
  const smokeRepeats = smokeRepsText === undefined ? undefined : parseSmokeRepeats(smokeRepsText);
  if (smokeRepeats === null || (smokeRepeats !== undefined && !smoke)) {
    console.error("run: --smoke-reps needs --smoke and a list like A1=3,A2=3 (counts from 1 to 20)");
    return 2;
  }
  const username = userInfo().username;
  if (!dryRun && username !== RUN_USER) {
    console.error(
      `run: refusing to measure as "${username}": a real run is only allowed as the dedicated "${RUN_USER}" ` +
        `macOS user (METHODOLOGY.md §5). Use --dry-run to exercise the loop without measuring.`,
    );
    return 2;
  }

  const baseRunId = flag(args, "--run-id") ?? defaultRunId();
  const suffix = `${dryRun ? "-dry" : ""}${smoke ? "-smoke" : ""}`;
  const runId = `${baseRunId}${suffix}`;
  if (!RUN_ID.test(runId)) {
    console.error(`run: invalid run id "${runId}"`);
    return 2;
  }
  const seed = flag(args, "--seed") ?? baseRunId;
  const ades = ade === "all" ? [...ADAPTER_IDS] : [ade];
  const agents = agentsFlag(args, "run");
  if (agents === null) return 2;

  try {
    for (const id of ades) getAdapter(id);
    const allRunners = await loadRunners(flag(args, "--runners"));
    // --tests reruns only some tests of a block (a pilot fix), with the block's own setup.
    const only = flag(args, "--tests")?.split(",").map((name) => name.trim());
    const runners = only === undefined ? allRunners : new Map([...allRunners].filter(([id]) => only.includes(id)));
    if (only !== undefined && runners.size !== only.length) {
      console.error(`run: --tests names an unknown test: ${only.filter((id) => !allRunners.has(id as never)).join(",")}`);
      return 2;
    }
    const writer = new RunWriter(resultsRoot()).open(runId);
    const instruments = dryRun
      ? dryInstruments(resolve(writer.runDir, "plan.jsonl"))
      : realInstruments();
    const result = await runAll({
      ades,
      tracks,
      runId,
      seed,
      instruments,
      runners,
      writer,
      reference,
      agents,
      smoke,
      smokeRepeats,
      resume: has(args, "--resume"),
    });
    console.log(
      `run ${runId}: ${result.rows} rows in ${result.blocks.length} block(s), ` +
        `${result.stopped ? "stopped" : "finished"}`,
    );
    console.log(`wrote ${result.runDir}`);
    return result.stopped ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function adesFlag(args: readonly string[], command: string, all: readonly string[]): string[] | null {
  const list = flag(args, "--ade")?.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  const unknown = (list ?? []).filter((id) => !all.includes(id));
  if (unknown.length > 0) {
    console.error(`${command}: unknown adapter: ${unknown.join(",")}`);
    return null;
  }
  return list ?? [...all];
}

async function cmdQa(args: string[]): Promise<number> {
  const runId = flag(args, "--run");
  if (runId === undefined || !RUN_ID.test(runId)) {
    console.error("qa: --run <run id> is required");
    return 2;
  }
  const { ALL_ADES, runQa } = await import("./control/day.ts");
  const ades = adesFlag(args, "qa", ALL_ADES);
  if (ades === null) return 2;
  try {
    const verdicts = await runQa({ root: resultsRoot(), runId, ades, out: flag(args, "--out"), dryRun: has(args, "--dry-run") });
    return verdicts.every((verdict) => verdict.ok) ? 0 : 1;
  } catch (error) {
    console.error(`qa: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

async function cmdReport(args: string[]): Promise<number> {
  const runId = flag(args, "--run");
  if (runId === undefined || !RUN_ID.test(runId)) {
    console.error("report: --run <run id> is required");
    return 2;
  }
  const { ALL_ADES, writeDayReport } = await import("./control/day.ts");
  const ades = adesFlag(args, "report", ALL_ADES);
  if (ades === null) return 2;
  try {
    console.log(`wrote ${await writeDayReport({ root: resultsRoot(), runId, ades, out: flag(args, "--out") })}`);
    return 0;
  } catch (error) {
    console.error(`report: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

// A top-up compares these with its first attempt (ADEMARK-47). A child of Control, so hashing a bundle never blocks the panel.
async function cmdBuildId(args: string[]): Promise<number> {
  const ade = flag(args, "--ade");
  if (ade === undefined || !ADAPTER_IDS.includes(ade)) {
    console.error("build-id: --ade <id> is required");
    return 2;
  }
  const { defaultMachineId, parseHardware } = await import("./core/manifest.ts");
  const hw = Bun.spawnSync(["sysctl", "-n", "hw.model", "hw.memsize", "machdep.cpu.brand_string"]).stdout.toString().split("\n");
  const info = await getAdapter(ade).installCheck();
  console.log(JSON.stringify({ machine_id: defaultMachineId(parseHardware(hw[0] ?? "", hw[1] ?? "", hw[2] ?? "")), ade_build_sha256: info.binarySha256 }));
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return command === undefined ? 2 : 0;
  }
  switch (command) {
    case "order":
      return cmdOrder(args);
    case "gates":
      return cmdGates();
    case "manifest":
      return cmdManifest(args);
    case "snapshot":
      return cmdSnapshot(args);
    case "adapter":
      return await cmdAdapter(args);
    case "profile":
      return await cmdProfile(args);
    case "calibrate":
      return await cmdCalibrate(args);
    case "fault":
      return cmdFault(args);
    case "machine":
      return cmdMachine(args);
    case "account":
      return cmdAccount(args);
    case "doctor":
      return await cmdDoctor(args);
    case "prepare":
      return await cmdPrepare(args);
    case "control":
      return await cmdControl(args);
    case "settle":
      return cmdSettle(args);
    case "watchdog":
      return await cmdWatchdog(args);
    case "night":
      return await cmdNight(args);
    case "summarize":
      return cmdSummarize(args);
    case "run":
      return await cmdRun(args);
    case "qa":
      return await cmdQa(args);
    case "report":
      return await cmdReport(args);
    case "build-id":
      return await cmdBuildId(args);
    default:
      unknown(command);
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
