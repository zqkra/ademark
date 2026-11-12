// The per-ADE context every test runner receives: identity, receipts, writer and shared state.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Adapter,
  AdapterContext,
  InstallInfo,
  Receipts,
  ResultRow,
  RunOptions,
  SampleRules,
  Server,
  TestId,
} from "../core/contracts.ts";
import { validateRow, type RunWriter } from "../core/results.ts";
import type { Instruments } from "./instruments.ts";
import type { TrackLetter } from "./registry.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A smoke row says so before anything else, so a reader can never mistake one for a measured row.
function rowNotes(notes: string, smoke: boolean, dryRun: boolean): string {
  const marked = smoke ? (notes.length === 0 ? "smoke" : `smoke; ${notes}`) : notes;
  if (!dryRun) return marked;
  return marked.length === 0 ? "dry run" : `dry run; ${marked}`;
}

// Set by the block when its contamination control differs from the run's first one (bench/run/loop.ts). Every row
// of that block carries it, so the drift is reviewed before these numbers are published.
export const DRIFT_KEY = "contamination.drift";

function withDrift(notes: string, drift: unknown): string {
  if (typeof drift !== "string" || drift.length === 0) return notes;
  const mark = `control request changed: ${drift}`;
  return notes.length === 0 ? mark : `${notes}; ${mark}`;
}

export interface RowFields {
  test_id: TestId;
  variant: string;
  rep: number;
  server: Server;
  value: number | null;
  unit: string;
  duration_ms: number;
  valid: boolean;
  invalid_reason: string | null;
  receipts: Receipts;
  notes: string;
}

export interface TestContext {
  runId: string;
  runDir: string;
  machineId: string;
  adapter: Adapter;
  /** The `ade` value of every row: "bare-cli-claude", "bare-cli-codex" or the adapter id (TESTS.md §0.1). */
  rowAde: string;
  track: TrackLetter;
  options: RunOptions;
  instruments: Instruments;
  writer: RunWriter;
  adapterCtx: AdapterContext;
  installed: InstallInfo;
  /** Values shared across the tests of one ADE block, for example "A5.app_median_b". */
  state: Map<string, unknown>;
  /** True in a smoke run: one repetition per test, short windows, never published (TESTS.md §1.3). */
  smoke: boolean;
  /** `<runDir>/<rowAde>/<testId>/rep-<nn>/`, plus `<agent>/` before `rep-<nn>` in Track B (TESTS.md §0.2). */
  receiptDir(testId: TestId, rep: number): string;
  /** A fresh arena clone for one Track C test (TESTS.md §4). */
  freshArena(label: string): Promise<string>;
  row(fields: RowFields): ResultRow;
  log(message: string): void;
}

export interface TestContextOptions {
  runId: string;
  runDir: string;
  machineId: string;
  adapter: Adapter;
  rowAde: string;
  track: TrackLetter;
  options: RunOptions;
  instruments: Instruments;
  writer: RunWriter;
  adapterCtx: AdapterContext;
  installed: InstallInfo;
  freshArena(label: string): Promise<string>;
  state?: Map<string, unknown>;
  smoke?: boolean;
}

// The sampler attributes the process tree and the bundle/vendor paths of the ADE (TESTS.md §1.2).
export function sampleRulesFor(adapter: Adapter, rootPids: number[]): SampleRules {
  const hints = adapter.processes();
  return {
    rootPids: [...rootPids],
    bundlePaths: [...hints.bundlePaths],
    vendorDirs: [...hints.vendorDirs],
    agentExecutables: [...hints.agentExecutables],
    excludeNames: [],
    harnessPids: [harnessPid()],
  };
}

/** The top of the harness tree: `cli.ts` sets it once, so a child run still points at the control server. */
export function harnessPid(): number {
  return Number(process.env.ADEMARK_HARNESS_PID) || process.pid;
}

function receiptDirFor(
  runDir: string,
  rowAde: string,
  testId: TestId,
  track: TrackLetter,
  agent: RunOptions["agent"],
  rep: number,
): string {
  if (!SAFE_SEGMENT.test(rowAde)) throw new Error(`receiptDir: unsafe ade ${rowAde}`);
  if (!Number.isInteger(rep) || rep < 1) throw new Error(`receiptDir: rep must be an integer >= 1, got ${rep}`);
  const parts = [rowAde, testId];
  if (track === "B") parts.push(agent);
  parts.push(`rep-${String(rep).padStart(2, "0")}`);
  const dir = join(runDir, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createTestContext(o: TestContextOptions): TestContext {
  const state = o.state ?? new Map<string, unknown>();
  return {
    runId: o.runId,
    runDir: o.runDir,
    machineId: o.machineId,
    adapter: o.adapter,
    rowAde: o.rowAde,
    track: o.track,
    options: o.options,
    instruments: o.instruments,
    writer: o.writer,
    adapterCtx: o.adapterCtx,
    installed: o.installed,
    state,
    smoke: o.smoke === true,
    receiptDir: (testId, rep) => receiptDirFor(o.runDir, o.rowAde, testId, o.track, o.options.agent, rep),
    freshArena: async (label) => {
      if (!SAFE_SEGMENT.test(label)) throw new Error(`freshArena: unsafe label ${label}`);
      return o.freshArena(label);
    },
    row: (fields) =>
      validateRow({
        run_id: o.runId,
        machine_id: o.machineId,
        ade: o.rowAde,
        ade_version: o.installed.version ?? "unknown",
        ade_build_sha256: o.installed.binarySha256,
        family: o.adapter.family,
        test_id: fields.test_id,
        variant: fields.variant,
        rep: fields.rep,
        model: o.options.model,
        effort: o.options.effort,
        server: o.adapter.liveModel === true ? "live" : fields.server,
        value: fields.value,
        unit: fields.unit,
        started_at: new Date().toISOString(),
        duration_ms: fields.duration_ms,
        valid: fields.valid,
        invalid_reason: fields.invalid_reason,
        drive: o.adapter.calibration.drive,
        receipts: fields.receipts,
        notes: withDrift(rowNotes(fields.notes, o.smoke === true, o.instruments.dryRun), state.get(DRIFT_KEY)),
      }),
    log: (message) => {
      console.log(`[${o.rowAde}] ${message}`);
    },
  };
}
