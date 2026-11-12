// The shared Track C procedure: fresh arena, prompt, end of task, grade, tokens and the reporting helpers
// every C test uses (TESTS.md §4).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findSessionLogs, newestChangeMs, type SessionAgent } from "../../adapters/session-log.ts";
import { classifyMainThread, isCompletion, lacksUsage, pricedUsage, priceUsd, sumUsage, threadShape, type PriceFile, type ThreadShape } from "../../capture/tokens.ts";
import type {
  Agent,
  CaptureRow,
  CapturedUsage,
  Fault,
  FaultOutcome,
  GradeResult,
  NativeProc,
  Receipts,
  ResultRow,
  TaskSpec,
  TestId,
} from "../../core/contracts.ts";
import { priceFile } from "../../core/paths.ts";
import { loadTask, type HandoffCodes } from "../../core/tasks.ts";
import { userTextCandidates } from "../../replay/session.ts";
import type { TestContext } from "../../run/context.ts";
import type { CaptureControl } from "../../run/instruments.ts";
import { AgentWatch, type AgentsSeen } from "./agents.ts";
import { emptyReceipts, invalidRow, receipt } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";

export const C1_TASK = "C1-orchestrated-build";
export const C1_SOLO_TASK = "C1-solo";
export const C2_TASK = "C2-message-delivery";
export const C4_TASK = "C4-agent-killed";
export const C5_TASK = "C5-network-cut";
export const C6_TASK = "C6-app-restart";

export const HANDOFF_SEED_PREFIX = "ademark-";

export function handoffSeedFor(runId: string): string {
  return `${HANDOFF_SEED_PREFIX}${runId}`;
}

// A dry launch plans pid 0 (Track A reads it the same way). Without it C2 and C3 stopped at "no launch pid" in every
// dry run, so their procedure was never checked before a real night (2026-11-11). A real run still needs a real pid.
export function launchPid(ctx: TestContext): number | null {
  const pid = ctx.state.get("launch_pid");
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (pid > 0) return pid;
  return pid === 0 && ctx.instruments.dryRun ? 0 : null;
}

// Screen recording is a receipt: one PNG at the start, at every event and at the end.
export async function screenshot(ctx: TestContext, testId: TestId, rep: number, name: string): Promise<string> {
  const path = receipt(ctx, testId, rep, `screenshot-${name}.png`);
  const pid = launchPid(ctx);
  if (pid !== null) await ctx.instruments.screenshot({ pid, out: path.abs });
  return path.rel;
}

function runRelative(ctx: TestContext, abs: unknown): string | null {
  if (typeof abs !== "string" || abs.length === 0) return null;
  const rel = relative(ctx.runDir, abs).split(sep).join("/");
  return rel.startsWith("..") ? null : rel;
}

// The receipts every Track C row points at; the caller adds frames or video where it has one.
export function runReceipts(ctx: TestContext, log: string | null = null): Receipts {
  return {
    samples: runRelative(ctx, ctx.state.get("C.samples_csv")),
    video: null,
    frames: null,
    capture: runRelative(ctx, ctx.state.get("capture_path")),
    log,
  };
}

// ---------- the run ----------

export interface TaskWindow {
  t0Ns: bigint;
  untilNs: bigint;
  worktree: string;
  /** Host-clock milliseconds since t0. */
  elapsedMs(): number;
  /** True once the task ended, so a background probe stops typing. */
  stopped(): boolean;
}

export interface TaskRunRequest {
  taskId: string;
  /** The fresh arena label: one per test and repetition. */
  label: string;
  rep: number;
  prompt: string;
  /** Starts right after the prompt and runs concurrently with the wait for the end. The C3 probe uses it. */
  background?: (ctx: TestContext, window: TaskWindow) => Promise<void>;
  /** Runs between the prompt and the wait for the end. C2 follow-ups and the fault tests use it. */
  schedule?: (ctx: TestContext, window: TaskWindow) => Promise<void>;
  /** A run of several agents (C1): the end is when every agent is quiet, and a run with one agent can be stopped. */
  agents?: AgentsRule;
}

export interface AgentsRule {
  /** After an end of turn, the run is over when no agent answered a tool for this long. */
  quietMs: number;
  pollMs: number;
  /** With no second agent by this time, the wait stops: the trigger did not start orchestration. Absent: never. */
  noWorkerStopMs?: number;
  /** The second agent must be a client session of its own (Adapter.orchestrationWorkers). */
  ownSessions?: boolean;
}

/** Whether a second agent worked, by the rule of the ADE. */
export function hasWorker(seen: AgentsSeen, ownSessions: boolean): boolean {
  return ownSessions ? seen.sessions >= 2 : seen.agents >= 2;
}

