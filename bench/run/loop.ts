// The per-ADE loop of RUNBOOK.md §7: gates, install check, config diff, arena, reset, contamination,
// launch, per-agent blocks, seeding (Track A), the sampler (Track C) and a .done marker per block.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootout, killPids, orphanAgentPids, pidsFor, unsetenv } from "../adapters/macos.ts";
import { getAdapter } from "../adapters/registry.ts";
import type {
  Adapter,
  AdapterContext,
  Agent,
  InstallInfo,
  Manifest,
  ResultRow,
  RunOptions,
  TestId,
} from "../core/contracts.ts";
import { collectManifest, writeManifest } from "../core/manifest.ts";
import { shuffle } from "../core/order.ts";
import { benchRoot, repoRoot, resultsRoot } from "../core/paths.ts";
import { RunWriter } from "../core/results.ts";
import { diff } from "../core/snapshot.ts";
import { medianConverged } from "../core/stats.ts";
import { NOT_SUPPORTED } from "../calibrate/pass.ts";
import { summarizeRun } from "../core/summarize.ts";
import { HARNESS_ENV } from "../ops/machine.ts";
import { arenaRef, arenaRoot, contaminationDir, homeDir } from "./arena.ts";
import { createTestContext, sampleRulesFor } from "./context.ts";
import { checkContamination, type ContaminationReference } from "./contamination.ts";
import { repWatch, type RepWatch } from "../agent/watch.ts";
import { DRIFT_KEY } from "./context.ts";
import type { CaptureControl, Instruments, ReplayControl, SampleHandle } from "./instruments.ts";
import { blocksFor, rowAdeFor, singleBlockFor } from "./models.ts";
import { TRACK_ORDER, type TestRunner, type TrackLetter } from "./registry.ts";
import { blockIsDone, blockMarker, freeAttemptFolder, supersedeBlock } from "./retry.ts";
import { SMOKE } from "./smoke.ts";

export const REPLAY_PORT = 8787;
export const SEED_PROMPT = "replay:seed";
export const SEED_THREADS = 5;
export const SEED_TIMEOUT_MS = 120_000;
export const TRACKS: readonly TrackLetter[] = ["A", "B", "C"];
export const SAMPLE_HZ = 4;
/** TESTS.md §1.3: the adaptive stop rule's relative half-width. */
export const ADAPTIVE_REL_TOL = 0.05;

const CA_FILE = ".mitmproxy/mitmproxy-ca-cert.pem";

class BlockStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockStop";
  }
}

export interface BlockResult {
  ade: string;
  track: TrackLetter;
  finished: boolean;
  rows: number;
  error: string | null;
}

export interface RunBlockOptions {
  adapter: Adapter;
  track: TrackLetter;
  rowAde: string;
  runId: string;
  runDir: string;
  machineId: string;
  options: RunOptions;
  instruments: Instruments;
  writer: RunWriter;
  runners: Map<TestId, TestRunner>;
  manifest: Manifest | null;
  home: string;
  arenaRoot: string;
  arenaRef: string;
  contaminationDir: string;
  snapshotDir: string;
  state: Map<string, unknown>;
  previous: { rowAde: string | null };
  reference: ContaminationReference;
  /** A smoke block seeds fewer threads and runs one repetition per test (TESTS.md §1.3). */
  smoke?: boolean;
  /** Smoke repetitions per test id, over the runner's own `smokeRepeats` (the rehearsal's A1-A3, ADEMARK-44). */
  smokeRepeats?: Readonly<Record<string, number>>;
}

export interface RunAdeOptions {
  ade: string;
  tracks: readonly TrackLetter[];
  runId: string;
  runDir: string;
  machineId: string;
  instruments: Instruments;
  writer: RunWriter;
  runners: Map<TestId, TestRunner>;
  manifest?: Manifest | null;
  home?: string;
  arenaRoot?: string;
  arenaRef?: string;
  contaminationDir?: string;
  snapshotDir?: string;
  previous?: { rowAde: string | null };
  reference?: ContaminationReference;
  /** Only these agents' blocks (the pilot runs Claude only while Codex is not signed in). Omitted: every block. */
  agents?: readonly Agent[];
  smoke?: boolean;
  smokeRepeats?: Readonly<Record<string, number>>;
  /** 1 in the retry pass: earlier rows and receipts of a stopped block become attempt 1. */
  retryAttempt?: number;
}

