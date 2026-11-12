// Typed wrappers around `ademark-native` (bench/native, ADEMARK-1). Exit codes 2/3/4 become typed errors.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
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
  Point,
  Rect,
  SampleRules,
  Trigger,
} from "./contracts.ts";
import { benchRoot } from "./paths.ts";
import { withoutAgentSession } from "./env.ts";

export class NativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeError";
  }
}

export class BadArgs extends NativeError {
  constructor(message: string) {
    super(message);
    this.name = "BadArgs";
  }
}

export class PermissionMissing extends NativeError {
  constructor(message: string) {
    super(message);
    this.name = "PermissionMissing";
  }
}

export class NativeFailure extends NativeError {
  constructor(message: string) {
    super(message);
    this.name = "NativeFailure";
  }
}

export function nativeBinary(): string {
  return process.env.ADEMARK_NATIVE ?? resolve(benchRoot, "native", "bin", "ademark-native");
}

interface ErrorJson {
  error?: string;
  message?: string;
}

function describeFailure(stdout: string, stderr: string): string {
  try {
    const parsed = JSON.parse(stdout) as ErrorJson;
    if (parsed.error) return `${parsed.error}${parsed.message ? `: ${parsed.message}` : ""}`;
  } catch {
    // not JSON, fall through
  }
  const text = (stderr.trim() || stdout.trim()).slice(0, 500);
  return text.length > 0 ? text : "no output";
}

function rectArg(rect: Rect): string {
  return `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

function pointArg(point: Point): string {
  return `${point.x},${point.y}`;
}

function requireBinary(): string {
  const binary = nativeBinary();
  if (!existsSync(binary)) {
    throw new NativeError(
      `ademark-native not found at ${binary}. Build it with \`bash bench/native/build.sh\` ` +
        `or set ADEMARK_NATIVE to the binary path.`,
    );
  }
  return binary;
}

function spawnNative(binary: string, args: string[]) {
  try {
    return Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", env: withoutAgentSession() });
  } catch (error) {
    throw new NativeFailure(
      `${binary} could not be started: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function failure(args: string[], exitCode: number, stdout: string, stderr: string): NativeError {
  const message = `ademark-native ${args[0]} failed (exit ${exitCode}): ${describeFailure(stdout, stderr)}`;
  if (exitCode === 2) return new BadArgs(message);
  if (exitCode === 3) return new PermissionMissing(message);
  return new NativeFailure(message);
}

async function readAll(proc: ReturnType<typeof spawnNative>): Promise<[string, string, number]> {
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
}

async function call<T>(args: string[]): Promise<T> {
  const binary = requireBinary();
  const proc = spawnNative(binary, args);
  const [stdout, stderr, exitCode] = await readAll(proc);
  if (exitCode === 0) {
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new NativeFailure(`ademark-native ${args[0]} returned invalid JSON: ${stdout.slice(0, 200)}`);
    }
  }
  throw failure(args, exitCode, stdout, stderr);
}

export function now(): Promise<NativeNow> {
  return call<NativeNow>(["now"]);
}

export function procs(): Promise<NativeProc[]> {
  return call<NativeProc[]>(["procs"]);
}

export interface IdleOptions {
  /** Machine CPU use that counts as quiet, in cores (0.1 = a tenth of one core). */
  cpuCores: number;
  /** How long the machine must stay under it, in milliseconds. */
  quietMs: number;
  /** Give up at this cap and report `quiet: false`. */
  capS: number;
}

// `ademark-native idle`: waits for a quiet machine; returns at the cap with `quiet: false`.
export function idle(options: IdleOptions): Promise<NativeIdle> {
  return call<NativeIdle>([
    "idle",
    "--cpu-cores",
    String(options.cpuCores),
    "--quiet-ms",
    String(options.quietMs),
    "--cap-s",
    String(options.capS),
  ]);
}

export interface SampleOptions {
  rules: string | SampleRules;
  hz: number;
  durationS: number;
  csv: string;
}

export async function sample(options: SampleOptions): Promise<NativeSample> {
  const temporary = typeof options.rules === "string" ? null : writeRules(options.rules);
  try {
    return await call<NativeSample>([
      "sample",
      "--rules",
      temporary ?? (options.rules as string),
      "--hz",
      String(options.hz),
      "--duration-s",
      String(options.durationS),
      "--csv",
      options.csv,
    ]);
  } finally {
    if (temporary !== null) rmSync(temporary, { force: true });
  }
}

function writeRules(rules: SampleRules): string {
  const dir = process.env.TMPDIR ?? "/tmp";
  const path = `${dir.replace(/\/$/, "")}/ademark-sample-rules-${process.pid}-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(rules));
  return path;
}

export type SampleStartOptions = Omit<SampleOptions, "durationS">;

export interface SampleStartHandle {
  pid: number;
  stop(): Promise<NativeSample>;
}

// `sample --duration-s 0` runs until SIGTERM; stop() returns the same summary a timed run prints.
export async function sampleStart(options: SampleStartOptions): Promise<SampleStartHandle> {
  const binary = requireBinary();
  const temporary = typeof options.rules === "string" ? null : writeRules(options.rules);
  const args = [
    "sample",
    "--rules",
    temporary ?? (options.rules as string),
    "--hz",
    String(options.hz),
    "--duration-s",
    "0",
    "--csv",
    options.csv,
  ];
  const proc = spawnNative(binary, args);
  let stopped = false;
  return {
    pid: proc.pid,
    stop: async () => {
      if (stopped) throw new NativeError("sampleStart: stop() was already called");
      stopped = true;
      // Bun only reaps the child once its pipes are drained, so read them while the grace timer runs.
      // 500 ms covers a process that exits on its own right after start; a live sampler is then SIGTERMed.
      const drain = readAll(proc);
      const settled = await Promise.race([
        drain.then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 500)),
      ]);
      if (!settled) proc.kill("SIGTERM");
      const [stdout, stderr, exitCode] = await drain;
      if (temporary !== null) rmSync(temporary, { force: true });
      if (exitCode !== 0) throw failure(args, exitCode, stdout, stderr);
      try {
        return JSON.parse(stdout) as NativeSample;
      } catch {
        throw new NativeFailure(`ademark-native sample returned invalid JSON: ${stdout.slice(0, 200)}`);
      }
    },
  };
}

