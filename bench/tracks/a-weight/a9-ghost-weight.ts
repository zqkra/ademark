// A9 Ghost Weight: RAM still used 60 s after the user quits (TESTS.md §2 A9).
import { writeFileSync } from "node:fs";
import type { ResultRow } from "../../core/contracts.ts";
import { sampleRulesFor, type TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { emptyReceipts, groupSeries, invalidRow, missingCalibration, readSamples, receipt } from "../../run/kit.ts";
import { SMOKE, smokeSeconds } from "../../run/smoke.ts";
import { SAMPLE_HZ, elapsedMs, medianMb, processList } from "./shared.ts";

const TEST = "A9";
const NO_SESSIONS = "no-sessions";
const SESSIONS_KEPT = "sessions-kept";
const GHOST_WAIT_S = 60;
const SAMPLE_S = 1;
const SESSION_LEAD_MS = 10_000;

// A9 steps 2 to 6 for one variant: quit, wait, sample what is left, list it, then relaunch for the next rep.
async function ghostRow(ctx: TestContext, rep: number, variant: string): Promise<ResultRow> {
  const started = ctx.instruments.now();
  await ctx.adapter.quit(ctx.adapterCtx);
  const waitS = smokeSeconds(ctx, GHOST_WAIT_S, SMOKE.a9WaitS);
  await ctx.instruments.sleep(waitS * 1000);
  const samples = receipt(ctx, TEST, rep, `samples-${variant}.csv`);
  await ctx.instruments.sample({
    rules: sampleRulesFor(ctx.adapter, []),
    hz: SAMPLE_HZ,
    durationS: SAMPLE_S,
    csv: samples.abs,
  });
  const rows = readSamples(samples.abs);
  const processes = processList(rows);
  writeFileSync(receipt(ctx, TEST, rep, `processes-${variant}.json`).abs, `${JSON.stringify(processes, null, 2)}\n`);
  const relaunched = await ctx.adapter.launch(ctx.adapterCtx);
  ctx.state.set("launch_pid", relaunched.pid);

  // ADES.md 3.0: the control's host (Ghostty) stays open by design, so only the CLIs it leaves behind are ghosts.
  const total = groupSeries(rows, ctx.adapter.hostStaysOpen === true ? "agents" : "total");
  const fields = {
    test_id: TEST,
    variant,
    rep,
    server: ctx.options.server,
    unit: "MB",
    duration_ms: elapsedMs(started, ctx.instruments.now()),
    receipts: { ...emptyReceipts(), samples: samples.rel },
    notes: `${processes.length} processes ${waitS} s after quit`,
  };
  // Pilot 2026-10-20: Zeron leaves no process at all. The sampler ran (its CSV has a header) and matched nothing,
  // which is 0 MB of ghost weight, not a missing measurement.
  if (total.length === 0) return ctx.row({ ...fields, value: 0, valid: true, invalid_reason: null });
  return ctx.row({ ...fields, value: medianMb(total), valid: true, invalid_reason: null });
}

// TESTS.md A9: reported apart from the main variant, and only once per block.
async function sessionsKeptRow(ctx: TestContext, rep: number): Promise<ResultRow> {
  const missing = missingCalibration(ctx.adapter, ["newThread", "send"]);
  if (missing !== null) {
    return invalidRow(
      ctx,
      {
        test_id: TEST,
        variant: SESSIONS_KEPT,
        rep,
        server: ctx.options.server,
        unit: "MB",
        duration_ms: 0,
        receipts: emptyReceipts(),
        notes: "",
      },
      missing,
    );
  }
  await ctx.adapter.newThread(ctx.adapterCtx);
  await ctx.adapter.send(ctx.adapterCtx, "replay:stream-1");
  // In smoke a 5 s lead is enough to have the stream running; the full run keeps 10 s.
  await ctx.instruments.sleep(smokeSeconds(ctx, SESSION_LEAD_MS / 1000, SMOKE.a9WaitS) * 1000);
  return ghostRow(ctx, rep, SESSIONS_KEPT);
}

export const ghostWeight: TestRunner = {
  id: TEST,
  track: "A",
  repeats: () => 3,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const rows = [await ghostRow(ctx, rep, NO_SESSIONS)];
    // The real model can finish before the quit, and nothing here proves a stream was running.
    if (rep === 1 && ctx.adapter.liveModel !== true) rows.push(await sessionsKeptRow(ctx, rep));
    return rows;
  },
};