export interface RunAdeResult {
  ade: string;
  runId: string;
  blocks: BlockResult[];
  stopped: boolean;
  rows: number;
}

export interface RunAllOptions {
  ades: readonly string[];
  tracks: readonly TrackLetter[];
  runId: string;
  seed: string;
  instruments: Instruments;
  runners: Map<TestId, TestRunner>;
  writer?: RunWriter;
  home?: string;
  arenaRoot?: string;
  snapshotDir?: string;
  adeVersions?: Manifest["ade_versions"];
  /** TRUE only for a reference-machine or audited re-run: manifest.verified. */
  reference?: boolean;
  agents?: readonly Agent[];
  smoke?: boolean;
  smokeRepeats?: Readonly<Record<string, number>>;
  /** Called between ADEs, when no block runs. */
  betweenAdes?: () => void;
  /** Measure into an existing run folder and keep its manifest (a repaired ADE, bench/night/repair.ts). */
  resume?: boolean;
  /** Epoch ms: before each ADE starts, and before each retry, an ADE past this time is not started. */
  deadline?: number;
}

export interface RunResult {
  runId: string;
  runDir: string;
  order: string[];
  blocks: BlockResult[];
  rows: number;
  stopped: boolean;
  /** ADE ids that ran once more because a block of theirs had stopped. */
  retried: string[];
  /** ADE ids that were not started because the deadline had passed (a run or retry included). */
  skippedForTime: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotDir(): string {
  return process.env.ADEMARK_SNAPSHOT ?? resolve(repoRoot, "snapshots", "clean");
}

// Only Track B is free of these: tokens do not move with load.
function gatesMessage(gates: Awaited<ReturnType<Instruments["gates"]>>, track: TrackLetter): string | null {
  const failed: string[] = [];
  if (!gates.swap_ok && track !== "B") failed.push(`swap used ${gates.swap_used_mb} MB`);
  if (!gates.thermal_ok) failed.push("thermal warning");
  // Tokens do not depend on a quiet CPU. Track C keeps the gate: its wall times, caps and chat-lock echoes do.
  if (!gates.cpu_quiet_ok && track !== "B") failed.push(`cpu ${gates.cpu_cores_used} cores`);
  return failed.length === 0 ? null : failed.join(", ");
}

// Control runs each ADE in its own process, so the control hash lives in a file that all of them compare with.
function loadBaseline(): string | null {
  const path = process.env.ADEMARK_BASELINE;
  return path !== undefined && existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function saveBaseline(hash: string | null): void {
  const path = process.env.ADEMARK_BASELINE;
  if (path !== undefined && hash !== null && !existsSync(path)) writeFileSync(path, hash);
}

function freeCaptureDir(blockDir: string, track: TrackLetter): string {
  let attempt = 1;
  while (existsSync(join(blockDir, `capture-${track}-${attempt}`))) attempt += 1;
  return join(blockDir, `capture-${track}-${attempt}`);
}

function installMismatch(ade: string, installed: InstallInfo, manifest: Manifest | null): string | null {
  if (!installed.installed) return "not installed";
  if (manifest === null) return null;
  const pinned = manifest.ade_versions[ade];
  if (pinned === undefined) return null;
  if (pinned.version !== "unknown" && installed.version !== null && installed.version !== pinned.version) {
    return `version ${installed.version} != pinned ${pinned.version}`;
  }
  if (pinned.sha256 !== null && installed.binarySha256 !== null && pinned.sha256 !== installed.binarySha256) {
    return "binary sha256 != pinned sha256";
  }
  return null;
}

// RUNBOOK.md §7.1 step 3: what the previous block left in the home config, a Track F fact.
function writeConfigDiff(dir: string, snapshot: string, home: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "global-config-diff.patch");
  try {
    if (!existsSync(snapshot)) {
      writeFileSync(path, `# no clean snapshot at ${snapshot}\n`);
      return;
    }
    const entries = diff(snapshot, home);
    const lines = [`# global config diff against ${snapshot}`];
    for (const entry of entries) lines.push(`${entry.status} ${entry.path}`);
    if (entries.length === 0) lines.push("# no changes");
    writeFileSync(path, `${lines.join("\n")}\n`);
  } catch (error) {
    writeFileSync(path, `# diff failed: ${messageOf(error)}\n`);
  }
}

/** A screenshot of the app's window as `<block>/failure-<track>-<n>.png`, or null with no window to take. */
export async function failureShot(instruments: Instruments, pid: unknown, blockDir: string, track: string): Promise<string | null> {
  if (instruments.dryRun || typeof pid !== "number" || pid <= 0) return null;
  mkdirSync(blockDir, { recursive: true });
  let index = 1;
  while (existsSync(join(blockDir, `failure-${track}-${index}.png`))) index += 1;
  const out = join(blockDir, `failure-${track}-${index}.png`);
  await instruments.screenshot({ pid, out });
  return out;
}

async function seedThreads(adapter: Adapter, ctx: AdapterContext, count: number): Promise<void> {
  for (let thread = 1; thread <= count; thread++) {
    await adapter.newThread(ctx);
    await adapter.send(ctx, SEED_PROMPT);
    const done = await adapter.waitDone(ctx, SEED_TIMEOUT_MS);
    if (!done.done) throw new Error(`seed thread ${thread}/${count} did not finish: ${done.reason}`);
  }
}

type StopReason = "converged" | "cap" | "extra cap" | "failed";

function validValues(rows: readonly ResultRow[], runner: TestRunner, variant: string): number[] {
  return rows
    .filter((row) => row.test_id === runner.id && row.variant === variant && row.valid && row.value !== null)
    .map((row) => row.value as number);
}

// TESTS.md §1.3: from `min` valid rows on, stop as soon as the median's 95 % interval is narrow enough. Invalid rows
// of the adaptive variant never count. A1's first-launch tier runs at rep 1, so `min` 6 can never skip it.
// A test that fails this many repetitions in a row will not start working: the night moves on and repair takes over.
export const MAX_FAILED_REPS = 3;

// Open, weight and ghost tests do not need a recorded answer. First word, streaming load and the long thread do.
const LIVE_MODEL_TESTS = new Set<string>(["A1", "A2", "A3", "A5", "A6", "A9"]);

function repFailed(row: ResultRow): boolean {
  return !row.valid && !(row.invalid_reason ?? "").startsWith(NOT_SUPPORTED);
}

// What the block is doing now, for the Control panel (ADEMARK_PROGRESS is set by bench/control). A rest test that looks
// idle for 10 minutes made the owner log out twice and end the run (2026-11-08).
export function reportProgress(ade: string, stage: string, test: string | null = null, rep: number | null = null): void {
  const path = process.env.ADEMARK_PROGRESS;
  if (path === undefined || path.length === 0) return;
  try {
    writeFileSync(path, `${JSON.stringify({ ade, stage, test, rep, at: new Date().toISOString() })}\n`);
  } catch {
    // The panel's status line is a courtesy; a write error never touches the measurement.
  }
}

// Repetitions the agent may add to one test after it repaired the app (bench/agent/watch.ts).
export const MAX_RECOVERED_REPS = 2;

export async function runTest(
  runner: TestRunner,
  ctx: ReturnType<typeof createTestContext>,
  writer: RunWriter,
  watch: RepWatch | null = repWatch(ctx),
): Promise<number> {
  const rows: ResultRow[] = [];
  let written = 0;
  let failedInARow = 0;
  let recovered = 0;
  let owed = 0;
  const givenUp = (): boolean => failedInARow >= MAX_FAILED_REPS;
  const runRep = async (rep: number): Promise<void> => {
    // The agent acts only here, between repetitions: never while one runs.
    await watch?.before(runner.id, rep);
    reportProgress(ctx.rowAde, "test", runner.id, rep);
    let produced: ResultRow[];
    try {
      produced = await runner.runRep(ctx, rep);
    } catch (error) {
      throw new Error(`${runner.id} rep ${rep}: ${messageOf(error)}`);
    }
    for (const row of produced) {
      writer.appendRow(row);
      rows.push(row);
      written += 1;
    }
    const failed = produced.length > 0 && produced.every(repFailed);
    failedInARow = failed ? failedInARow + 1 : 0;
    if (failed && watch !== null && recovered < MAX_RECOVERED_REPS) {
      const reason = produced.find((row) => !row.valid)?.invalid_reason ?? "invalid";
      if (await watch.recover(runner.id, rep, reason)) {
        recovered += 1;
        owed += 1;
        failedInARow = 0;
        ctx.log(`${runner.id}: the agent repaired the app after rep ${rep}; one more repetition`);
      }
    }
    if (givenUp()) ctx.log(`${runner.id}: stopped after ${failedInARow} failed repetitions in a row`);
  };

  const repeats = ctx.smoke ? (runner.smokeRepeats ?? 1) : Math.max(1, Math.trunc(runner.repeats(ctx)));
  const adaptive = ctx.smoke ? undefined : runner.adaptive;
  if (adaptive !== undefined) {
    const maxReps = repeats + Math.max(0, runner.maxExtraRuns);
    let repsRun = 0;
    let valid = 0;
    let reason: StopReason = "extra cap";
    for (let rep = 1; rep <= maxReps + owed; rep++) {
      await runRep(rep);
      repsRun = rep;
      if (givenUp()) {
        reason = "failed";
        break;
      }
      const values = validValues(rows, runner, adaptive.variant);
      valid = values.length;
      if (valid >= adaptive.min && medianConverged(values, { relTol: ADAPTIVE_REL_TOL, absTol: adaptive.absTol })) {
        reason = "converged";
        break;
      }
      if (valid >= repeats) {
        reason = "cap";
        break;
      }
    }
    ctx.log(`${runner.id} ${adaptive.variant}: stopped at n=${valid} of ${repsRun} (${reason})`);
    return written;
  }

  for (let rep = 1; rep <= repeats && !givenUp(); rep++) await runRep(rep);
  // A smoke run is exactly one repetition per test, never an extra one (TESTS.md §1.3).
  const extraRuns = ctx.smoke ? 0 : runner.maxExtraRuns;
  let next = repeats + 1;
  for (let extra = 0; extra < extraRuns && !givenUp() && runner.needsExtraRun(rows); extra++) await runRep(next++);
  // A repetition the agent repaired the app for is run again, at the end, with its own number.
  while (owed > 0 && !givenUp()) {
    owed -= 1;
    await runRep(next++);
  }
  return written;
}

// 2026-10-24: an Orca that did not quit kept 0.4 cores busy and the next ADE's quiet-CPU gate stopped its block. Every
// block ends with its app quit and no process left inside its bundle, also when the block stopped half way. The control's
// host (Ghostty) runs the harness, so it is never killed here.
async function closeApp(adapter: Adapter, ctx: AdapterContext, quitDone: boolean, rowAde: string): Promise<void> {
  // Each step runs even if the one before it fails: one leftover must not protect the next one.
  const step = async (label: string, work: () => void | Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      console.log(`[${rowAde}] ${label}: ${messageOf(error)}`);
    }
  };
  if (adapter.hostStaysOpen !== true) {
    await step("quit after a stopped block failed", async () => {
      if (!quitDone) await adapter.quit(ctx);
    });
    await step("leftover processes", async () => killPids(ctx, await pidsFor(ctx, { bundlePaths: adapter.processes().bundlePaths })));
    // A launch agent outlives the app, and the next ADE must not be measured with it running.
    for (const label of adapter.calibration.launchAgents) await step(`bootout ${label}`, () => bootout(ctx, label));
  }
  await step("orphan agents", () => killPids(ctx, orphanAgentPids(ctx)));
}

