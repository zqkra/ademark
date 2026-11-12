// C1 Orchestrated Build: the trigger line, the handoff codes, shipped, fan-out, handoff, codes and tokens
// (TESTS.md §4, C1).
import type { ResultRow } from "../../core/contracts.ts";
import { generateHandoffCodes, loadTask, renderHandoffCodes, type HandoffCodes } from "../../core/tasks.ts";
import type { TestContext } from "../../run/context.ts";
import { emptyReceipts, invalidRow } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import { runProbe } from "./probe.ts";
import {
  C1_AGENTS,
  C1_SOLO_TASK,
  C1_TASK,
  appCrashed,
  bodyTextOf,
  claudeSessionIntervals,
  codesPlaced,
  failedGroups,
  fanOut,
  gradeInvalidReason,
  handoffFrom,
  handoffSeedFor,
  hasWorker,
  NO_WORKER_STOP_MS,
  loadPrices,
  runCheck,
  runTask,
  runTokens,
  shippedCount,
  wallClockSince,
  withCrashNote,
  type RunCheck,
  type TaskRun,
} from "./shared.ts";

interface C1Variant {
  variant: string;
  unit: string;
}

const C1_VARIANTS: readonly C1Variant[] = [
  { variant: "shipped", unit: "x/5" },
  { variant: "time-to-green", unit: "min" },
  { variant: "fan-out-max", unit: "agents" },
  { variant: "fan-out-total", unit: "agents" },
  { variant: "handoff", unit: "x/4" },
  { variant: "codes-placed", unit: "x/4" },
  { variant: "tokens-total", unit: "tokens" },
  { variant: "usd-total", unit: "USD" },
];

const C1_GROUP_IDS = ["W1-limiter", "W1-api", "W2-dates", "W3-cursor", "W4-create", "W4-idempotency", "Integration"];

const FAN_OUT_NOTE = "validate in pilot: subagents may share one session file";

// An ADE without a calibrated trigger cannot run C1: every row is invalid, never zero (TESTS.md §4, C1).
function calibrationRows(ctx: TestContext, rep: number, reason: string): ResultRow[] {
  return C1_VARIANTS.map((entry) =>
    invalidRow(
      ctx,
      {
        test_id: "C1",
        variant: entry.variant,
        rep,
        server: "live",
        unit: entry.unit,
        duration_ms: 0,
        receipts: emptyReceipts(),
        notes: "",
      },
      reason,
    ),
  );
}

// An ADE whose trigger is a real null has no orchestration: the rows are valid with no value.
function notSupportedRows(ctx: TestContext, rep: number): ResultRow[] {
  return C1_VARIANTS.map((entry) =>
    ctx.row({
      test_id: "C1",
      variant: entry.variant,
      rep,
      server: "live",
      value: null,
      unit: entry.unit,
      duration_ms: 0,
      valid: true,
      invalid_reason: null,
      receipts: emptyReceipts(),
      notes: "not supported",
    }),
  );
}

export const c1: TestRunner = {
  id: "C1",
  track: "C",
  repeats: () => 1,
  maxExtraRuns: 1,
  // TESTS.md §4, C1: a second run when shipped is under 5/5 or the ADE crashed. A null (not supported)
  // or invalid shipped row is not an under-5 run.
  needsExtraRun: (rows) =>
    rows.some(
      (row) => row.test_id === "C1" && row.variant === "shipped" && row.valid && row.value !== null && row.value < 5,
    ) || appCrashed(rows),
  runRep: async (ctx, rep) => {
    const rows = await orchestratedRows(ctx, rep);
    // The Bare CLI also runs the C1 goal alone: the orchestration-tax baseline (TASKS.md §3, C1-solo). It needs no
    // trigger line, so it runs whether or not the Bare CLI's own orchestrated run is calibrated: before 2026-11-11 the
    // missing Claude trigger returned first, and no app could ever get a tax. Only Claude: every C task runs on Claude,
    // and the Codex baseline would wait for a sign-in the bench account does not have.
    if (ctx.adapter.id === "bare-cli" && ctx.options.agent === "claude") rows.push(...(await soloRows(ctx, rep)));
    return rows;
  },
};

