// Shared rules for the Track B token tests (TESTS.md §3): capture window, split, pricing and cross-checks.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { Agent, CapturedUsage, CaptureRow, ProcessHints, Receipts, ResultRow, TaskSpec, TestId } from "../../core/contracts.ts";
import { priceFile } from "../../core/paths.ts";
import { splitUsage, totalComponents, priceUsd, pricedUsage, priceRows, splitComponents, classifyMainThread, isCompletion, lacksUsage, threadShape, type PriceFile, type ThreadShape } from "../../capture/tokens.ts";
import { diffSnapshots, parseNettopCsv, reconcile, type NettopRow } from "../../capture/nettop.ts";
import { addUsage, findSessionLogs, type SessionSummary } from "../../adapters/session-log.ts";
import type { CaptureControl } from "../../run/instruments.ts";
import { receipt } from "../../run/kit.ts";
import type { TestContext } from "../../run/context.ts";
import { agentProcessNames } from "../../core/agents.ts";

export const SIDE_CALL_WAIT_MS = 30_000;
export const SESSION_GAP = 0.02;
export const PROMPT_START_WAIT_MS = 25_000;
const PROMPT_START_POLL_MS = 1000;
export const REPO_RULES_CANARY = "End every final answer with the line ledger-ok.";

export interface RepWindow {
  start_ns: number;
  end_ns: number;
  start_ms: number;
}

export interface RepCapture {
  rep: number;
  window: RepWindow;
  main: CaptureRow[];
  side: CaptureRow[];
  firstMainRow: CaptureRow | null;
  firstBodyFile: string | null;
  sessionIds: string[];
  lastText: string | null;
  toolCalls: number | null;
  hasSessionLog: boolean;
  logUsage: CapturedUsage | null;
  logModel: string | null;
  incomplete: boolean;
  /** The turn never finished, or every main call failed: its tokens are unknown, not zero. */
  failedTurn: boolean;
  /** The model the main thread really used, when it is not the model of the run: the rows would not compare. */
  wrongModel: string | null;
  /** The effort the main thread really sent, when it is not the effort of the run. */
  wrongEffort: string | null;
  /** A continuation with no known parent: main and side cannot be told apart. */
  unresolvedThread: boolean;
  /** The session log and the captured main thread disagree, so one of them misses or adds a call. */
  logMismatch: boolean;
  /** Two requests started a turn on the prompt, so the tokens are double. */
  promptTwice: boolean;
  durationMs: number;
  notes: string[];
}

const NO_USAGE: CapturedUsage = { input: 0, cache_write: 0, cache_read: 0, output: 0 };

function isCaptureControl(value: unknown): value is CaptureControl {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CaptureControl>;
  return typeof candidate.outPath === "string" && typeof candidate.rows === "function";
}

export function captureFor(ctx: TestContext): CaptureControl {
  const capture = ctx.state.get("capture");
  if (!isCaptureControl(capture)) throw new Error("Track B needs a capture control in ctx.state");
  return capture;
}

export function captureReceipt(ctx: TestContext, capture: CaptureControl): string {
  return relative(ctx.runDir, capture.outPath).split(sep).join("/");
}

export function windowRows(rows: readonly CaptureRow[], startNs: number, endNs: number): CaptureRow[] {
  return rows.filter((row) => row.t_ns >= startNs && row.t_ns <= endNs);
}

export function nettopSnapshot(): NettopRow[] {
  const result = Bun.spawnSync(["nettop", "-P", "-L", "1", "-x", "-J", "bytes_in,bytes_out"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`nettop failed: ${result.stderr.toString().trim().slice(0, 200)}`);
  }
  return parseNettopCsv(result.stdout.toString());
}

// Process names as nettop prints them: the bundle name without .app, and each agent executable.
export function adeProcessNames(hints: ProcessHints): string[] {
  const names = new Set<string>();
  for (const path of hints.bundlePaths) {
    const base = basename(path);
    names.add(base.endsWith(".app") ? base.slice(0, -4) : base);
  }
  for (const name of agentProcessNames(hints.agentExecutables)) names.add(name);
  return [...names];
}