export async function runBlock(o: RunBlockOptions): Promise<BlockResult> {
  const { adapter } = o;
  const blockDir = join(o.runDir, o.rowAde);
  if (blockIsDone(o.runDir, o.rowAde, o.track, o.options.agent, singleBlockFor(adapter, o.track, o.rowAde))) {
    console.log(`[${o.rowAde}/${o.track}] already done, skipped`);
    return { ade: o.rowAde, track: o.track, finished: true, rows: 0, error: null };
  }
  mkdirSync(blockDir, { recursive: true });
  let replay: ReplayControl | null = null;
  let capture: CaptureControl | null = null;
  let sampler: SampleHandle | null = null;
  let rows = 0;
  let appCtx: AdapterContext | null = null;
  let quitDone = false;

  try {
    // Before the gates: a busy orphan would fail the CPU gate of this block and of every block after it.
    if (!o.instruments.dryRun) {
      const sweep: AdapterContext = { runDir: o.runDir, arenaPath: "", worktree: "", home: o.home, env: {}, dryRun: false, log: console.log };
      const stray = orphanAgentPids(sweep);
      if (stray.length > 0) killPids(sweep, stray);
      const alive = orphanAgentPids(sweep);
      if (alive.length > 0) throw new BlockStop(`gates: agent processes still alive: ${alive.join(",")}`);
    }
    const gates = await o.instruments.gates();
    o.writer.event("gate_values", JSON.stringify(gates));
    const gateFailure = gatesMessage(gates, o.track);
    if (gateFailure !== null) {
      o.writer.event("gate_failure", `gate failure: ${o.rowAde}/${o.track}: ${gateFailure}`);
      throw new BlockStop(`gates: ${gateFailure}`);
    }

    const installed = await adapter.installCheck();
    const mismatch = installMismatch(adapter.id, installed, o.manifest);
    if (mismatch !== null) {
      if (o.instruments.dryRun) {
        console.log(`[${o.rowAde}] dry run: install check skipped (${mismatch})`);
      } else {
        o.writer.event("gate_failure", `gate failure: ${o.rowAde}/${o.track}: install check ${mismatch}`);
        throw new BlockStop(`install check: ${mismatch}`);
      }
    }

    const previousDir = o.previous.rowAde === null ? join(o.runDir, "_start") : join(o.runDir, o.previous.rowAde);
    writeConfigDiff(previousDir, o.snapshotDir, o.home);

    const arena = await o.instruments.prepareArena({ dest: resolve(o.arenaRoot, o.rowAde), ref: o.arenaRef });

    const adapterCtx: AdapterContext = {
      runDir: o.runDir,
      arenaPath: arena,
      worktree: arena,
      home: o.home,
      env: {},
      dryRun: o.instruments.dryRun,
      log: (message) => console.log(`[${o.rowAde}] ${message}`),
    };
    if (!o.instruments.dryRun) mkdirSync(arena, { recursive: true });

    o.previous.rowAde = o.rowAde;
    appCtx = adapterCtx;
    // launchd keeps what an earlier block set, and a reset may launch the app (Conductor warms up there). A Track B app
    // would talk to the replay server. Each adapter's launch sets what this block needs.
    if (!o.instruments.dryRun) {
      for (const name of HARNESS_ENV) unsetenv(adapterCtx, name);
    }
    await adapter.reset(adapterCtx);
    await adapter.configure(adapterCtx, o.options);
    // Track C only, and after the reset: the reset restores the vendor's own settings, with orchestration off where
    // the vendor ships it off. Every other track measures the app as shipped.
    if (o.track === "C" && adapter.prepareOrchestration !== undefined) {
      try {
        await adapter.prepareOrchestration(adapterCtx);
      } catch (error) {
        o.writer.event("gate_failure", `gate failure: ${o.rowAde}/${o.track}: orchestration could not be switched on: ${messageOf(error)}`);
        throw new BlockStop(`orchestration could not be switched on: ${messageOf(error)}`);
      }
    }

    replay = await o.instruments.startReplay({
      sessions: join(benchRoot, "replay", "sessions"),
      log: join(blockDir, `${o.track.toLowerCase()}-replay.jsonl`),
      port: REPLAY_PORT,
    });
    o.state.set("replay", replay);

    const measured = await o.instruments.contamination({
      replayPort: replay.port,
      workdir: o.contaminationDir,
    });
    const contamination = checkContamination(o.reference, measured);
    // On 2026-11-07 an upstream change to the bare request stopped 13 apps for 6 hours. The global config diff and
    // the snapshot restore catch what an ADE writes; a changed control is recorded, kept as a body file, and becomes
    // the reference for the blocks that follow.
    // The run's first control stays the reference, so every later block that differs from it says so on its rows.
    o.state.delete(DRIFT_KEY);
    if (!contamination.ok) {
      o.writer.event("contamination_drift", `contamination drift: ${o.rowAde}/${o.track}: ${contamination.message}`);
      console.log(`[${o.rowAde}/${o.track}] contamination drift, measuring on: ${contamination.message}`);
      o.state.set(DRIFT_KEY, `${contamination.actual.slice(0, 12)} vs ${(contamination.reference ?? "").slice(0, 12)}`);
    }
    saveBaseline(o.reference.body_sha256);

    if (o.track === "A" && adapter.liveModel !== true) {
      const base = `http://127.0.0.1:${replay.port}`;
      adapterCtx.env.ANTHROPIC_BASE_URL = base;
      adapterCtx.env.OPENAI_BASE_URL = `${base}/v1`;
    } else if (o.track !== "A") {
      await replay.stop();
      replay = null;
      o.state.delete("replay");
      // A fresh folder per block and per attempt: an interrupted capture must not leak into this one.
      capture = await o.instruments.startCapture({ out: join(freeCaptureDir(blockDir, o.track), "capture.jsonl") });
      Object.assign(adapterCtx.env, capture.env ?? {});
      const ca = join(o.home, CA_FILE);
      adapterCtx.env.NODE_EXTRA_CA_CERTS = ca;
      adapterCtx.env.NODE_USE_SYSTEM_CA = "1";
      adapterCtx.env.SSL_CERT_FILE = ca;
      adapterCtx.env.CODEX_CA_CERTIFICATE = ca;
      o.state.set("capture", capture);
      o.state.set("capture_path", capture.outPath);
    }

    reportProgress(o.rowAde, "launch");
    const launched = await adapter.launch(adapterCtx);
    o.state.set("launch_pid", launched.pid);

    if (o.track === "C") {
      const csv = join(blockDir, o.track, "samples.csv");
      sampler = await o.instruments.sampleStart({ rules: sampleRulesFor(adapter, [launched.pid]), hz: SAMPLE_HZ, csv });
      o.state.set("C.samples_csv", csv);
    }
    if (o.track === "A") {
      reportProgress(o.rowAde, "seed");
      await seedThreads(adapter, adapterCtx, o.smoke === true ? SMOKE.seedThreads : SEED_THREADS);
    }

    const ctx = createTestContext({
      runId: o.runId,
      runDir: o.runDir,
      machineId: o.machineId,
      adapter,
      rowAde: o.rowAde,
      track: o.track,
      options: o.options,
      instruments: o.instruments,
      writer: o.writer,
      adapterCtx,
      installed,
      freshArena: (label) =>
        o.instruments.prepareArena({ dest: resolve(o.arenaRoot, `${o.rowAde}-${label}`), ref: o.arenaRef }),
      state: o.state,
      smoke: o.smoke === true,
    });

    for (const testId of TRACK_ORDER[o.track]) {
      const runner = o.runners.get(testId);
      // The runner's own track decides its block, whatever folder it lives in.
      if (runner === undefined || runner.track !== o.track) continue;
      if (adapter.liveModel === true && o.track === "A" && !LIVE_MODEL_TESTS.has(testId)) continue;
      const excluded = adapter.excludedTests?.[testId];
      if (excluded !== undefined) {
        o.writer.appendRow(
          ctx.row({
            test_id: testId,
            variant: "excluded",
            rep: 1,
            server: o.options.server,
            value: null,
            unit: "n/a",
            duration_ms: 0,
            valid: false,
            invalid_reason: `${NOT_SUPPORTED} here: ${excluded}`,
            receipts: { samples: null, video: null, frames: null, capture: null, log: null },
            notes: "excluded in the profile",
          }),
        );
        rows += 1;
        continue;
      }
      const smokeRepeats = o.smokeRepeats?.[testId];
      rows += await runTest(smokeRepeats === undefined ? runner : { ...runner, smokeRepeats }, ctx, o.writer);
    }

    quitDone = true;
    try {
      await adapter.quit(adapterCtx);
    } catch (error) {
      console.log(`[${o.rowAde}] quit failed: ${messageOf(error)}`);
    }
    writeFileSync(
      blockMarker(o.runDir, o.rowAde, o.track, o.options.agent),
      `${new Date().toISOString()} ${rows} rows\n`,
    );
    return { ade: o.rowAde, track: o.track, finished: true, rows, error: null };
  } catch (error) {
    if (error instanceof BlockStop) {
      console.log(`[${o.rowAde}/${o.track}] block stopped: ${messageOf(error)}`);
      return { ade: o.rowAde, track: o.track, finished: false, rows, error: messageOf(error) };
    }
    const message = messageOf(error);
    o.writer.event("harness_error", `harness error: ${o.rowAde}/${o.track}: ${message}`);
    console.log(`[${o.rowAde}/${o.track}] harness error: ${message}`);
    // What the window showed when the block broke, before the app is closed. On 2026-11-11 Superset ("seed thread 1/5
    // did not finish"), Capy and Cloudroom each lost a block to an error, and nothing on disk said what was on screen,
    // so their causes could not be read from the night. It never throws: the error above is what counts.
    const shot = await failureShot(o.instruments, o.state.get("launch_pid"), blockDir, o.track).catch(() => null);
    if (shot !== null) o.writer.event("failure_window", `window at the error: ${shot}`);
    return { ade: o.rowAde, track: o.track, finished: false, rows, error: message };
  } finally {
    if (appCtx !== null) await closeApp(adapter, appCtx, quitDone, o.rowAde);
    if (sampler !== null) await sampler.stop().catch((error: unknown) => console.log(`sampler stop: ${messageOf(error)}`));
    if (capture !== null) await capture.stop().catch((error: unknown) => console.log(`capture stop: ${messageOf(error)}`));
    if (replay !== null) await replay.stop().catch((error: unknown) => console.log(`replay stop: ${messageOf(error)}`));
    o.state.delete("replay");
  }
}

