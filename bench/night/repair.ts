// Self-repair (METHODOLOGY.md §5): after the night's end-of-run retry, an agent repairs how a failed ADE is driven and
// the ADE is measured again in full. The agent runs only between blocks and may change only that ADE's driving files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NOT_SUPPORTED } from "../calibrate/pass.ts";
import type { Agent, ResultRow } from "../core/contracts.ts";
import type { BlockResult } from "../run/loop.ts";
import type { TrackLetter } from "../run/registry.ts";
import { KNOWN_FAILURES } from "./known-failures.ts";

export const MAX_ATTEMPTS = 2;
export const DEFAULT_REPAIR_MINUTES = 180;
export const AGENT_TIMEOUT_MS = 45 * 60_000;
export const REPAIRS_DIR = "repairs";
const MAX_RECEIPTS = 30;
/** What a run publishes of an attempt. `agent.jsonl` stays private: it can show account names from a sign-in screen. */
export const PUBLIC_REPAIR_FILES = ["diff.patch", "result.json"] as const;

export type RepairResult =
  | "repaired"
  | "rejected"
  | "no change"
  | "still failing"
  | "needs a human"
  | "not clean"
  | "unfinished"
  | "agent failed"
  | "plan limit"
  | "tampered";

export interface RepairAttempt {
  ade: string;
  attempt: number;
  result: RepairResult;
  minutes: number;
  commit: string | null;
  diff: string | null;
  note: string;
}

export interface AgentExit {
  ok: boolean;
  note: string;
}

export interface RepairDeps {
  now(): number;
  out(line: string): void;
  head(): string;
  /** Uncommitted files now. A repair starts only from a clean tree, so a revert can lose nothing else. */
  dirty(): string[];
  /** Files changed since `before`, committed or not. */
  changedPaths(before: string): string[];
  /** One hash of the git-ignored files that measure: the native helper and the clean snapshot. */
  measuringInputs(): string;
  /** Why the harness no longer loads, or null. A broken adapter would break every later child. */
  validate(): string | null;
  revert(before: string): void;
  /** Commits whatever the agent left uncommitted among the allowed paths. */
  commit(paths: readonly string[], message: string): void;
  writeDiff(before: string, path: string): void;
  quitAde(ade: string): Promise<void>;
  clearHarnessEnv(): void;
  runAgent(o: { prompt: string; logPath: string; timeoutMs: number }): Promise<AgentExit>;
  /** Stops what the repair left and returns what is still alive. Measuring needs an empty list. */
  cleanUp(ade: string): Promise<string[]>;
  waitQuiet(): Promise<void>;
  supersede(o: { runDir: string; ade: string; tracks: readonly TrackLetter[]; agents?: readonly Agent[]; attempt: number }): void;
  remeasure(o: { ade: string; runId: string; seed: string; tracks: readonly TrackLetter[]; agents?: readonly Agent[] }): Promise<boolean>;
  readRows(runDir: string): ResultRow[];
}

export interface RepairOptions {
  runDir: string;
  runId: string;
  seed: string;
  tracks: readonly TrackLetter[];
  agents?: readonly Agent[];
  order: readonly string[];
  blocks: readonly BlockResult[];
  deadline: number | null;
  budgetMs: number;
  template: string;
  deps: RepairDeps;
  /** Called after each attempt, so a Ctrl-C keeps the attempts that already ended. */
  onAttempt?: (attempt: RepairAttempt) => void;
  /** True once a person pressed Stop: no new attempt starts. */
  cancelled?: () => boolean;
}

/** What the agent left behind, before anything is measured again. */
type AgentResult =
  | { kind: "ended"; attempt: RepairAttempt }
  | { kind: "changed"; after: string; diff: string | null; finish: FinishAttempt };

type FinishAttempt = (result: RepairResult, note: string, commit?: string | null, diff?: string | null) => RepairAttempt;

/** The part of an attempt that the night and `ademark prepare` share. */
export interface AgentAttemptOptions {
  runDir: string;
  runId: string;
  ade: string;
  attempt: number;
  tracks: readonly TrackLetter[];
  agents?: readonly Agent[];
  failures: readonly string[];
  template: string;
  deps: RepairDeps;
  cancelled?: () => boolean;
}

export function allowedPaths(ade: string): string[] {
  return [`bench/adapters/profiles/${ade}.json`, `bench/adapters/gates/${ade}.json`, `bench/adapters/${ade}.ts`];
}