async function orchestratedRows(ctx: TestContext, rep: number): Promise<ResultRow[]> {
  const trigger = ctx.adapter.orchestrationTrigger;
  if (trigger === undefined) return calibrationRows(ctx, rep, "not calibrated: orchestrationTrigger");
  if (trigger === null) return notSupportedRows(ctx, rep);

  const prices = loadPrices();
  const seed = handoffSeedFor(ctx.runId);
  const codes: HandoffCodes = generateHandoffCodes(seed);
  const task = loadTask(C1_TASK);
  const prompt = `${trigger}\n${renderHandoffCodes(task.prompt, seed)}`;
  const ownSessions = ctx.adapter.orchestrationWorkers === "sessions";
  const run = await runTask(ctx, {
    taskId: C1_TASK,
    label: `C1-${rep}`,
    rep,
    prompt,
    background: (c, window) => runProbe(c, window.untilNs, [], window.stopped),
    agents: { ...C1_AGENTS, ownSessions },
  });

  const check = orchestrated(run, checkOf(ctx, run, [prompt, renderHandoffCodes(task.prompt, seed)]), ownSessions);
  const gradeReason = gradeInvalidReason(run.grade);
  const shipped = shippedCount(run.grade);
  const failed = failedGroups(run.grade, C1_GROUP_IDS);
  const tokens = runTokens(run.capture, prices);
  const fan = fanOut(
    claudeSessionIntervals({
      home: ctx.adapterCtx.home,
      worktree: run.worktree,
      sinceMs: wallClockSince(ctx, run.t0Ns),
    }),
  );
  const handoff = handoffFrom(run.worktree, codes);
  const placed = codesPlaced(run.worktree, codes);

  const values: Record<string, number | null> = {
    shipped,
    "time-to-green": shipped === 5 ? run.durationMs / 60_000 : null,
    "fan-out-max": fan.max,
    "fan-out-total": fan.total,
    handoff,
    "codes-placed": placed,
    "tokens-total": tokens.tokens,
    "usd-total": tokens.usd,
  };
  // What the capture saw, beside the session logs: it lets a reader tell an app's own workers (sessions of their own)
  // from subagents inside one session, without a new run.
  const seen = run.agents === null ? "" : `; capture: ${run.agents.agents} agents in ${run.agents.sessions} sessions, ${run.agents.toolAnswers} tool answers`;
  const wentOn = run.wentOnMs > 0 ? `; went on ${Math.round(run.wentOnMs / 1000)} s after the first end of turn` : "";
  // At the cap the agents were still at work: the time is the cap, not the moment the build turned green.
  const cut = run.done ? "" : `; cut at the cap of ${Math.round(task.time_cap_s / 60)} minutes`;
  const notes: Record<string, string> = {
    shipped: failed.length === 0 ? "5/5 groups passed" : `failed: ${failed.join(", ")}`,
    "time-to-green": `${shipped === 5 ? "minutes to green" : "not green"}${wentOn}${cut}`,
    "fan-out-max": `${FAN_OUT_NOTE}${seen}`,
    "fan-out-total": `${FAN_OUT_NOTE}${seen}`,
    "tokens-total": `${run.capture.length} requests`,
    "usd-total": tokens.unpriced.length === 0 ? "" : `no price for ${tokens.unpriced.join(", ")}`,
  };

  return C1_VARIANTS.map((entry) => {
    const fields = {
      test_id: "C1" as const,
      variant: entry.variant,
      rep,
      server: "live" as const,
      unit: entry.unit,
      duration_ms: run.durationMs,
      receipts: run.receipts,
      notes: withCrashNote(notes[entry.variant] ?? "", run.crashed),
    };
    const reason = invalidReasonOf(entry.variant, check, gradeReason);
    if (reason !== null) return invalidRow(ctx, fields, reason);
    return ctx.row({ ...fields, value: values[entry.variant] ?? null, valid: true, invalid_reason: null });
  });
}

// The variants read from the hidden tests; the others come from the worktree, the session logs and the capture.
const GRADED_VARIANTS = new Set(["shipped", "time-to-green", "solo-shipped"]);
// The variants summed from the capture: one call with no usage makes the sum too low.
const TOKEN_VARIANTS = new Set(["tokens-total", "usd-total", "solo-tokens-total", "solo-usd-total"]);