// The end of a run was the first session log that shows an end of turn (waitForEndOfTurn). With several agents that
// can be one worker that finished, or a lead that handed the work out and ended its turn, while the others still
// build. So after that first end the capture decides: the run is over when no request answered a tool for 5 minutes.
// A working agent answers a tool every few seconds, and a long command or one long answer stays under 5 minutes. The
// time of the wait is not part of the run: the end is the last answer to a tool, or the end of turn when none
// followed it.
export const QUIET_MS = 5 * 60_000;
export const QUIET_POLL_MS = 10_000;
// A lead reads the repository and hands the work out in its first minutes. A run still alone after 15 has not
// started orchestration: stopping it there saves 30 minutes of the 45-minute cap, and the model time of a build that
// could not count.
export const NO_WORKER_STOP_MS = 15 * 60_000;
export const C1_AGENTS: AgentsRule = { quietMs: QUIET_MS, pollMs: QUIET_POLL_MS, noWorkerStopMs: NO_WORKER_STOP_MS };

export interface TaskRun {
  task: TaskSpec;
  worktree: string;
  t0Ns: bigint;
  endNs: bigint;
  durationMs: number;
  done: boolean;
  reason: string;
  grade: GradeResult;
  capture: CaptureRow[];
  /** The model requests that ended after the end of the run, up to the end of the grade. */
  afterEnd: CaptureRow[];
  /** The agents of the run, from its capture. Null without the `agents` rule, and in a dry run. */
  agents: AgentsSeen | null;
  /** Stopped at `noWorkerStopMs` with one agent only. */
  stoppedAlone: boolean;
  /** How long the run went on after the first end of turn, when it did. */
  wentOnMs: number;
  receipts: Receipts;
  /** false when the ADE is gone at the end, null when a dry run skipped the check. */
  crashed: boolean | null;
}

// Done or cap is the end (TESTS.md §4). The caller's `schedule` runs before the wait; a `background` probe
// stops typing as soon as the end is known.
export async function runTask(ctx: TestContext, request: TaskRunRequest): Promise<TaskRun> {
  const task = loadTask(request.taskId);
  const testId = task.test_id;
  const worktree = await ctx.freshArena(request.label);
  ctx.adapterCtx.worktree = worktree;
  ctx.adapterCtx.arenaPath = worktree;
  await ctx.adapter.configure(ctx.adapterCtx, ctx.options);

  await ctx.adapter.newThread(ctx.adapterCtx);
  await screenshot(ctx, testId, request.rep, "start");
  const t0Ns = ctx.instruments.now();
  await ctx.adapter.send(ctx.adapterCtx, request.prompt);

  const elapsedMs = (): number => Math.max(0, Number(ctx.instruments.now() - t0Ns) / 1_000_000);
  const stop = { value: false };
  const window: TaskWindow = {
    t0Ns,
    untilNs: t0Ns + BigInt(task.time_cap_s) * 1_000_000_000n,
    worktree,
    elapsedMs,
    stopped: () => stop.value,
  };

  let backgroundError: unknown = null;
  const background = (request.background?.(ctx, window) ?? Promise.resolve()).then(
    () => undefined,
    (error: unknown) => {
      backgroundError = error;
    },
  );

  const rule = ctx.instruments.dryRun ? undefined : request.agents;
  const watch = new AgentWatch((row) => bodyTextOf(ctx, row));
  const seen = (toNs?: number): AgentsSeen => watch.read(captureRows(ctx), Number(t0Ns), toNs);
  // While the agents work the capture is being written. A read that fails then must not cost the run: it is tried
  // again at the next look, and the last good one stands until then.
  let lastSeen: AgentsSeen | null = null;
  const look = (): AgentsSeen | null => {
    try {
      lastSeen = seen();
    } catch (error) {
      ctx.adapterCtx.log(`${request.label}: the capture could not be read (${error instanceof Error ? error.message : String(error)}); looking again`);
    }
    return lastSeen;
  };
  const capMs = task.time_cap_s * 1_000;
  const remainingMs = (): number => Math.max(1_000, capMs - elapsedMs());
  let waited = { done: false, reason: "error" };
  let stoppedAlone = false;
  try {
    if (request.schedule !== undefined) await request.schedule(ctx, window);
    if (rule?.noWorkerStopMs !== undefined && rule.noWorkerStopMs < capMs) {
      waited = await ctx.adapter.waitDone(ctx.adapterCtx, Math.max(1_000, Math.min(remainingMs(), rule.noWorkerStopMs - elapsedMs())));
      if (!waited.done && elapsedMs() < capMs) {
        // Only a capture that was read and shows one agent stops the run: no reading is not a reason.
        const now = look();
        if (now !== null && !hasWorker(now, rule.ownSessions === true)) {
          stoppedAlone = true;
          waited = { done: false, reason: "one agent only" };
        } else waited = await ctx.adapter.waitDone(ctx.adapterCtx, remainingMs());
      }
    } else {
      waited = await ctx.adapter.waitDone(ctx.adapterCtx, remainingMs());
    }
  } finally {
    stop.value = true;
    await background;
  }
  if (backgroundError !== null) throw backgroundError;

  let endNs = ctx.instruments.now();
  let wentOnMs = 0;
  if (rule !== undefined && waited.done) {
    const firstEndNs = endNs;
    const lastWork = (): bigint => {
      const last = look()?.lastWorkNs ?? null;
      return last === null || BigInt(last) < firstEndNs ? firstEndNs : BigInt(last);
    };
    // Over when every agent was quiet for `quietMs`. The wait itself may pass the cap: a run that ended at minute 43
    // is not a run cut at 45. Work after the cap is: the run is cut at the cap, as before.
    const capNs = t0Ns + BigInt(capMs) * 1_000_000n;
    for (;;) {
      const last = lastWork();
      if (last > capNs) {
        waited = { done: false, reason: "timeout" };
        endNs = capNs;
        break;
      }
      if (Number(ctx.instruments.now() - last) / 1_000_000 >= rule.quietMs) {
        endNs = last;
        break;
      }
      await ctx.instruments.sleep(rule.pollMs);
    }
    wentOnMs = Number(endNs - firstEndNs) / 1_000_000;
    if (wentOnMs > 0) ctx.adapterCtx.log(`${request.label}: the run went on ${Math.round(wentOnMs / 1000)} s after the first end of turn`);
  }
  await screenshot(ctx, testId, request.rep, "end");
  const crashed = await adeCrashed(ctx);
  const notes = receipt(ctx, testId, request.rep, "notes.md");
  writeFileSync(notes.abs, runNotes(task, request, waited, Number(endNs - t0Ns) / 1_000_000, crashed), "utf8");
  // The agents of the run itself. If this last read fails, the last look stands: it may count a call after the end.
  const agentsAtEnd = (): AgentsSeen | null => {
    try {
      return seen(Number(endNs));
    } catch {
      return lastSeen;
    }
  };
  const gradeOut = receipt(ctx, testId, request.rep, "grade.json");
  const grade = await ctx.instruments.grade({
    taskId: request.taskId,
    worktree,
    out: gradeOut.abs,
    handoffSeed: handoffSeedFor(ctx.runId),
  });
  return {
    task,
    worktree,
    t0Ns,
    endNs,
    durationMs: Number(endNs - t0Ns) / 1_000_000,
    done: waited.done,
    reason: waited.reason,
    grade,
    capture: captureBetween(ctx, t0Ns, endNs),
    afterEnd: captureRows(ctx).filter((row) => BigInt(row.t_ns) > endNs),
    agents: rule === undefined ? null : agentsAtEnd(),
    stoppedAlone,
    wentOnMs,
    receipts: runReceipts(ctx, notes.rel),
    crashed,
  };
}