function belongsTo(rowAde: string, ade: string): boolean {
  return rowAde === ade || rowAde.startsWith(`${ade}-`);
}

// A gate or a version mismatch is the machine's state, not how the ADE is driven: an agent cannot repair it.
function repairableBlockError(error: string | null): boolean {
  return !(error ?? "").startsWith("gates:") && !(error ?? "").startsWith("install check:");
}

// TESTS.md: adaptive outputs need six valid runs. A test can stop at three valid of six, which passes the half rule.
const MIN_VALID: Record<string, number> = { "A1 cold": 6, "A2 relaunch": 6, "A3 default-mode": 6, "A4 total": 6 };

/** Blocks that did not finish, whatever the reason. A gate stop is not repairable, and it is still not a success. */
export function unfinishedBlocks(blocks: readonly BlockResult[]): BlockResult[] {
  const last = new Map<string, BlockResult>();
  for (const block of blocks) last.set(`${block.ade}/${block.track}`, block);
  return [...last.values()].filter((block) => !block.finished);
}

/** An ADE fails when its last block of a track stopped, or an output of one model has too few valid rows. */
export function failuresOf(ade: string, blocks: readonly BlockResult[], rows: readonly ResultRow[]): string[] {
  const failures: string[] = [];
  const last = new Map<string, BlockResult>();
  for (const block of blocks) {
    if (belongsTo(block.ade, ade)) last.set(`${block.ade}/${block.track}`, block);
  }
  for (const block of last.values()) {
    if (!block.finished && repairableBlockError(block.error)) {
      failures.push(`${block.ade} ${block.track} block: ${block.error ?? "did not finish"}`);
    }
  }
  const outputs = new Map<string, ResultRow[]>();
  for (const row of rows) {
    if (!belongsTo(row.ade, ade)) continue;
    if ((row.invalid_reason ?? "").startsWith(NOT_SUPPORTED)) continue;
    const variant = row.variant.length > 0 ? ` ${row.variant}` : "";
    const key = `${row.ade} ${row.test_id}${variant}${row.model ? ` (${row.model})` : ""}`;
    outputs.set(key, [...(outputs.get(key) ?? []), row]);
  }
  for (const [key, list] of outputs) {
    const valid = list.filter((row) => row.valid).length;
    // One lucky repetition out of six is not a number: A11 open did that on 2026-11-05.
    const needed = MIN_VALID[`${list[0]!.test_id} ${list[0]!.variant}`] ?? 0;
    if (valid * 2 >= list.length && valid >= needed) continue;
    const reason = list.findLast((row) => !row.valid)?.invalid_reason ?? "invalid";
    failures.push(valid === 0 ? `${key}: ${reason}` : `${key}: ${reason} (${valid} of ${list.length} valid)`);
  }
  return failures;
}

function receiptsOf(ade: string, rows: readonly ResultRow[], runDir: string): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    if (!belongsTo(row.ade, ade) || row.valid) continue;
    for (const receipt of Object.values(row.receipts)) {
      if (receipt !== null) paths.add(join(runDir, receipt));
    }
  }
  return [...paths].slice(0, MAX_RECEIPTS);
}

