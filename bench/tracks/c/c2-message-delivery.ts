// C2 Message Delivery: three follow-ups sent during the run, their acceptance, queue screenshot, delivery and
// application (TESTS.md §4, C2).
import type { FollowUp, FollowUpPolicy, ResultRow } from "../../core/contracts.ts";
import { loadTask } from "../../core/tasks.ts";
import type { TestContext } from "../../run/context.ts";
import { invalidRow, missingCalibration, receipt } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import { runProbe, type ProbePause } from "./probe.ts";
import {
  C2_TASK,
  appCrashed,
  captureDirOf,
  followupDelivered,
  gradeInvalidReason,
  groupPassed,
  launchPid,
  runReceipts,
  runTask,
  screenshot,
  sleepUntil,
  withCrashNote,
  type TaskWindow,
} from "./shared.ts";

const VARIANTS = [
  { variant: "dropped", unit: "x/3" },
  { variant: "applied", unit: "x/3" },
] as const;

// TESTS.md §4, C2: the C3 probe pauses 3 s around each follow-up.
const PAUSE_S = 3;
const PROBE_TEXT_CHARS = 24;

interface FollowupState {
  id: string;
  sent_ns: number;
  accepted: boolean;
  attempts: number;
  delayMs: number;
}

function pauseWindows(t0Ns: bigint, followups: readonly FollowUp[]): ProbePause[] {
  const half = (PAUSE_S / 2) * 1_000_000_000;
  return followups.map((followup) => {
    const at = t0Ns + BigInt(Math.round(followup.at_s * 1_000)) * 1_000_000n;
    return { start_ns: at - BigInt(half), end_ns: at + BigInt(half) };
  });
}

// TESTS.md §4, C2: at the follow-up time, retry every `refused_retry_every_s` until `refused_give_up_s`.
async function sendFollowup(
  ctx: TestContext,
  window: TaskWindow,
  followup: FollowUp,
  policy: FollowUpPolicy,
  rep: number,
  pid: number,
): Promise<FollowupState> {
  await sleepUntil(ctx, window, followup.at_s * 1_000);
  const region = ctx.adapter.calibration.threadRect!;
  const giveUpMs = policy.refused_give_up_s * 1_000;
  const startedMs = window.elapsedMs();
  let attempts = 0;
  let sent_ns = 0;
  let accepted = false;
  let delayMs = 0;
  while (true) {
    attempts += 1;
    await ctx.adapter.send(ctx.adapterCtx, followup.text);
    const sentAt = window.elapsedMs();
    if (sent_ns === 0) sent_ns = Number(ctx.instruments.now());
    const frames = receipt(ctx, "C2", rep, `watch-${followup.id}.json`).abs;
    const seen = await ctx.instruments.watch({
      pid,
      text: followup.text.slice(0, PROBE_TEXT_CHARS),
      region,
      triggers: [],
      timeoutS: 5,
      frames,
    });
    delayMs = sentAt - followup.at_s * 1_000;
    if (!seen.timed_out) {
      accepted = true;
      break;
    }
    if (ctx.instruments.dryRun || window.elapsedMs() - startedMs >= giveUpMs) break;
    await ctx.instruments.sleep(policy.refused_retry_every_s * 1_000);
  }
  // queued: the screenshot is the evidence that the ADE showed a queued state.
  await screenshot(ctx, "C2", rep, `queued-${followup.id}`);
  return { id: followup.id, sent_ns, accepted, attempts, delayMs };
}

function invalidPair(ctx: TestContext, rep: number, reason: string, receipts = runReceipts(ctx)): ResultRow[] {
  return VARIANTS.map((entry) =>
    invalidRow(
      ctx,
      {
        test_id: "C2",
        variant: entry.variant,
        rep,
        server: "live",
        unit: entry.unit,
        duration_ms: 0,
        receipts,
        notes: "",
      },
      reason,
    ),
  );
}

export const c2: TestRunner = {
  id: "C2",
  track: "C",
  repeats: () => 1,
  maxExtraRuns: 0,
  // TESTS.md §4, C2 says Runs: 1, so this only reports the need; the crash is in the rows' notes.
  needsExtraRun: (rows) => appCrashed(rows),
  runRep: async (ctx, rep) => {
    const missing = missingCalibration(ctx.adapter, ["composerRect", "threadRect"]);
    if (missing !== null) return invalidPair(ctx, rep, missing);
    const pid = launchPid(ctx);
    if (pid === null) return invalidPair(ctx, rep, "no launch pid");

    const task = loadTask(C2_TASK);
    const policy = task.followup_policy ?? { refused_retry_every_s: 1, refused_give_up_s: 10 };
    const states = new Map<string, FollowupState>();
    const run = await runTask(ctx, {
      taskId: C2_TASK,
      label: `C2-${rep}`,
      rep,
      prompt: task.prompt,
      background: (c, window) =>
        runProbe(c, window.untilNs, pauseWindows(window.t0Ns, task.followups), window.stopped),
      schedule: async (c, window) => {
        for (const followup of [...task.followups].sort((left, right) => left.at_s - right.at_s)) {
          states.set(followup.id, await sendFollowup(c, window, followup, policy, rep, pid));
        }
      },
    });

    const delivered = task.followups.map((followup) => {
      const state = states.get(followup.id);
      return state !== undefined && followupDelivered(run.capture, BigInt(state.sent_ns), followup.text, captureDirOf(ctx));
    });
    const applied = task.followups.map((followup) => groupPassed(run.grade, followup.id));
    const notes = task.followups
      .map((followup, index) => {
        const state = states.get(followup.id);
        const parts = [
          followup.id,
          delivered[index] ? "delivered" : "dropped",
          applied[index] ? "applied" : "not applied",
        ];
        if (state !== undefined) {
          parts.push(
            state.accepted
              ? `accepted +${Math.round(state.delayMs)} ms`
              : `refused after ${state.attempts} attempt(s)`,
          );
        }
        return parts.join(" ");
      })
      .join("; ");

    const values: Record<string, number> = {
      dropped: delivered.filter((entry) => !entry).length,
      applied: applied.filter(Boolean).length,
    };
    // applied is read from the hidden tests; dropped comes from the capture and stays.
    const gradeReason = gradeInvalidReason(run.grade);
    return VARIANTS.map((entry) => {
      const fields = {
        test_id: "C2" as const,
        variant: entry.variant,
        rep,
        server: "live" as const,
        unit: entry.unit,
        duration_ms: run.durationMs,
        receipts: run.receipts,
        notes: withCrashNote(notes, run.crashed),
      };
      if (entry.variant === "applied" && gradeReason !== null) return invalidRow(ctx, fields, gradeReason);
      return ctx.row({ ...fields, value: values[entry.variant]!, valid: true, invalid_reason: null });
    });
  },
};