function runNotes(
  task: TaskSpec,
  request: TaskRunRequest,
  waited: { done: boolean; reason: string },
  durationMs: number,
  crashed: boolean | null,
): string {
  const app = crashed === null ? "unknown (dry run)" : crashed ? "not running" : "running";
  return [
    `# ${task.id} rep ${request.rep}`,
    "",
    `prompt bytes: ${Buffer.byteLength(request.prompt, "utf8")}`,
    `end: ${waited.done ? "done" : "cap"} (${waited.reason})`,
    `duration_ms: ${Math.round(durationMs)}`,
    `app: ${app}`,
    "",
  ].join("\n");
}

export function captureRows(ctx: TestContext): CaptureRow[] {
  const control = ctx.state.get("capture") as CaptureControl | undefined;
  return control?.rows() ?? [];
}

export function captureBetween(ctx: TestContext, fromNs: bigint, toNs: bigint): CaptureRow[] {
  return captureRows(ctx).filter((row) => BigInt(row.t_ns) >= fromNs && BigInt(row.t_ns) <= toNs);
}

export async function sleepUntil(ctx: TestContext, window: TaskWindow, atMs: number): Promise<void> {
  const remaining = atMs - window.elapsedMs();
  if (remaining > 0) await ctx.instruments.sleep(remaining);
}

export function wallClockSince(ctx: TestContext, sinceNs: bigint): number {
  return Date.now() - Math.max(0, Number(ctx.instruments.now() - sinceNs) / 1_000_000);
}

// ---------- crash check (TESTS.md §4) ----------

export const CRASH_NOTE = "app not running at the end";
export const CRASH_SKIP_NOTE = "dry run: crash check skipped";

// `/Applications/Test.app` owns a process path on a folder boundary, not one named Test.apprentice.
export function matchesPathPrefix(path: string, prefix: string): boolean {
  const clean = prefix.trim().replace(/\/+$/, "");
  if (clean.length === 0) return false;
  return path === clean || path.startsWith(`${clean}/`);
}

