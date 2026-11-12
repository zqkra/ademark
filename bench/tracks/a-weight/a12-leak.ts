// A12 Leak: RAM growth over 30 minutes, computed from the Track C sampler (TESTS.md §2 A12).
import { isAbsolute, relative, sep } from "node:path";
import type { ResultRow } from "../../core/contracts.ts";
import type { TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { emptyReceipts, groupSeries, invalidRow, readSamples } from "../../run/kit.ts";
import { elapsedMs, firstWindowMinutes, leakSlope, minuteMedians, seriesMinutes, type SeriesPoint } from "./shared.ts";

const TEST = "A12";
const WINDOW_MINUTES = 30;
// The interval needs independent points, so a block with fewer full minutes is not published (W1).
const MINIMUM_MINUTES = 3;
const FEW_MINUTES_REASON = "fewer than 3 minutes of samples";

function runRelative(ctx: TestContext, path: string): string | null {
  const rel = relative(ctx.runDir, path);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const leak: TestRunner = {
  id: TEST,
  track: "C",
  repeats: () => 1,
  maxExtraRuns: 0,
  needsExtraRun: () => false,
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const fields = {
      test_id: TEST,
      variant: "slope",
      rep,
      server: ctx.options.server,
      unit: "MB/h",
      duration_ms: 0,
      receipts: emptyReceipts(),
      notes: "",
    };
    const csv = ctx.state.get("C.samples_csv");
    if (typeof csv !== "string") return [invalidRow(ctx, fields, "no Track C samples")];

    let app: SeriesPoint[];
    try {
      app = groupSeries(readSamples(csv), "app");
    } catch {
      return [invalidRow(ctx, fields, "no Track C samples")];
    }
    if (app.length < 2) return [invalidRow(ctx, fields, "no Track C samples")];

    const window = firstWindowMinutes(app, WINDOW_MINUTES);
    const points = minuteMedians(window);
    if (points.length < MINIMUM_MINUTES) return [invalidRow(ctx, fields, FEW_MINUTES_REASON)];

    const slope = leakSlope(points);
    const minutes = round(seriesMinutes(window), 2);
    const notes = {
      lo: round(slope.lo, 3),
      hi: round(slope.hi, 3),
      minutes,
      ticks: window.length,
      points: points.length,
      ...(seriesMinutes(app) < WINDOW_MINUTES ? { window: `${minutes} min` } : {}),
    };
    return [
      ctx.row({
        ...fields,
        receipts: { ...emptyReceipts(), samples: runRelative(ctx, csv) },
        notes: JSON.stringify(notes),
        duration_ms: elapsedMs(started, ctx.instruments.now()),
        value: slope.slope_mb_per_h,
        valid: true,
        invalid_reason: null,
      }),
    ];
  },
};
