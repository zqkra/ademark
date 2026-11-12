// A8 Typing Lag: keystroke-to-pixel time while 5 agents stream (TESTS.md §2 A8).
import type { ResultRow } from "../../core/contracts.ts";
import type { TestRunner } from "../../run/registry.ts";
import { emptyReceipts, missingCalibration, receipt } from "../../run/kit.ts";
import { SMOKE, smokeCount } from "../../run/smoke.ts";
import { elapsedMs, invalidVariantRows, launchPid, openStreams, weightRows } from "./shared.ts";

const TEST = "A8";
const OUTPUTS = [
  { variant: "p50", unit: "ms" },
  { variant: "p95", unit: "ms" },
  { variant: "max", unit: "ms" },
  { variant: "missed", unit: "count" },
] as const;
const PROBES = 60;
const PROBE_INTERVAL_MS = 250;

export const typingLag: TestRunner = {
  id: TEST,
  track: "A",
  repeats: () => 1,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const pid = launchPid(ctx);
    const frames = receipt(ctx, TEST, rep, "frames.json");
    const base = {
      testId: TEST,
      rep,
      server: ctx.options.server,
      receipts: { ...emptyReceipts(), frames: frames.rel },
      notes: "",
      durationMs: 0,
    };
    const region = ctx.adapter.calibration.activeComposerRect ?? ctx.adapter.calibration.composerRect;
    const missing = missingCalibration(ctx.adapter, ["composerRect", "newThread", "send"]);
    if (missing !== null || region === null) {
      return invalidVariantRows(ctx, base, OUTPUTS, missing ?? "not calibrated: composerRect");
    }

    await openStreams(ctx);
    const lag = await ctx.instruments.lag({
      pid,
      region,
      count: smokeCount(ctx, PROBES, SMOKE.a8Probes),
      intervalMs: PROBE_INTERVAL_MS,
      frames: frames.abs,
      clear: ctx.adapter.calibration.clearKeys,
    });
    const durationMs = elapsedMs(started, ctx.instruments.now());
    const max = lag.samples_ms.length === 0 ? null : Math.max(...lag.samples_ms);
    return weightRows(ctx, { ...base, durationMs, notes: `${lag.samples_ms.length} probes, ${lag.lost} lost` }, [
      { variant: "p50", value: lag.p50, unit: "ms" },
      { variant: "p95", value: lag.p95, unit: "ms" },
      { variant: "max", value: max, unit: "ms", invalidReason: max === null ? "no probes" : undefined },
      { variant: "missed", value: lag.lost, unit: "count" },
    ]);
  },
};