// The ADE is alive when one of its bundle or vendor paths owns a running process. With no hint to match,
// a crash cannot be claimed.
export function adeProcessAlive(procs: readonly NativeProc[], prefixes: readonly string[]): boolean {
  const wanted = prefixes.filter((prefix) => prefix.trim().length > 0);
  if (wanted.length === 0) return true;
  return procs.some((proc) => wanted.some((prefix) => matchesPathPrefix(proc.path, prefix)));
}

export function expandHintPath(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

// null means the check was skipped (a dry run has no processes to look at).
export async function adeCrashed(ctx: TestContext): Promise<boolean | null> {
  if (ctx.instruments.dryRun) return null;
  const hints = ctx.adapter.processes();
  const prefixes = [...hints.bundlePaths, ...hints.vendorDirs].map((path) => expandHintPath(path, ctx.adapterCtx.home));
  return !adeProcessAlive(await ctx.instruments.procs(), prefixes);
}

export function crashNote(crashed: boolean | null): string | null {
  if (crashed === null) return CRASH_SKIP_NOTE;
  return crashed ? CRASH_NOTE : null;
}

export function withCrashNote(notes: string, crashed: boolean | null): string {
  const note = crashNote(crashed);
  if (note === null) return notes;
  return notes.length === 0 ? note : `${notes}; ${note}`;
}

// A crash is a reason to run again, even when the hidden tests happened to pass (TESTS.md §4, C1).
export function appCrashed(rows: readonly ResultRow[]): boolean {
  return rows.some((row) => row.notes.includes(CRASH_NOTE));
}

// ---------- grading, handoff codes and tokens ----------

// A grade the grader could not make (hidden tests missing, no handoff codes, a setup error) fails every group. A number
// read from it would publish 0 as if the agent had failed, so every value that comes from the grade is invalid instead.
export function gradeInvalidReason(grade: GradeResult): string | null {
  if (grade.valid) return null;
  return `grade invalid: ${grade.reasons.length > 0 ? grade.reasons.join(", ") : "no reason given"}`;
}

export function groupPassed(grade: GradeResult, id: string): boolean {
  return grade.groups.some((group) => group.id === id && group.total > 0 && group.passed === group.total);
}

export function failedGroups(grade: GradeResult, ids: readonly string[]): string[] {
  return ids.filter((id) => !groupPassed(grade, id));
}

// C1 shipped is 5: W1 (limiter and API), W2, W3, W4 (create and idempotency) and Integration (TESTS.md §4).
export function shippedCount(grade: GradeResult): number {
  const units: ReadonlyArray<readonly string[]> = [
    ["W1-limiter", "W1-api"],
    ["W2-dates"],
    ["W3-cursor"],
    ["W4-create", "W4-idempotency"],
    ["Integration"],
  ];
  return units.filter((unit) => unit.every((id) => groupPassed(grade, id))).length;
}

const WORKERS = ["W1", "W2", "W3", "W4"] as const;

export const CODE_MODULES: Record<keyof HandoffCodes, string> = {
  W1: "src/rate-limiter.ts",
  W2: "src/dates.ts",
  W3: "src/paginate.ts",
  W4: "src/idempotency.ts",
};

// `W<n> | <branch> | <code>` lines of REPORT.md (TESTS.md §4, C1 handoff).
export function handoffCount(report: string, codes: HandoffCodes): number {
  const lines = new Map<string, string[]>();
  for (const line of report.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length >= 3) lines.set(cells[0]!, cells);
  }
  return WORKERS.filter((worker) => lines.get(worker)?.[2] === codes[worker]).length;
}

export function firstLine(path: string): string | null {
  try {
    const line = readFileSync(path, "utf8").split("\n")[0];
    return line === undefined ? null : line.trim();
  } catch {
    return null;
  }
}

export function handoffFrom(worktree: string, codes: HandoffCodes): number {
  let report = "";
  try {
    report = readFileSync(join(worktree, "REPORT.md"), "utf8");
  } catch {
    return 0;
  }
  return handoffCount(report, codes);
}

export function codesPlaced(worktree: string, codes: HandoffCodes): number {
  return WORKERS.filter((worker) => firstLine(join(worktree, CODE_MODULES[worker])) === `// handoff: ${codes[worker]}`)
    .length;
}

export interface RunTokens {
  tokens: number;
  usd: number | null;
  /** Request models with no price in the price file; usd is null while this is not empty. */
  unpriced: string[];
}

export function loadPrices(): PriceFile {
  return JSON.parse(readFileSync(priceFile(), "utf8")) as PriceFile;
}