export function buildRepairPrompt(o: {
  template: string;
  ade: string;
  tracks: readonly TrackLetter[];
  agents?: readonly Agent[];
  failures: readonly string[];
  receipts: readonly string[];
  outcomeFile: string;
}): string {
  const list = (items: readonly string[]): string => (items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n"));
  return o.template
    .replaceAll("{{ADE}}", o.ade)
    .replaceAll("{{TRACKS}}", o.tracks.join(","))
    .replaceAll("{{AGENT_FLAG}}", o.agents === undefined ? "" : ` --agent ${o.agents.join(",")}`)
    .replaceAll("{{FAILURES}}", list(o.failures))
    .replaceAll("{{KNOWN}}", KNOWN_FAILURES[o.ade] ?? "Nothing recorded.")
    .replaceAll("{{RECEIPTS}}", list(o.receipts))
    .replaceAll("{{ALLOWED}}", allowedPaths(o.ade).map((path) => `\`${path}\``).join(", "))
    .replaceAll("{{AGENT_FLAG}}", o.agents === undefined ? "" : ` --agent ${o.agents.join(",")}`)
    .replaceAll("{{OUTCOME_FILE}}", o.outcomeFile);
}

function readOutcome(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function markRepaired(runDir: string, ade: string, commit: string): void {
  const path = join(runDir, "rows.jsonl");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const marked = lines.map((line) => {
    const row = JSON.parse(line) as ResultRow;
    if (!belongsTo(row.ade, ade)) return line;
    const note = `repaired ${commit}`;
    return JSON.stringify({ ...row, notes: row.notes.length > 0 ? `${row.notes}; ${note}` : note });
  });
  writeFileSync(path, lines.length === 0 ? "" : `${marked.join("\n")}\n`);
}

export async function runRepairAgent(o: AgentAttemptOptions): Promise<AgentResult> {
  const { deps, ade, attempt, failures } = o;
  const started = deps.now();
  const dir = join(o.runDir, REPAIRS_DIR, ade, `attempt-${attempt}`);
  mkdirSync(dir, { recursive: true });
  const outcomeFile = join(dir, "outcome.txt");
  const finish: FinishAttempt = (result, note, commit = null, diff = null) => {
    const minutes = Math.round((deps.now() - started) / 60_000);
    const entry: RepairAttempt = { ade, attempt, result, minutes, commit, diff, note };
    writeFileSync(join(dir, "result.json"), `${JSON.stringify(entry, null, 2)}\n`);
    deps.out(`repair ${ade} attempt ${attempt}: ${result}${note.length > 0 ? ` (${note})` : ""}`);
    return entry;
  };

  const dirty = deps.dirty();
  if (dirty.length > 0) return { kind: "ended", attempt: finish("not clean", `uncommitted before the repair: ${dirty[0]!}`) };
  await deps.quitAde(ade);
  deps.clearHarnessEnv();
  if (o.cancelled?.() === true) return { kind: "ended", attempt: finish("unfinished", "stopped") };
  const before = deps.head();
  const allowed = allowedPaths(ade);
  const prompt = buildRepairPrompt({
    template: o.template,
    ade,
    tracks: o.tracks,
    agents: o.agents,
    failures,
    receipts: receiptsOf(ade, deps.readRows(o.runDir), o.runDir),
    outcomeFile,
  });
  deps.out(`repair ${ade} attempt ${attempt}: agent started`);
  const logPath = join(dir, "agent.jsonl");
  const inputs = deps.measuringInputs();
  const exit = await deps.runAgent({ prompt, logPath, timeoutMs: AGENT_TIMEOUT_MS });

  const alive = await deps.cleanUp(ade);
  // These files are git-ignored, so the path check cannot see them, and no revert can bring them back.
  if (deps.measuringInputs() !== inputs) {
    deps.revert(before);
    return { kind: "ended", attempt: finish("tampered", "the agent changed bench/native/bin or snapshots") };
  }
  const outside = deps.changedPaths(before).filter((path) => !allowed.includes(path));
  if (outside.length > 0) {
    deps.revert(before);
    return { kind: "ended", attempt: finish("rejected", `changed ${outside.join(", ")}`) };
  }
  deps.commit(allowed, `repair(${ade}): night ${o.runId}, attempt ${attempt}`);
  const broken = deps.validate();
  if (broken !== null) {
    deps.revert(before);
    return { kind: "ended", attempt: finish("rejected", `the harness no longer loads: ${broken}`) };
  }
  const after = deps.head();
  const diffName = join(REPAIRS_DIR, ade, `attempt-${attempt}`, "diff.patch");
  if (after !== before) deps.writeDiff(before, join(o.runDir, diffName));
  const diff = after !== before ? diffName : null;

  const outcome = readOutcome(outcomeFile);
  if (outcome.startsWith("needs a human")) {
    return { kind: "ended", attempt: finish("needs a human", outcome.replace(/^needs a human:?\s*/, ""), after, diff) };
  }
  if (hitPlanLimit(logPath)) return { kind: "ended", attempt: finish("plan limit", exit.note, after, diff) };
  if (alive.length > 0) {
    return { kind: "ended", attempt: finish("not clean", `still alive: ${alive.join(", ")}`, after, diff) };
  }
  if (!exit.ok) return { kind: "ended", attempt: finish("agent failed", exit.note, after, diff) };
  // A seed-only fix leaves HEAD alone, so `fixed` is what says the ADE must be measured again.
  if (outcome === "fixed") return { kind: "changed", after, diff, finish };
  if (after === before) return { kind: "ended", attempt: finish("no change", outcome) };
  return { kind: "ended", attempt: finish("unfinished", "no outcome file: the agent stopped before step 8", after, diff) };
}

// The log is the only place that says it: `claude -p` exits like any other failure.
function hitPlanLimit(logPath: string): boolean {
  if (!existsSync(logPath)) return false;
  return /usage limit|rate_limit_error|hit your limit|limit reached/i.test(readFileSync(logPath, "utf8").slice(-20_000));
}

async function attemptRepair(o: RepairOptions, ade: string, attempt: number, failures: readonly string[]): Promise<RepairAttempt> {
  const { deps } = o;
  const agent = await runRepairAgent({ ...o, ade, attempt, failures });
  if (agent.kind === "ended") return agent.attempt;
  const { after, diff, finish } = agent;

  await deps.waitQuiet();
  // A block that starts after the deadline can run far into the morning, and the wait above takes minutes.
  if (o.cancelled?.() === true || (o.deadline !== null && deps.now() >= o.deadline)) {
    return finish("still failing", "no time left to measure again", after, diff);
  }
  deps.supersede({ runDir: o.runDir, ade, tracks: o.tracks, agents: o.agents, attempt });
  const finished = await deps.remeasure({ ade, runId: o.runId, seed: o.seed, tracks: o.tracks, agents: o.agents });
  const rows = deps.readRows(o.runDir);
  const remaining = failuresOf(ade, [], rows);
  if (!rows.some((row) => belongsTo(row.ade, ade))) remaining.push(`${ade}: no rows after the repair`);
  if (!finished || remaining.length > 0) {
    return finish("still failing", remaining[0] ?? "the block stopped again", after, diff);
  }
  markRepaired(o.runDir, ade, after);
  return finish("repaired", "", after, diff);
}

// Night of 2026-11-05: run order spent the budget on two ADEs with rows, and four with no row at all got no repair.
export function worstFirst(order: readonly string[], rows: readonly ResultRow[]): string[] {
  const valid = (ade: string): number => rows.filter((row) => belongsTo(row.ade, ade) && row.valid).length;
  return [...order].sort((a, b) => valid(a) - valid(b));
}

/** Whatever throws inside a repair, nothing it started stays alive and its half-done changes go away. */
export async function withRecovery<T>(deps: RepairDeps, ade: string, work: () => Promise<T>): Promise<T> {
  const clean = deps.dirty().length === 0;
  const baseline = deps.head();
  try {
    return await work();
  } catch (error) {
    await deps.cleanUp(ade).catch(() => []);
    if (clean) {
      try {
        deps.revert(baseline);
      } catch (revertError) {
        deps.out(`repair ${ade}: could not restore ${baseline}: ${String(revertError)}`);
      }
    }
    throw error;
  }
}

// One broken attempt must not end the night: git or the disk can fail here too.
async function safeAttempt(o: RepairOptions, ade: string, attempt: number, failures: readonly string[]): Promise<RepairAttempt> {
  try {
    return await withRecovery(o.deps, ade, () => attemptRepair(o, ade, attempt, failures));
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    o.deps.out(`repair ${ade} attempt ${attempt}: agent failed (${note})`);
    return { ade, attempt, result: "agent failed", minutes: 0, commit: null, diff: null, note };
  }
}

export async function repairNight(o: RepairOptions): Promise<RepairAttempt[]> {
  const { deps } = o;
  const started = deps.now();
  const timeLeft = (): boolean =>
    o.cancelled?.() !== true && deps.now() - started < o.budgetMs && (o.deadline === null || deps.now() < o.deadline);
  const attempts: RepairAttempt[] = [];
  for (const ade of worstFirst(o.order, deps.readRows(o.runDir))) {
    let failures = failuresOf(ade, o.blocks, deps.readRows(o.runDir));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && failures.length > 0; attempt++) {
      if (!timeLeft()) {
        deps.out(`repair ${ade}: no time left`);
        return attempts;
      }
      const result = await safeAttempt(o, ade, attempt, failures);
      attempts.push(result);
      o.onAttempt?.(result);
      // Every later attempt would hit the same limit, and Track B needs what is left. Changed measuring files cannot
      // be restored here, so nothing more may be measured on them.
      if (result.result === "plan limit" || result.result === "tampered") return attempts;
      if (result.result === "repaired" || result.result === "needs a human") break;
      if (result.result === "still failing") failures = failuresOf(ade, [], deps.readRows(o.runDir));
      if (failures.length === 0) failures = [`${ade}: ${result.note || "the block stopped again"}`];
    }
  }
  return attempts;
}

export function repairTemplate(): string {
  return readFileSync(join(dirname(new URL(import.meta.url).pathname), "repair-prompt.md"), "utf8");
}