// A dry run captures no request, and its rows are plans, not measurements: the check is for a real run.
function checkOf(ctx: TestContext, run: TaskRun, prompts: readonly string[]): RunCheck {
  if (ctx.instruments.dryRun) return { problem: null, tokensProblem: null };
  try {
    const codes = Object.values(generateHandoffCodes(handoffSeedFor(ctx.runId)));
    // A run cut at the cap ends by rule while its agents still work: what they do after it is not a fault of the run.
    return runCheck({ rows: run.capture, prompts, model: ctx.options.model, bodyText: (row) => bodyTextOf(ctx, row), afterEnd: run.done ? run.afterEnd : [], codes });
  } catch (error) {
    // A check that breaks must not cost the rows of a 45-minute run, and must not pass them either.
    return { problem: `the run check failed: ${error instanceof Error ? error.message : String(error)}`, tokensProblem: null };
  }
}

// 2026-11-11: a build that one agent did alone is not an orchestrated build, whatever it shipped. The trigger line of
// bb, Cloudroom and Capy is an estimate in their profiles, and Orca and super.engineering keep orchestration off until
// it is switched on. Without this, such a run would be published as the app's orchestration, with a tax of about 1.
function orchestrated(run: TaskRun, check: RunCheck, ownSessions: boolean): RunCheck {
  if (check.problem !== null || run.agents === null) return check;
  if (run.stoppedAlone) return { ...check, problem: `no second agent in the first ${NO_WORKER_STOP_MS / 60_000} minutes: the trigger did not start orchestration` };
  if (run.agents.agents < 2) return { ...check, problem: "one agent did the work alone: the trigger did not start orchestration" };
  // The ADE's orchestration is agents of their own (child threads, chats, terminals): subagents inside the lead's
  // session are Claude Code's, and such a run is not the ADE's orchestration.
  if (!hasWorker(run.agents, ownSessions)) {
    return { ...check, problem: `the app's own workers did not run: ${run.agents.agents} agents in one client session` };
  }
  return check;
}

// A run that cannot be trusted makes every row invalid, never a zero (2026-11-11).
function invalidReasonOf(variant: string, check: RunCheck, gradeReason: string | null): string | null {
  if (check.problem !== null) return check.problem;
  if (gradeReason !== null && GRADED_VARIANTS.has(variant)) return gradeReason;
  if (check.tokensProblem !== null && TOKEN_VARIANTS.has(variant)) return check.tokensProblem;
  return null;
}

async function soloRows(ctx: TestContext, rep: number): Promise<ResultRow[]> {
  const prices = loadPrices();
  const seed = handoffSeedFor(ctx.runId);
  const soloTask = loadTask(C1_SOLO_TASK);
  const solo = await runTask(ctx, {
    taskId: C1_SOLO_TASK,
    label: `C1-solo-${rep}`,
    rep,
    prompt: renderHandoffCodes(soloTask.prompt, seed),
    // One agent is the point of the baseline, so nothing stops it for being alone. The end is found the same way.
    agents: { quietMs: C1_AGENTS.quietMs, pollMs: C1_AGENTS.pollMs },
  });
  const check = checkOf(ctx, solo, [renderHandoffCodes(soloTask.prompt, seed)]);
  const gradeReason = gradeInvalidReason(solo.grade);
  const soloTokens = runTokens(solo.capture, prices);
  const soloValues: Array<{ variant: string; unit: string; value: number | null; notes: string }> = [
    { variant: "solo-shipped", unit: "x/5", value: shippedCount(solo.grade), notes: "one agent, no subagents" },
    { variant: "solo-tokens-total", unit: "tokens", value: soloTokens.tokens, notes: `${solo.capture.length} requests` },
    {
      variant: "solo-usd-total",
      unit: "USD",
      value: soloTokens.usd,
      notes: soloTokens.unpriced.length === 0 ? "" : `no price for ${soloTokens.unpriced.join(", ")}`,
    },
  ];
  return soloValues.map((entry) => {
    const fields = {
      test_id: "C1" as const,
      variant: entry.variant,
      rep,
      server: "live" as const,
      unit: entry.unit,
      duration_ms: solo.durationMs,
      receipts: solo.receipts,
      notes: withCrashNote(entry.notes, solo.crashed),
    };
    const reason = invalidReasonOf(entry.variant, check, gradeReason);
    if (reason !== null) return invalidRow(ctx, fields, reason);
    return ctx.row({ ...fields, value: entry.value, valid: true, invalid_reason: null });
  });
}