// Each request is priced by itself, as in Track B (priceRows). On 2026-11-11 the first real C1 had no $ at all: the
// usage of every request of a model was summed first, and a sum has no split of its cache writes by lifetime and no
// long-context rate by request, so priceUsd gave no price for claude-opus-5-5 itself.
export function runTokens(rows: readonly CaptureRow[], prices: PriceFile): RunTokens {
  const usage = sumUsage([...rows]);
  let usd = 0;
  const unpriced = new Set<string>();
  for (const row of rows) {
    if (row.usage === null) continue;
    const model = row.model ?? "unknown";
    const priced = model === "unknown" ? null : priceUsd(pricedUsage(row.usage, row.host), model, prices);
    if (priced === null) unpriced.add(model);
    else usd += priced;
  }
  return {
    tokens: usage.input + usage.cache_write + usage.cache_read + usage.output,
    usd: unpriced.size === 0 ? usd : null,
    unpriced: [...unpriced],
  };
}

// ---------- fan-out ----------

export interface Interval {
  start_ms: number;
  end_ms: number;
}

// Fan-out is the most worker sessions overlapping at once and how many started (TESTS.md §4, C1).
export function fanOut(intervals: readonly Interval[]): { max: number; total: number } {
  const points: Array<{ at: number; delta: number }> = [];
  for (const interval of intervals) {
    points.push({ at: interval.start_ms, delta: 1 }, { at: interval.end_ms, delta: -1 });
  }
  points.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let running = 0;
  let max = 0;
  for (const point of points) {
    running += point.delta;
    if (running > max) max = running;
  }
  return { max, total: intervals.length };
}