export async function runAde(o: RunAdeOptions): Promise<RunAdeResult> {
  const adapter = getAdapter(o.ade);
  const reference = o.reference ?? { body_sha256: loadBaseline() };
  const previous = o.previous ?? { rowAde: null as string | null };
  const ref = o.arenaRef ?? arenaRef();
  const contamination =
    o.contaminationDir ??
    (await o.instruments.prepareArena({ dest: contaminationDir(), ref }));

  const blocks: BlockResult[] = [];
  let rows = 0;
  let stopped = false;
  const retryAttempt = o.retryAttempt ?? 0;
  // One attempt folder per row ade and retry pass, so every stopped block of that row ade lands in it together.
  const attempts = new Map<string, string>();
  const attemptFor = (rowAde: string): string => {
    let folder = attempts.get(rowAde);
    if (folder === undefined) {
      folder = freeAttemptFolder(o.runDir, rowAde, retryAttempt);
      attempts.set(rowAde, folder);
    }
    return folder;
  };
  for (const track of o.tracks) {
    const wanted = blocksFor(adapter, track).filter((options) => o.agents === undefined || o.agents.includes(options.agent));
    for (const options of wanted) {
      const rowAde = rowAdeFor(adapter, options.agent);
      const legacyDone = singleBlockFor(adapter, track, rowAde);
      // On a retry only a stopped block measures again and moves its rows and receipts; a finished block keeps
      // them and its marker.
      if (retryAttempt > 0 && !blockIsDone(o.runDir, rowAde, track, options.agent, legacyDone)) {
        supersedeBlock(o.runDir, rowAde, track, options.agent, retryAttempt, attemptFor(rowAde));
      }
      const block = await runBlock({
        adapter,
        track,
        rowAde,
        runId: o.runId,
        runDir: o.runDir,
        machineId: o.machineId,
        options,
        instruments: o.instruments,
        writer: o.writer,
        runners: o.runners,
        manifest: o.manifest ?? null,
        home: o.home ?? homeDir(),
        arenaRoot: o.arenaRoot ?? arenaRoot(),
        arenaRef: ref,
        contaminationDir: contamination,
        snapshotDir: o.snapshotDir ?? snapshotDir(),
        state: new Map<string, unknown>(),
        previous,
        reference,
        smoke: o.smoke === true,
        smokeRepeats: o.smokeRepeats,
      });
      blocks.push(block);
      rows += block.rows;
      if (!block.finished) {
        stopped = true;
        break;
      }
    }
    if (stopped) break;
  }
  return { ade: adapter.id, runId: o.runId, blocks, stopped, rows };
}

