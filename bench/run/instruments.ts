// One interface over every measuring tool (TESTS.md 1.0): real macOS and a deterministic dry implementation.
import type {
  CaptureRow,
  Fault,
  FaultKind,
  GradeResult,
  NativeCover,
  NativeEcho,
  NativeIdle,
  NativeLag,
  NativeNow,
  NativeOcr,
  NativeProc,
  NativeSample,
  NativeScroll,
  NativeWatch,
  NativeWindow,
} from "../core/contracts.ts";
import type { Gates } from "../core/gates.ts";
import type {
  CoverOptions,
  EchoOptions,
  IdleOptions,
  KeysOptions,
  LagOptions,
  OcrOptions,
  SampleOptions,
  SampleStartOptions,
  ScreenshotOptions,
  ScrollOptions,
  WatchOptions,
  WindowOptions,
} from "../core/native.ts";
import type { ReplayStats } from "../replay/server.ts";

export interface SampleHandle {
  stop(): Promise<NativeSample>;
}

export interface ReplayControl {
  port: number;
  logPath: string;
  stats(): Promise<ReplayStats>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export interface CaptureControl {
  outPath: string;
  /** What the ADE must see at launch, beyond the proxy's CA variables. */
  env?: Record<string, string>;
  rows(): CaptureRow[];
  /** Model calls that left the machine after `sinceNs`, counted before any answer. */
  requestsSince?(sinceNs: number): number;
  /** How many of them started this task, by the hash of their last user message. */
  startsSince?(sinceNs: number, taskHash: string): number;
  stop(): Promise<void>;
}

export interface FaultOutcome {
  kind: FaultKind;
  applied: boolean;
  started_ns: bigint;
  ended_ns: bigint;
  detail: string;
}

export interface ContaminationResult {
  bytes: number;
  body_sha256: string;
}

export interface Instruments {
  /** True when every member returns fixed dry values and appends its call to a plan file. */
  readonly dryRun: boolean;
  /** Host clock (CLOCK_UPTIME_RAW) in nanoseconds, the clock of every receipt. */
  now(): bigint;
  /** Waits on the host clock; a dry run returns at once. */
  sleep(ms: number): Promise<void>;
  /** Every process on the machine with its parent and responsible pid. */
  procs(): Promise<NativeProc[]>;
  /** First pid of the process named `name`, for processes `procs()` does not list (WindowServer), or null. */
  pidOf(name: string): Promise<number | null>;
  /** Waits for a quiet machine instead of a fixed sleep (A1 after purge, A2 after quit). */
  idle(o: IdleOptions): Promise<NativeIdle>;
  /** Samples the attributed processes for `durationS` and writes `csv`. */
  sample(o: SampleOptions): Promise<NativeSample>;
  /** Starts background sampling and returns a handle that writes the same summary on stop. */
  sampleStart(o: SampleStartOptions): Promise<SampleHandle>;
  /** Sets an app window to a size and returns its window id and frame. */
  window(o: WindowOptions): Promise<NativeWindow>;
  /** Posts keys, a combo or Enter to the measured pid. */
  keys(o: KeysOptions): Promise<NativeNow>;
  /** Times typing readiness and visual settling from captured frames. */
  echo(o: EchoOptions): Promise<NativeEcho>;
  /** Waits until a word is visible in the region and returns the frame time. */
  watch(o: WatchOptions): Promise<NativeWatch>;
  /** Samples frame latencies and returns p50, p95 and lost frames. */
  lag(o: LagOptions): Promise<NativeLag>;
  /** Posts scroll-wheel events and counts frame gaps over 33 ms. */
  scroll(o: ScrollOptions): Promise<NativeScroll>;
  /** Covers the app window with an opaque static window for `durationS`. */
  cover(o: CoverOptions): Promise<NativeCover>;
  /** Captures one PNG frame of the app window. */
  screenshot(o: ScreenshotOptions): Promise<{ path: string }>;
  /** Reads the text lines of a PNG (A1 reads the whole window once when a cold start times out). */
  ocr(o: OcrOptions): Promise<NativeOcr>;
  /** Writes the arena at `ref` into `dest` (replacing it) and returns `dest`. */
  prepareArena(o: { dest: string; ref: string }): Promise<string>;
  /** Starts the replay server and returns its control endpoints. */
  startReplay(o: { sessions: string; log: string; port: number }): Promise<ReplayControl>;
  /** Starts mitmdump in local mode and records requests to `out`. */
  startCapture(o: { out: string }): Promise<CaptureControl>;
  /** Applies one fault from the task and returns its window on the host clock. */
  fault(f: Fault, o: { worktree: string; appName: string; agentExecutables: string[] }): Promise<FaultOutcome>;
  /** Runs the hidden tests against the worktree and writes the grade file. */
  grade(o: { taskId: string; worktree: string; out: string; handoffSeed: string | null }): Promise<GradeResult>;
  /** Reads de-duplicated app memory with sudo footprint. */
  footprint(o: { pids: number[]; out: string }): Promise<{ total_b: number }>;
  /** Runs sudo purge and waits for it to finish. */
  purge(): Promise<void>;
  /** Reads the pre-block machine gates (swap, thermal, quiet CPU). `quietWaitMs: 0` takes one sample and never waits. */
  gates(o?: { quietWaitMs?: number }): Promise<Gates>;
  /** Runs the Bare CLI "hi" against the replay server and returns the last request's size and hash. */
  contamination(o: { replayPort: number; workdir: string }): Promise<ContaminationResult>;
}
