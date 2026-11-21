// A13 Focus Idle (pilot): CPU, wakeups and energy at rest with the composer focused, then with focus moved off it
// inside the app (TESTS.md §2 A13). A focused text field can keep a caret, a compositor or a frame loop busy.
import type { Point, Rect, ResultRow, TestId } from "../../core/contracts.ts";
import { sampleRulesFor, type TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { emptyReceipts, missingCalibration, readSamples, receipt } from "../../run/kit.ts";
import { SMOKE, smokeSeconds } from "../../run/smoke.ts";
import { NativeError } from "../../core/native.ts";
import { probeOf } from "../a-timing/shared.ts";
import {
  SAMPLE_HZ,
  SETTLE_CAP_S,
  elapsedMs,
  invalidVariantRows,
  rateOutputs,
  runningPid,
  settleApp,
  weightRows,
  windowRates,
  type Output,
} from "./shared.ts";

const TEST: TestId = "A13";
const FOCUSED = rateOutputs("focused-", null).map(({ variant, unit }) => ({ variant, unit }));
const BLURRED = rateOutputs("blurred-", null).map(({ variant, unit }) => ({ variant, unit }));
const WINDOW_S = 60;
// After a click the app may animate the focus change; the window starts this long after it (A6 waits 5 s after covering).
const LEAD_MS = 5_000;
const ECHO_TIMEOUT_S = 10;
const ECHO_INTERVAL_MS = 50;

// The composer the app shows after a launch: A1 and A2 read the same region.
function composerRegion(ctx: TestContext): Rect | null {
  const calibration = ctx.adapter.calibration;
  return calibration.launchComposerRect ?? calibration.composerRect;
}

function center(rect: Rect): Point {
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
}

function failure(error: unknown): string {
  if (error instanceof NativeError) return error.message;
  throw error;
}

async function sampleWindow(ctx: TestContext, pid: number, rep: number, name: string): Promise<{ rel: string; outputs: Output[] }> {
  await ctx.instruments.sleep(smokeSeconds(ctx, LEAD_MS / 1000, 1) * 1000);
  const csv = receipt(ctx, TEST, rep, `samples-${name}.csv`);
  await ctx.instruments.sample({
    rules: sampleRulesFor(ctx.adapter, [pid]),
    hz: SAMPLE_HZ,
    durationS: smokeSeconds(ctx, WINDOW_S, SMOKE.a13WindowS),
    csv: csv.abs,
  });
  return { rel: csv.rel, outputs: rateOutputs(`${name}-`, windowRates(readSamples(csv.abs))) };
}

export const focusIdle: TestRunner = {
  id: TEST,
  track: "A",
  pilot: true,
  repeats: () => 1,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const frames = receipt(ctx, TEST, rep, "frames-focus.json");
    const base = { testId: TEST, rep, server: ctx.options.server, receipts: emptyReceipts(), notes: "", durationMs: 0 };
    const region = composerRegion(ctx);
    const missing = missingCalibration(ctx.adapter, ["composerRect"]);
    if (missing !== null || region === null) {
      return invalidVariantRows(ctx, { ...base }, FOCUSED, missing ?? "not calibrated: composerRect");
    }
    const focusPoint = ctx.adapter.calibration.focusClick ?? center(region);
    const blurPoint = ctx.adapter.calibration.blurClick ?? null;

    const { pid, launched } = await runningPid(ctx);
    const settled = await settleApp(ctx, TEST, rep, pid, smokeSeconds(ctx, SETTLE_CAP_S, SMOKE.a13SettleCapS));
    const gatesBefore = await ctx.instruments.gates();
    const notes = [
      launched ? "launched for A13" : "app already running",
      settled.settled ? `settle ${settled.seconds} s` : `did not settle; settle ${settled.seconds} s`,
      blurPoint === null ? "blurred: not calibrated: blurClick" : "blur not verified on screen (pilot)",
    ];

    // Focused: click the composer, then type the probe until it shows and clear it, as a user who just typed.
    let focusReason: string | null = null;
    try {
      await ctx.instruments.click({ pid, at: focusPoint });
      const echo = await ctx.instruments.echo({
        pid,
        triggers: [],
        region,
        probe: probeOf(ctx),
        intervalMs: ECHO_INTERVAL_MS,
        timeoutS: ECHO_TIMEOUT_S,
        frames: frames.abs,
        clear: ctx.adapter.calibration.clearKeys,
      });
      if (echo.timed_out || echo.ready_ms === null) focusReason = "the composer did not show typing after the focus click";
    } catch (error) {
      focusReason = `focus failed: ${failure(error)}`;
    }
    const focused = focusReason === null ? await sampleWindow(ctx, pid, rep, "focused") : null;

    // Blurred: one click inside the app that takes focus off the composer, then the composer gets focus back.
    let blurred: { rel: string; outputs: Output[] } | null = null;
    let blurReason: string | null = null;
    if (blurPoint !== null) {
      try {
        await ctx.instruments.click({ pid, at: blurPoint });
        blurred = await sampleWindow(ctx, pid, rep, "blurred");
        await ctx.instruments.click({ pid, at: focusPoint });
      } catch (error) {
        blurReason = `blur failed: ${failure(error)}`;
      }
    }
    const gatesAfter = await ctx.instruments.gates();
    const durationMs = elapsedMs(started, ctx.instruments.now());
    const swapGrew = gatesAfter.swap_used_mb > gatesBefore.swap_used_mb;
    const rowBase = { ...base, durationMs, notes: notes.join("; "), invalidReason: swapGrew ? "swap grew" : null };
    const withReceipt = (window: { rel: string; outputs: Output[] }): Output[] =>
      window.outputs.map((output) => ({ ...output, receipts: { ...emptyReceipts(), samples: window.rel, frames: frames.rel } }));
    const focusedOutputs =
      focused === null
        ? FOCUSED.map((output) => ({ ...output, value: null, invalidReason: focusReason ?? undefined }))
        : withReceipt(focused);
    // A profile without blurClick writes no blurred rows: the variant is not calibrated yet, which is no failure.
    const blurredOutputs =
      blurPoint === null
        ? []
        : blurred === null
        ? BLURRED.map((output) => ({ ...output, value: null, invalidReason: blurReason ?? undefined }))
        : withReceipt(blurred);
    return weightRows(ctx, rowBase, [...focusedOutputs, ...blurredOutputs]);
  },
};
