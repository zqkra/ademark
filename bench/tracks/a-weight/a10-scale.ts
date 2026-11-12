// A10 Scale: how RAM and Typing Lag grow with many threads (TESTS.md §2 A10).
import type { ResultRow } from "../../core/contracts.ts";
import { sampleRulesFor } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { BYTES_PER_MB, emptyReceipts, groupSeries, missingCalibration, readSamples, receipt } from "../../run/kit.ts";
import { SEED_PROMPT, SEED_TIMEOUT_MS } from "../../run/loop.ts";
import { SMOKE, smokeCount, smokeSeconds } from "../../run/smoke.ts";
import {
  SAMPLE_HZ,
  elapsedMs,
  invalidVariantRows,
  launchPid,
  mbPerThread,
  medianMb,
  openStreams,
  weightRows,
} from "./shared.ts";

const TEST = "A10";
const OUTPUTS = [
  { variant: "rest-20", unit: "MB" },
  { variant: "mb-per-thread", unit: "MB" },
  { variant: "lag-p95-20", unit: "ms" },
] as const;
const EXTRA_THREADS = 15;
const WINDOW_S = 60;
const LAG_PROBES = 30;
const LAG_INTERVAL_MS = 250;

export const scale: TestRunner = {
  id: TEST,
  track: "A",
  repeats: () => 1,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const pid = launchPid(ctx);
    const samples = receipt(ctx, TEST, rep, "samples.csv");
    const frames = receipt(ctx, TEST, rep, "frames.json");
    const base = {
      testId: TEST,
      rep,
      server: ctx.options.server,
      receipts: { ...emptyReceipts(), samples: samples.rel },
      notes: "",
      durationMs: 0,
    };
    const region = ctx.adapter.calibration.activeComposerRect ?? ctx.adapter.calibration.composerRect;
    const missing = missingCalibration(ctx.adapter, ["composerRect", "newThread", "send"]);
    if (missing !== null || region === null) {
      return invalidVariantRows(ctx, base, OUTPUTS, missing ?? "not calibrated: composerRect");
    }

    let unfinished = 0;
    const extraThreads = smokeCount(ctx, EXTRA_THREADS, SMOKE.a10ExtraThreads);
    for (let thread = 0; thread < extraThreads; thread++) {
      await ctx.adapter.newThread(ctx.adapterCtx);
      await ctx.adapter.send(ctx.adapterCtx, SEED_PROMPT);
      const done = await ctx.adapter.waitDone(ctx.adapterCtx, SEED_TIMEOUT_MS);
      if (!done.done) unfinished += 1;
    }
    await ctx.instruments.sample({
      rules: sampleRulesFor(ctx.adapter, [pid]),
      hz: SAMPLE_HZ,
      durationS: smokeSeconds(ctx, WINDOW_S, SMOKE.a10WindowS),
      csv: samples.abs,
    });
    const app = groupSeries(readSamples(samples.abs), "app");
    const durationMs = elapsedMs(started, ctx.instruments.now());
    const notes = unfinished === 0 ? "" : `${unfinished} of ${extraThreads} seed threads did not finish`;
    if (app.length === 0) return invalidVariantRows(ctx, { ...base, durationMs, notes }, OUTPUTS, "no app samples");

    const restMb = medianMb(app);
    const baseline = ctx.state.get("A5.app_median_b");
    const baselineMb = typeof baseline === "number" ? baseline / BYTES_PER_MB : null;

    await openStreams(ctx);
    const lag = await ctx.instruments.lag({
      pid,
      region,
      count: LAG_PROBES,
      intervalMs: LAG_INTERVAL_MS,
      frames: frames.abs,
      clear: ctx.adapter.calibration.clearKeys,
    });
    const receipts = { ...emptyReceipts(), frames: frames.rel };
    return weightRows(ctx, { ...base, durationMs, notes }, [
      { variant: "rest-20", value: restMb, unit: "MB" },
      {
        variant: "mb-per-thread",
        value: baselineMb === null ? null : mbPerThread(restMb, baselineMb),
        unit: "MB",
        invalidReason: baselineMb === null ? "no A5 value" : undefined,
      },
      { variant: "lag-p95-20", value: lag.p95, unit: "ms", receipts },
    ]);
  },
};