export interface WindowOptions {
  pid: number;
  size: { w: number; h: number };
  front?: boolean;
}

export function window(options: WindowOptions): Promise<NativeWindow> {
  const args = ["window", "--pid", String(options.pid), "--size", `${options.size.w}x${options.size.h}`];
  if (options.front) args.push("--front");
  return call<NativeWindow>(args);
}

export type KeysOptions = { pid: number } & ({ text: string } | { combo: string } | { enter: true });

export function keys(options: KeysOptions): Promise<NativeNow> {
  const args = ["keys", "--pid", String(options.pid)];
  if ("text" in options) args.push("--text", options.text);
  else if ("combo" in options) args.push("--combo", options.combo);
  else args.push("--enter");
  return call<NativeNow>(args);
}

export interface EchoOptions {
  pid: number;
  triggers: Trigger[];
  region: Rect;
  focusClick?: Point;
  probe: string;
  intervalMs: number;
  timeoutS: number;
  frames: string;
  video?: string;
  masks?: Rect[];
  /** Give up on visual settling after this many seconds from t0 (`--settle-cap-s`); omitted: 5. */
  settleCapS?: number;
  /** Keys that empty the composer afterwards (`--clear`); omitted: cmd+a, delete. */
  clear?: string[];
  /** Text that must be gone for Ready (`--absent`): from the composer region, or from `absentRegion` when given. */
  absent?: string;
  /**
   * The region `absent` is read in (`--absent-region`), only on a frame whose composer would be Ready. There the match
   * allows one substituted letter. A3 reads the old thread's marker in threadRect (ADEMARK-40).
   */
  absentRegion?: Rect;
  /** A longer text of the marker line (`--absent-also`), read in `absentRegion`: either text holds Ready back. */
  absentAlso?: string;
}