export function adeBytesOut(deltas: readonly NettopRow[], hints: ProcessHints): number {
  const names = adeProcessNames(hints);
  let bytes = 0;
  for (const row of deltas) {
    const name = row.process.trim();
    if (!names.some((candidate) => name === candidate || name.startsWith(`${candidate} `))) continue;
    bytes += row.bytes_out;
  }
  return bytes;
}

export function sessionGap(captureTotal: number, logTotal: number): number | null {
  if (logTotal <= 0) return null;
  return Math.abs(captureTotal - logTotal) / logTotal;
}

export function readPrices(): PriceFile {
  return JSON.parse(readFileSync(priceFile(), "utf8")) as PriceFile;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotOrNote(notes: string[]): NettopRow[] | null {
  try {
    return nettopSnapshot();
  } catch (error) {
    notes.push(`nettop failed: ${messageOf(error)}`);
    return null;
  }
}

function sumSessionUsage(summaries: readonly SessionSummary[]): CapturedUsage {
  const total: CapturedUsage = { ...NO_USAGE };
  for (const summary of summaries) addUsage(total, summary.usage);
  return total;
}

function sessionAgentFor(agent: Agent): "claude" | "codex" | null {
  return agent === "claude" || agent === "codex" ? agent : null;
}

function completenessNote(notes: string[], ctx: TestContext, before: NettopRow[] | null, rows: CaptureRow[]): void {
  const after = snapshotOrNote(notes);
  if (before === null || after === null) return;
  const adeBytes = adeBytesOut(diffSnapshots(before, after), ctx.adapter.processes());
  const capturedBytes = rows.reduce((sum, row) => sum + row.req_bytes, 0);
  const result = reconcile(adeBytes, capturedBytes);
  if (!result.within5pct) notes.push("nettop differs from capture");
}

function crossCheck(notes: string[], capture: RepCapture): boolean {
  if (capture.logUsage === null) return false;
  const gap = sessionGap(totalComponents(splitUsage(capture.main).main), totalComponents(capture.logUsage));
  if (gap === null || gap <= SESSION_GAP) return false;
  notes.push(`session log gap ${(gap * 100).toFixed(1)}%`);
  return true;
}

function shapeFromBody(capture: CaptureControl, row: CaptureRow): ThreadShape | null {
  if (row.body_file === null) return null;
  try {
    return threadShape(JSON.parse(readBodyText(capture, row.body_file)));
  } catch {
    return null;
  }
}

function wrongEffortOf(capture: CaptureControl, main: readonly CaptureRow[], effort: string | null | undefined): string | null {
  if (!effort) return null;
  for (const row of main) {
    if (row.body_file === null) continue;
    try {
      const sent = (JSON.parse(readBodyText(capture, row.body_file)) as { output_config?: { effort?: unknown } }).output_config?.effort;
      if (typeof sent === "string" && sent !== effort) return sent;
    } catch {
      continue;
    }
  }
  return null;
}

function wrongModelOf(main: readonly CaptureRow[], model: string | null | undefined): string | null {
  if (!model) return null;
  return main.find((row) => row.model !== null && row.model !== model)?.model ?? null;
}

// Keys sent before an app is ready are lost with no error, so the prompt goes again. A lost prompt spent nothing. A slow one
// that was only late runs twice, and `promptTwice` then makes the repetition invalid instead of doubling its tokens.
export async function promptLeft(ctx: Pick<TestContext, "instruments">, capture: CaptureControl, sinceNs: number): Promise<boolean> {
  if (capture.requestsSince === undefined) return true;
  const left = (): boolean => capture.requestsSince!(sinceNs) > 0 || capture.rows().some((row) => row.t_ns >= sinceNs && isCompletion(row));
  for (let waited = 0; waited < PROMPT_START_WAIT_MS; waited += PROMPT_START_POLL_MS) {
    if (left()) return true;
    await ctx.instruments.sleep(PROMPT_START_POLL_MS);
  }
  return left();
}

// A first send that was only late can still be running, with no answer to count, so requests are compared as they left.
function ranTwice(capture: CaptureControl, classified: readonly CaptureRow[], startNs: number): boolean {
  const starts = classified.filter((row) => row.starts_turn === true);
  if (starts.length !== 1) return starts.length > 1;
  const shape = shapeFromBody(capture, starts[0]!);
  const task = shape?.taskHashes.at(-1);
  return task !== undefined && (capture.startsSince?.(startNs, `${task}:${shape!.tools}`) ?? 0) > 1;
}

// Runs one prompt repetition: new thread, send, wait, then 30 s for side calls (TESTS.md §3).
export async function runPromptRep(
  ctx: TestContext,
  task: TaskSpec,
  rep: number,
  capture: CaptureControl,
): Promise<RepCapture> {
  const notes: string[] = [];
  const before = ctx.instruments.dryRun ? null : snapshotOrNote(notes);
  const startMs = Date.now();
  const startNs = Number(ctx.instruments.now());
  // Tests build their fixture rows from this window, so share it through state.
  ctx.state.set("B.window.start_ns", startNs);
  await ctx.adapter.newThread(ctx.adapterCtx);
  await ctx.adapter.send(ctx.adapterCtx, task.prompt);
  if (!ctx.instruments.dryRun && !(await promptLeft(ctx, capture, startNs))) {
    notes.push("the prompt never left the app, so it was sent again");
    await ctx.adapter.newThread(ctx.adapterCtx);
    await ctx.adapter.send(ctx.adapterCtx, task.prompt);
  }
  const done = await ctx.adapter.waitDone(ctx.adapterCtx, task.time_cap_s * 1000);
  await ctx.instruments.sleep(SIDE_CALL_WAIT_MS);
  const endNs = Number(ctx.instruments.now());
  ctx.state.set("B.window.end_ns", endNs);
  if (!done.done) notes.push(`turn not done: ${done.reason}`);

  const rows = windowRows(capture.rows(), startNs, endNs);
  const completions = rows.filter(isCompletion);
  const classified = classifyMainThread(completions, task.prompt, (row) => shapeFromBody(capture, row));
  const main = classified.filter((row) => row.main_thread === true);
  const side = classified.filter((row) => row.main_thread !== true);
  const orderedMain = [...main].sort((a, b) => a.t_ns - b.t_ns);
  const firstMainRow = orderedMain.find((row) => row.body_file !== null) ?? orderedMain[0] ?? null;

  const unknownUsage = completions.some(lacksUsage);
  if (unknownUsage) notes.push("a call has no usage");
  // nettop counts all the app's traffic, also what is not a model, so it can note a difference but never decide one.
  if (!ctx.instruments.dryRun) completenessNote(notes, ctx, before, rows);
  const incomplete = !ctx.instruments.dryRun && unknownUsage;

  const sessionAgent = sessionAgentFor(ctx.options.agent);
  let summary: SessionSummary | null = null;
  let logUsage: CapturedUsage | null = null;
  let toolCalls: number | null = null;
  let sessionIds: string[] = [];
  let logModels: string[] = [];
  if (sessionAgent !== null) {
    // A title session can share the folder: only the session that got the prompt is the test's.
    const logs = findSessionLogs({
      home: ctx.adapterCtx.home,
      agent: sessionAgent,
      cwd: ctx.adapterCtx.worktree,
      since: startMs,
    }).filter((log) => sessionAgent !== "claude" || log.summary.userTexts.some((text) => text.trim().endsWith(task.prompt.trim())));
    if (logs.length === 0) {
      notes.push("no session log");
    } else {
      logUsage = sumSessionUsage(logs.map((log) => log.summary));
      summary = logs.find((log) => log.summary.lastText !== null)?.summary ?? logs[0]!.summary;
      toolCalls = logs.reduce((sum, log) => sum + log.summary.toolCalls, 0);
      sessionIds = logs.flatMap((log) => (log.summary.sessionId === null ? [] : [log.summary.sessionId]));
      logModels = [...new Set(logs.flatMap((log) => log.summary.models))];
    }
  }

  const result: RepCapture = {
    rep,
    window: { start_ns: startNs, end_ns: endNs, start_ms: startMs },
    main,
    side,
    firstMainRow,
    firstBodyFile: firstMainRow?.body_file ?? null,
    sessionIds,
    lastText: summary?.lastText ?? null,
    toolCalls,
    hasSessionLog: summary !== null,
    logUsage,
    // One aggregate cannot be priced at one model's rates when two models wrote it.
    logModel: logModels.length > 1 ? null : (summary?.model ?? null),
    incomplete,
    failedTurn: !ctx.instruments.dryRun && (!done.done || (main.length > 0 && main.every((row) => row.status >= 400))),
    wrongModel: wrongModelOf(main, ctx.options.model),
    wrongEffort: wrongEffortOf(capture, main, ctx.options.effort),
    unresolvedThread: classified.some((row) => row.thread_unresolved === true),
    logMismatch: false,
    promptTwice: ranTwice(capture, classified, startNs),
    durationMs: Math.max(0, Math.round((endNs - startNs) / 1_000_000)),
    notes,
  };
  if (main.length === 0) {
    notes.push(logUsage === null ? "no main-thread request captured" : "from session log, capture empty");
  } else if (incomplete && logUsage !== null) {
    notes.push("tokens from session log");
  }
  result.logMismatch = main.length > 0 && !incomplete && crossCheck(notes, result);
  // The log can stand in for the capture, so its model has to pass the same check.
  if (usesSessionLog(result)) {
    const pin = ctx.options.model;
    result.wrongModel ??= logModels.find((model) => pin && model !== pin) ?? null;
  }
  return result;
}

export function storeRep(ctx: TestContext, testId: "B1" | "B3", capture: RepCapture): void {
  const key = `${testId}.${ctx.options.agent}.reps`;
  const reps = (ctx.state.get(key) as RepCapture[] | undefined) ?? [];
  reps.push(capture);
  ctx.state.set(key, reps);
}

export function repsFor(ctx: TestContext, testId: "B1" | "B3"): RepCapture[] {
  return (ctx.state.get(`${testId}.${ctx.options.agent}.reps`) as RepCapture[] | undefined) ?? [];
}

export interface ComponentValues {
  "fresh-input": number;
  "cache-write": number;
  "cache-read": number;
  output: number;
  "side-tokens": number;
}

export const TOKEN_COMPONENTS = ["fresh-input", "cache-write", "cache-read", "output", "side-tokens"] as const;

function loggedComponents(usage: CapturedUsage, agent: Agent): CapturedUsage {
  return pricedUsage(usage, agent === "codex" ? "api.openai.com" : "api.anthropic.com");
}

// An empty main-thread capture and an incomplete one both fall back to the session log (TESTS.md B1).
export function usesSessionLog(capture: RepCapture): boolean {
  return capture.logUsage !== null && (capture.main.length === 0 || capture.incomplete);
}

export function repComponents(capture: RepCapture, agent: Agent): ComponentValues {
  const split = splitComponents([...capture.main, ...capture.side]);
  if (usesSessionLog(capture)) {
    const fromLog = loggedComponents(capture.logUsage!, agent);
    return {
      "fresh-input": fromLog.input,
      "cache-write": fromLog.cache_write,
      "cache-read": fromLog.cache_read,
      output: fromLog.output,
      "side-tokens": totalComponents(split.side),
    };
  }
  return {
    "fresh-input": split.main.input,
    "cache-write": split.main.cache_write,
    "cache-read": split.main.cache_read,
    output: split.main.output,
    "side-tokens": totalComponents(split.side),
  };
}

export function repUsd(capture: RepCapture, agent: Agent, prices: PriceFile): { usd: number | null; missingModel: string | null } {
  if (!usesSessionLog(capture)) {
    return priceRows([...capture.main, ...capture.side], prices);
  }
  // The long-context rate goes by request, and a log total cannot say which requests passed it.
  if (prices.models[capture.logModel ?? ""]?.long_context !== undefined) return { usd: null, missingModel: capture.logModel };
  const mainPrice = priceUsd(loggedComponents(capture.logUsage!, agent), capture.logModel ?? "", prices);
  if (mainPrice === null) return { usd: null, missingModel: capture.logModel ?? "unknown" };
  const side = priceRows(capture.side, prices);
  if (side.usd === null) return side;
  return { usd: mainPrice + side.usd, missingModel: null };
}

export function noteLine(notes: readonly string[]): string {
  return notes.join("; ");
}

export function writeRepNotes(ctx: TestContext, testId: TestId, rep: number, capture: RepCapture): string {
  const file = receipt(ctx, testId, rep, "notes.md");
  const lines = [
    `# ${testId} rep ${rep}`,
    `window: ${capture.window.start_ns} -> ${capture.window.end_ns} ns`,
    `main requests: ${capture.main.length}`,
    `side requests: ${capture.side.length}`,
    `session ids: ${capture.sessionIds.join(", ") || "none"}`,
    `tool calls: ${capture.toolCalls ?? "unknown"}`,
    `last text: ${capture.lastText ?? "none"}`,
    ...capture.notes,
  ];
  writeFileSync(file.abs, `${lines.join("\n")}\n`);
  return file.rel;
}

// What makes every row of a repetition unreliable, the token rows and the counts alike.
export function repProblem(capture: RepCapture): string | null {
  if (capture.failedTurn) return "the turn failed";
  if (capture.wrongModel !== null) return `wrong model: ${capture.wrongModel}`;
  if (capture.wrongEffort) return `wrong effort: ${capture.wrongEffort}`;
  if (capture.unresolvedThread) return "a continuation has no known parent";
  if (capture.logMismatch) return "capture and session log disagree";
  if (capture.promptTwice) return "the prompt ran twice";
  return null;
}

// B2 and B4 read their evidence from B1 and B3. A rep on another model, or one whose main thread is in doubt, would carry
// its fault into them: on 2026-11-07 MonoCode's B2 and B4 rows were valid while every B1 rep ran claude-sonnet-5.
export function soundReps(reps: readonly RepCapture[]): RepCapture[] {
  return reps.filter((capture) => repProblem(capture) === null);
}

export function tokenRowSet(
  ctx: TestContext,
  testId: TestId,
  rep: number,
  capture: RepCapture,
  prices: PriceFile,
  receipts: Receipts,
): ResultRow[] {
  const components = repComponents(capture, ctx.options.agent);
  const priced = repUsd(capture, ctx.options.agent, prices);
  // TESTS.md B1: no captured request is never a zero; an incomplete capture needs a session log too.
  const empty = capture.main.length === 0;
  const usable = empty ? capture.logUsage !== null : !capture.incomplete || capture.logUsage !== null;
  // A session log can stand in for main calls, not for a side call the proxy could not read.
  const unknownSide = capture.side.some(lacksUsage);
  const problem = repProblem(capture);
  const unusable = !usable || unknownSide || problem !== null;
  const invalidReason = problem ?? (unknownSide ? "a side call has no usage" : unusable ? (empty ? "no main-thread request captured" : "capture incomplete") : null);
  const componentNotes = noteLine(capture.notes);
  const usdNotes = noteLine(priced.missingModel === null ? capture.notes : [...capture.notes, `price missing for ${priced.missingModel}`]);
  const rows: ResultRow[] = TOKEN_COMPONENTS.map((variant) =>
    ctx.row({
      test_id: testId,
      variant,
      rep,
      server: "live",
      value: unusable ? null : components[variant],
      unit: "tokens",
      duration_ms: capture.durationMs,
      valid: !unusable,
      invalid_reason: invalidReason,
      receipts,
      notes: componentNotes,
    }),
  );
  rows.push(
    ctx.row({
      test_id: testId,
      variant: "usd",
      rep,
      server: "live",
      value: unusable ? null : priced.usd,
      unit: "USD",
      duration_ms: capture.durationMs,
      valid: !unusable && priced.usd !== null,
      invalid_reason: invalidReason ?? (priced.usd === null ? "price missing" : null),
      receipts,
      notes: usdNotes,
    }),
  );
  return rows;
}

export function readBodyText(capture: CaptureControl, bodyFile: string): string {
  const base = resolve(dirname(capture.outPath));
  const path = resolve(base, bodyFile);
  if (!path.startsWith(`${base}${sep}`)) throw new Error(`body file escapes the capture folder: ${bodyFile}`);
  return readFileSync(path, "utf8");
}

export function containsCanary(text: string): boolean {
  return text.includes(REPO_RULES_CANARY);
}

export function lastNonEmptyLine(text: string | null): string | null {
  if (text === null) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? null : lines[lines.length - 1]!;
}