async function versionsFor(ades: readonly string[]): Promise<Manifest["ade_versions"]> {
  const versions: Manifest["ade_versions"] = {};
  for (const ade of ades) {
    const info = await getAdapter(ade).installCheck();
    if (info.installed) versions[ade] = { version: info.version ?? "unknown", sha256: info.binarySha256 };
  }
  return versions;
}

export async function runAll(o: RunAllOptions): Promise<RunResult> {
  const writer = o.writer ?? new RunWriter(resultsRoot()).open(o.runId);
  const order = shuffle(o.ades, o.seed);
  const smoke = o.smoke === true;
  const collected = await collectManifest({
    runId: o.runId,
    orderSeed: o.seed,
    order,
    adeVersions: o.adeVersions ?? (await versionsFor(order)),
    reference: o.reference === true,
    mode: smoke ? "smoke" : undefined,
  });
  // A resumed run keeps the manifest of its night, with its order, seed and pins, and each block is checked against it:
  // an app that updated since then must stop the block, not join the night under a version the manifest does not name.
  const savedPath = join(writer.runDir, "manifest.json");
  const resumed = o.resume === true && existsSync(savedPath);
  const manifest: Manifest = resumed ? (JSON.parse(readFileSync(savedPath, "utf8")) as Manifest) : collected;
  if (resumed) {
    for (const key of ["cli_versions", "task_hashes", "price_file_sha256"] as const) {
      if (JSON.stringify(manifest[key]) !== JSON.stringify(collected[key])) {
        throw new Error(`resume: ${key} changed since this run started, so its rows cannot be compared`);
      }
    }
  }
  if (!resumed) writeManifest(writer.runDir, manifest);

  const ref = arenaRef();
  const contamination = await o.instruments.prepareArena({ dest: contaminationDir(), ref });

  const reference = { body_sha256: loadBaseline() };
  const previous = { rowAde: null as string | null };
  const blocks: BlockResult[] = [];
  let rows = 0;
  const lastStopped = new Map<string, boolean>();

  const runOne = async (ade: string, retryAttempt: number): Promise<RunAdeResult> => {
    const result = await runAde({
      ade,
      tracks: o.tracks,
      runId: o.runId,
      runDir: writer.runDir,
      machineId: manifest.machine_id,
      instruments: o.instruments,
      writer,
      runners: o.runners,
      manifest,
      home: o.home,
      arenaRoot: o.arenaRoot,
      arenaRef: ref,
      contaminationDir: contamination,
      snapshotDir: o.snapshotDir,
      previous,
      reference,
      agents: o.agents,
      smoke,
      smokeRepeats: o.smokeRepeats,
      retryAttempt,
    });
    blocks.push(...result.blocks);
    rows += result.rows;
    lastStopped.set(ade, result.stopped);
    return result;
  };

  const stoppedAdes: string[] = [];
  const skippedForTime: string[] = [];
  // A block that already started always finishes: the deadline only decides whether an ADE starts.
  const pastDeadline = (): boolean => o.deadline !== undefined && Date.now() >= o.deadline;
  for (const ade of order) {
    if (pastDeadline()) {
      console.log(`skip ${ade}: the deadline has passed`);
      skippedForTime.push(ade);
      continue;
    }
    const result = await runOne(ade, 0);
    if (result.stopped) stoppedAdes.push(ade);
    o.betweenAdes?.();
  }

  const retried: string[] = [];
  for (const ade of order) {
    if (!stoppedAdes.includes(ade)) continue;
    if (pastDeadline()) {
      console.log(`skip retry ${ade}: the deadline has passed`);
      skippedForTime.push(ade);
      continue;
    }
    console.log(`retry ${ade}`);
    retried.push(ade);
    await runOne(ade, 1);
    o.betweenAdes?.();
  }

  summarizeRun(writer.runDir);
  return {
    runId: o.runId,
    runDir: writer.runDir,
    order,
    blocks,
    rows,
    stopped: order.some((ade) => lastStopped.get(ade) === true),
    retried,
    skippedForTime,
  };
}