export function echo(options: EchoOptions): Promise<NativeEcho> {
  const args = [
    "echo",
    "--pid",
    String(options.pid),
    "--triggers",
    JSON.stringify(options.triggers),
    "--region",
    rectArg(options.region),
    "--probe",
    options.probe,
    "--interval-ms",
    String(options.intervalMs),
    "--timeout-s",
    String(options.timeoutS),
    "--frames",
    options.frames,
  ];
  if (options.focusClick) args.push("--focus-click", pointArg(options.focusClick));
  if (options.video) args.push("--video", options.video);
  if (options.masks) args.push("--masks", JSON.stringify(options.masks));
  if (options.settleCapS !== undefined) args.push("--settle-cap-s", String(options.settleCapS));
  if (options.clear && options.clear.length > 0) args.push("--clear", options.clear.join(","));
  if (options.absent) args.push("--absent", options.absent);
  if (options.absent && options.absentRegion) args.push("--absent-region", rectArg(options.absentRegion));
  if (options.absent && options.absentRegion && options.absentAlso) args.push("--absent-also", options.absentAlso);
  return call<NativeEcho>(args);
}

export interface WatchOptions {
  pid: number;
  /** One text (`--text`), or a list (`--texts`): the watch stops at the first frame that shows any of them. */
  text: string | readonly string[];
  region: Rect;
  triggers: Trigger[];
  timeoutS: number;
  frames: string;
  /** Letters the marker may have misread, as substitutions (`--fuzzy`); omitted: exact. */
  fuzzy?: number;
  /** The rule of the echo's absent region (`--nearly`): a wrong, missing or extra letter still counts. Not with `fuzzy`. */
  nearly?: boolean;
}

export function watch(options: WatchOptions): Promise<NativeWatch> {
  return call<NativeWatch>([
    "watch",
    "--pid",
    String(options.pid),
    ...(typeof options.text === "string" ? ["--text", options.text] : ["--texts", JSON.stringify(options.text)]),
    "--region",
    rectArg(options.region),
    "--triggers",
    JSON.stringify(options.triggers),
    "--timeout-s",
    String(options.timeoutS),
    "--frames",
    options.frames,
    ...(options.fuzzy === undefined || options.fuzzy === 0 ? [] : ["--fuzzy", String(options.fuzzy)]),
    ...(options.nearly === true ? ["--nearly"] : []),
  ]);
}

export interface LagOptions {
  pid: number;
  region: Rect;
  count: number;
  intervalMs: number;
  frames: string;
  /** Keys that empty the composer afterwards (`--clear`); omitted: cmd+a, delete. */
  clear?: string[];
}

export function lag(options: LagOptions): Promise<NativeLag> {
  const clear = options.clear && options.clear.length > 0 ? ["--clear", options.clear.join(",")] : [];
  return call<NativeLag>([
    "lag",
    "--pid",
    String(options.pid),
    "--region",
    rectArg(options.region),
    "--count",
    String(options.count),
    "--interval-ms",
    String(options.intervalMs),
    "--frames",
    options.frames,
    ...clear,
  ]);
}

export interface OcrOptions {
  image: string;
  region?: Rect;
}

export function ocr(options: OcrOptions): Promise<NativeOcr> {
  const args = ["ocr", "--image", options.image];
  if (options.region) args.push("--region", rectArg(options.region));
  return call<NativeOcr>(args);
}

export interface ScrollOptions {
  pid: number;
  region: Rect;
  count: number;
  hz: number;
  lines: number;
  frames: string;
}

export function scroll(options: ScrollOptions): Promise<NativeScroll> {
  return call<NativeScroll>([
    "scroll",
    "--pid",
    String(options.pid),
    "--region",
    rectArg(options.region),
    "--count",
    String(options.count),
    "--hz",
    String(options.hz),
    "--lines",
    String(options.lines),
    "--frames",
    options.frames,
  ]);
}

export interface CoverOptions {
  pid: number;
  durationS: number;
}

export function cover(options: CoverOptions): Promise<NativeCover> {
  return call<NativeCover>([
    "cover",
    "--pid",
    String(options.pid),
    "--duration-s",
    String(options.durationS),
  ]);
}

export interface ScreenshotOptions {
  pid: number;
  out: string;
}

export function screenshot(options: ScreenshotOptions): Promise<{ path: string }> {
  return call<{ path: string }>(["screenshot", "--pid", String(options.pid), "--out", options.out]);
}