// A worker runs in its own git worktree, so its session cwd is one of these (TESTS.md §4, C1).
export function worktreePaths(worktree: string): string[] {
  const paths = [worktree];
  const result = Bun.spawnSync(["git", "-C", worktree, "worktree", "list", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return paths;
  for (const line of result.stdout.toString().split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (path.length > 0 && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function sessionAgentFor(agent: Agent): SessionAgent {
  return agent === "codex" ? "codex" : "claude";
}

export function claudeSessionIntervals(o: { home: string; worktree: string; sinceMs: number }): Interval[] {
  const found = new Map<string, Interval>();
  for (const cwd of worktreePaths(o.worktree)) {
    for (const log of findSessionLogs({ home: o.home, agent: "claude", cwd, since: o.sinceMs })) {
      if (found.has(log.path)) continue;
      let startMs = log.mtimeMs;
      try {
        startMs = Math.min(statSync(log.path).birthtimeMs, log.mtimeMs);
      } catch {
        // A log that vanished keeps its mtime as the interval start.
      }
      found.set(log.path, { start_ms: startMs, end_ms: log.mtimeMs });
    }
  }
  return [...found.values()];
}

// ---------- follow-up delivery (C2) ----------

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function bodyHasText(body: unknown, text: string): boolean {
  const wanted = normalizeText(text);
  if (wanted.length === 0) return false;
  return userTextCandidates(body).some((candidate) => normalizeText(candidate).includes(wanted));
}

export function bodyFileHasText(path: string, text: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  try {
    return bodyHasText(JSON.parse(raw), text);
  } catch {
    return normalizeText(raw).includes(normalizeText(text));
  }
}

// `body_file` is relative to the capture folder (`bodies/0001.json`, bench/capture/addon.py). Until 2026-11-11 C2 read
// it from the working directory, so on a real capture no body was ever found and every follow-up would have counted
// as dropped. `captureDir` is the folder of capture.jsonl; an absolute `body_file` stays as it is.
export function followupDelivered(rows: readonly CaptureRow[], sentAtNs: bigint, text: string, captureDir: string | null = null): boolean {
  return rows.some(
    (row) => row.body_file !== null && BigInt(row.t_ns) >= sentAtNs && bodyFileHasText(captureDir === null ? row.body_file : resolve(captureDir, row.body_file), text),
  );
}

/** The folder of this block's capture.jsonl, where the `body_file` of each row lives. Null with no capture. */
export function captureDirOf(ctx: TestContext): string | null {
  const control = ctx.state.get("capture") as CaptureControl | undefined;
  return control === undefined ? null : dirname(resolve(control.outPath));
}

// ---------- what makes a run unreliable (C1) ----------

/** The saved body of a captured request, or null when it has none or it cannot be read. */
export function bodyTextOf(ctx: TestContext, row: CaptureRow): string | null {
  const dir = captureDirOf(ctx);
  if (dir === null || row.body_file === null) return null;
  try {
    return readFileSync(resolve(dir, row.body_file), "utf8");
  } catch {
    return null;
  }
}

export interface RunCheck {
  /** Why no value of this run can be trusted, or null. */
  problem: string | null;
  /** Why the token and $ totals cannot be trusted, when the run itself can. */
  tokensProblem: string | null;
}

/**
 * 2026-11-11, before the first real C1. Track B learned each of these on 6 and 7 Nov, and a C run checked none of them:
 * a prompt that never reached the agent (T3 Code, Traycer) would have been a valid `shipped 0/5` with 0 tokens, a main
 * thread on another model (bb on claude-opus-5, MonoCode on claude-sonnet-5) a valid result of the wrong model, and a
 * Claude plan at its limit in the middle of the run a valid partial build that says nothing about the app.
 *
 * `prompts` are the texts the main thread may carry, most exact first: the prompt as sent (with the trigger line), then
 * the task alone, for an app that turns the trigger into its own wrapper. The main thread is found as in Track B
 * (classifyMainThread). The run ends on a refusal when the last model request to the main thread's host got a status of
 * 400 or more: after a plan limit or a lost sign-in nothing answers again, while a refusal the client retried is
 * followed by an answer.
 */
export function runCheck(o: {
  rows: readonly CaptureRow[];
  prompts: readonly string[];
  model: string | null | undefined;
  bodyText: (row: CaptureRow) => string | null;
  /** The requests that ended after the end of the run (TaskRun.afterEnd). */
  afterEnd?: readonly CaptureRow[];
  /** The handoff codes of this run: they are in its prompt and in no other text of the capture. */
  codes?: readonly string[];
}): RunCheck {
  const fail = (problem: string): RunCheck => ({ problem, tokensProblem: null });
  const completions = o.rows.filter(isCompletion).sort((a, b) => a.t_ns - b.t_ns);
  if (completions.length === 0) return fail("no model request captured");
  const shapes = new Map<CaptureRow, ThreadShape | null>();
  const shapeOf = (row: CaptureRow): ThreadShape | null => {
    if (!shapes.has(row)) {
      const text = o.bodyText(row);
      let shape: ThreadShape | null = null;
      try {
        shape = text === null ? null : threadShape(JSON.parse(text));
      } catch {
        shape = null;
      }
      shapes.set(row, shape);
    }
    return shapes.get(row)!;
  };
  let main: CaptureRow[] = [];
  for (const prompt of o.prompts) {
    main = classifyMainThread(completions, prompt, shapeOf).filter((row) => row.main_thread === true);
    if (main.length > 0) break;
  }
  // An app can send the prompt in a form no text match finds. On 2026-11-11 Synara wrapped the pasted prompt as
  // `<pasted_text>[{"text":"..."}]`, a JSON string with its newlines escaped, and a run of 5 agents read as "the prompt
  // never reached the model". The handoff codes of the run are plain words in any such form: the first request that
  // starts a turn with tools and carries one is the lead. A title call carries the prompt too, with no tools.
  if (main.length === 0 && (o.codes ?? []).length > 0) {
    const lead = completions.find((row) => {
      const shape = shapeOf(row);
      if (shape === null || shape.tools === 0 || !shape.startsTurn || row.status >= 400) return false;
      const text = o.bodyText(row) ?? "";
      return o.codes!.some((code) => text.includes(code));
    });
    if (lead !== undefined) main = [lead];
  }
  if (main.length === 0) return fail("the prompt never reached the model: no main-thread request captured");
  if (main.every((row) => row.status >= 400)) return fail("the turn failed");
  const wrong = o.model ? main.find((row) => row.model !== null && row.model !== o.model) : undefined;
  if (wrong !== undefined) return fail(`wrong model: ${wrong.model}`);
  // A request whose last user message answers a tool is an agent in the middle of its work. A title, a quota call and a
  // suggestion call each start a turn of their own, and they do follow a real end. The tool list does not decide it: a
  // client that continues a thread sends none (Diri, 7 Nov). Checked on the captures of 6 and 7 Nov: of 93 turns with a
  // known end in 25 captures, a tool answer followed only where the same turn was still going (Diri's B3).
  const working = (o.afterEnd ?? []).filter(isCompletion).filter((row) => shapeOf(row)?.startsTurn === false);
  if (working.length > 0) return fail(`the run went on after the end of turn that ended the test: ${working.length} tool answers after it`);
  // Only requests to the host of the main thread: on 6 and 7 Nov Cloudroom and bb also asked chatgpt.com for a Codex
  // answer (`/backend-api/codex/responses`) and got 401 each time, because the bench account has no Codex sign-in. Such
  // a refusal at the end says nothing about the run.
  const hosts = new Set(main.map((row) => row.host));
  const last = completions.filter((row) => hosts.has(row.host)).at(-1)!;
  if (last.status >= 400) return fail(`the run ended on a refused request (status ${last.status}): the Claude plan or the sign-in`);
  return { problem: null, tokensProblem: completions.some(lacksUsage) ? "a call has no usage" : null };
}

// ---------- resume watch (C4-C6) ----------

export const RESUME_POLL_MS = 2_000;

export function changeMark(o: { worktree: string; home: string; agent: SessionAgent; sinceMs: number }): number | null {
  let mark = newestChangeMs(o.worktree);
  for (const log of findSessionLogs({ home: o.home, agent: o.agent, cwd: o.worktree, since: o.sinceMs })) {
    mark = mark === null ? log.mtimeMs : Math.max(mark, log.mtimeMs);
  }
  return mark;
}

// Resumed = the session log or the files under the worktree changed in the window (TESTS.md §4, C4-C6).
export async function watchResume(
  ctx: TestContext,
  o: { worktree: string; sinceNs: bigint; windowS: number },
): Promise<boolean> {
  const probe = {
    worktree: o.worktree,
    home: ctx.adapterCtx.home,
    agent: sessionAgentFor(ctx.options.agent),
    sinceMs: wallClockSince(ctx, o.sinceNs),
  };
  const before = changeMark(probe);
  // A dry run changes nothing, so its window would only burn real time.
  if (ctx.instruments.dryRun) return false;
  const started = ctx.instruments.now();
  while (Number(ctx.instruments.now() - started) / 1_000_000 < o.windowS * 1_000) {
    await ctx.instruments.sleep(RESUME_POLL_MS);
    const mark = changeMark(probe);
    if (mark !== null && (before === null || mark > before)) return true;
  }
  return false;
}

// ---------- survival (C4-C6) ----------

export type Survival = "pass" | "partial" | "fail";

export const SURVIVAL_VALUE: Record<Survival, number> = { pass: 2, partial: 1, fail: 0 };

export function survivalOutcome(o: { completed: boolean; everyGroupPassed: boolean; manualAction: boolean }): Survival {
  if (!o.completed) return "fail";
  if (o.everyGroupPassed && !o.manualAction) return "pass";
  return "partial";
}

export interface FaultTestSpec {
  testId: TestId;
  taskId: string;
  /** Every row of this test, in order; the first one is the headline. */
  variants: readonly string[];
  units: Record<string, string>;
  /** An extra fact for every row. */
  note?: string;
}

// C4, C5 and C6 share one procedure: the fault, the resume window, one manual continue if needed, then grade.
export function faultTestRunner(spec: FaultTestSpec): TestRunner {
  return {
    id: spec.testId,
    track: "C",
    repeats: () => 1,
    maxExtraRuns: 1,
    needsExtraRun: (rows) => rows.some((row) => row.variant === "survival" && row.value === SURVIVAL_VALUE.fail),
    runRep: async (ctx, rep) => {
      const task = loadTask(spec.taskId);
      const fault = task.faults[0];
      if (fault === undefined) return invalidRows(ctx, spec, rep, "no fault in task.toml", emptyReceipts());
      return runFaultTest(ctx, spec, task, fault, rep);
    },
  };
}

async function runFaultTest(
  ctx: TestContext,
  spec: FaultTestSpec,
  task: TaskSpec,
  fault: Fault,
  rep: number,
): Promise<ResultRow[]> {
  // TESTS.md §1.6: after the restart the harness returns to the thread. Without a calibrated return the manual
  // `continue` would land in whatever thread the app shows, so the run would not measure this thread's survival.
  if (fault.kind === "restart-app" && ctx.adapter.returnToThread === undefined) {
    return invalidRows(ctx, spec, rep, "not calibrated: returnToThread", emptyReceipts());
  }
  let outcome: FaultOutcome | null = null;
  let resumed = false;
  let manualAction = false;
  const run = await runTask(ctx, {
    taskId: spec.taskId,
    label: `${spec.testId}-${rep}`,
    rep,
    prompt: task.prompt,
    schedule: async (c, window) => {
      await sleepUntil(c, window, fault.at_s * 1_000);
      const applied =
        fault.kind === "restart-app"
          ? await restartAndReturn(c, fault, window.worktree)
          : await c.instruments.fault(fault, {
              worktree: window.worktree,
              appName: c.adapter.calibration.appName,
              agentExecutables: c.adapter.processes().agentExecutables,
            });
      outcome = applied;
      // Not applied: nothing was interrupted, so there is nothing to watch or continue.
      if (!applied.applied) return;
      await screenshot(c, spec.testId, rep, "fault");
      resumed = await watchResume(c, {
        worktree: window.worktree,
        sinceNs: applied.ended_ns,
        windowS: task.recovery?.wait_s ?? 60,
      });
      if (!resumed) {
        manualAction = true;
        await c.adapter.send(c.adapterCtx, task.recovery?.message ?? "continue");
        await screenshot(c, spec.testId, rep, "manual-continue");
      }
    },
  });

  const faultOutcome = outcome as FaultOutcome | null;
  // C4: an ADE with no separate agent process is not applicable, published as a note (TESTS.md §4).
  if (faultOutcome === null || (fault.kind === "kill-agent" && (!faultOutcome.applied || killedNoAgent(faultOutcome)))) {
    return nullRows(ctx, spec, rep, "not applicable: no separate agent process", run);
  }
  if (!faultOutcome.applied) {
    return invalidRows(ctx, spec, rep, `fault not applied: ${faultOutcome.detail}`, run.receipts);
  }

  const group = task.grade_groups[0] ?? "W3-cursor";
  const gradeReason = gradeInvalidReason(run.grade);
  // A crashed ADE cannot have survived, whatever waitDone's idle fallback reported (TESTS.md §4, C4-C6).
  const survival = survivalOutcome({
    completed: run.done && run.crashed !== true,
    everyGroupPassed: groupPassed(run.grade, group),
    manualAction,
  });
  const notes = withCrashNote(
    [
      survival,
      spec.note,
      `fault ${faultOutcome.kind}: ${faultOutcome.detail}`,
      resumed ? "resumed on its own" : "no resume in the window",
    ]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("; "),
    run.crashed,
  );

  const values: Record<string, number> = {
    survival: SURVIVAL_VALUE[survival],
    resumed: resumed ? 1 : 0,
    "manual-continue": manualAction ? 1 : 0,
  };
  return spec.variants.map((variant) =>
    // Survival needs the grade; resumed and manual-continue are what the harness saw, and stay.
    variant === "survival" && gradeReason !== null
      ? invalidRow(
          ctx,
          {
            test_id: spec.testId,
            variant,
            rep,
            server: "live",
            unit: spec.units[variant] ?? "survival",
            duration_ms: run.durationMs,
            receipts: run.receipts,
            notes,
          },
          gradeReason,
        )
      : ctx.row({
          test_id: spec.testId,
          variant,
          rep,
          server: "live",
          value: values[variant]!,
          unit: spec.units[variant] ?? "survival",
          duration_ms: run.durationMs,
          valid: true,
          invalid_reason: null,
          receipts: run.receipts,
          notes,
        }),
  );
}

// C6: the restart, then the app open again with its new pid, then the interrupted thread selected (TESTS.md §1.6).
// launch() is the reopen A2 uses: it waits for the new pid, sets the window and keeps the open project.
export async function restartAndReturn(ctx: TestContext, fault: Fault, worktree: string): Promise<FaultOutcome> {
  let outcome: FaultOutcome;
  if (ctx.adapter.hostStaysOpen === true) {
    // The control's host is Ghostty, and a quit by app name reaches every Ghostty, the one that hosts ADEMark Control
    // too (2026-11-09, control-2026-11-09T04-18-06Z-bare-cli-2). Its quit is ADES.md 3.0's: close every CLI tab.
    const started = ctx.instruments.now();
    await ctx.adapter.quit(ctx.adapterCtx);
    outcome = {
      kind: fault.kind,
      applied: true,
      started_ns: started,
      ended_ns: ctx.instruments.now(),
      detail: "host stays open: quit() closed the CLI tabs",
    };
  } else {
    outcome = await ctx.instruments.fault(fault, {
      worktree,
      appName: ctx.adapter.calibration.appName,
      agentExecutables: ctx.adapter.processes().agentExecutables,
    });
    if (!outcome.applied) return outcome;
  }
  const { pid } = await ctx.adapter.launch(ctx.adapterCtx);
  ctx.state.set("launch_pid", pid);
  await ctx.adapter.returnToThread!(ctx.adapterCtx);
  return { ...outcome, ended_ns: ctx.instruments.now(), detail: `${outcome.detail}; returned to the thread` };
}

// The kill-agent outcome names the pids it killed; `pids=none` means the ADE runs the agent in-process.
export function killedNoAgent(outcome: FaultOutcome): boolean {
  if (outcome.kind !== "kill-agent") return false;
  const match = outcome.detail.match(/pids=(.*)$/);
  if (match === null) return false;
  const pids = match[1]!.trim();
  return pids.length === 0 || pids === "none";
}

// Every row of one fault test with no value, for a result that is a fact about the ADE, not a measurement.
function nullRows(
  ctx: TestContext,
  spec: FaultTestSpec,
  rep: number,
  note: string,
  run: { durationMs: number; receipts: Receipts },
): ResultRow[] {
  return spec.variants.map((variant) =>
    ctx.row({
      test_id: spec.testId,
      variant,
      rep,
      server: "live",
      value: null,
      unit: spec.units[variant] ?? "survival",
      duration_ms: run.durationMs,
      valid: true,
      invalid_reason: null,
      receipts: run.receipts,
      notes: note,
    }),
  );
}

function invalidRows(ctx: TestContext, spec: FaultTestSpec, rep: number, reason: string, receipts: Receipts): ResultRow[] {
  return spec.variants.map((variant) =>
    invalidRow(
      ctx,
      {
        test_id: spec.testId,
        variant,
        rep,
        server: "live",
        unit: spec.units[variant] ?? "survival",
        duration_ms: 0,
        receipts,
        notes: spec.note ?? "",
      },
      reason,
    ),
  );
}
