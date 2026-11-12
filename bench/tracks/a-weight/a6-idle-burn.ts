// A6 Idle Burn: CPU, wakeups and energy of the app at rest (TESTS.md §2 A6).
import type { ResultRow } from "../../core/contracts.ts";
import { sampleRulesFor, type TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { emptyReceipts, readSamples, receipt } from "../../run/kit.ts";
import { SMOKE, smokeSeconds } from "../../run/smoke.ts";
import {
  SAMPLE_HZ,
  appRates,
  elapsedMs,
  invalidVariantRows,
  launchPid,
  ticks,
  weightRows,
  type AppRates,
} from "./shared.ts";

const TEST = "A6";
const OUTPUTS = [
  { variant: "front", unit: "%" },
  { variant: "covered", unit: "%" },
  { variant: "front-wakeups", unit: "per s" },
  { variant: "covered-wakeups", unit: "per s" },
  { variant: "front-energy", unit: "mW" },
  { variant: "covered-energy", unit: "mW" },
] as const;
const WINDOW_S = 60;
const COVER_S = 70;
const COVER_LEAD_MS = 5_000;

function ratesOf(csv: string): AppRates | null {
  const all = ticks(readSamples(csv));
  if (all.length < 2) return null;
  return appRates(all[0]!, all[all.length - 1]!);
}

// TESTS.md A6: a counter of -1 is skipped, and the row says which ones it was.
function skippedNote(rates: AppRates): string {
  const counters: Array<[string, number]> = [
    ["cpu", rates.skipped.cpu],
    ["wakeups", rates.skipped.wakeups],
    ["energy_nj", rates.skipped.energy],
  ];
  return counters
    .filter(([, skipped]) => skipped > 0)
    .map(([name, skipped]) => `${name} -1 on ${skipped}/${rates.pids} pids`)
    .join("; ");
}

function counterReason(value: number | null, counter: string): string | undefined {
  return value === null ? `no ${counter} counter` : undefined;
}

export const idleBurn: TestRunner = {
  id: TEST,
  track: "A",
  repeats: () => 1,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const pid = launchPid(ctx);
    const frontCsv = ctx.state.get("A5.samples_csv");
    const frontRel = ctx.state.get("A5.samples_rel");
    const coveredSamples = receipt(ctx, TEST, rep, "samples.csv");
    const receipts = { ...emptyReceipts(), samples: coveredSamples.rel };
    const base = { testId: TEST, rep, server: ctx.options.server, receipts, notes: "", durationMs: 0 };
    const noFront = (): ResultRow[] =>
      invalidVariantRows(
        ctx,
        { ...base, durationMs: elapsedMs(started, ctx.instruments.now()) },
        OUTPUTS,
        "no A5 samples",
      );

    if (typeof frontCsv !== "string") return noFront();
    const front = ratesOf(frontCsv);
    if (front === null) return noFront();

    const windowS = smokeSeconds(ctx, WINDOW_S, SMOKE.a6WindowS);
    const coverS = smokeSeconds(ctx, COVER_S, SMOKE.a6CoverS);
    const coverLeadMs = smokeSeconds(ctx, COVER_LEAD_MS / 1000, SMOKE.a6CoverLeadS) * 1000;
    const covering = ctx.instruments.cover({ pid, durationS: coverS });
    // The cover runs longer than the window; mark any failure handled until the await below.
    covering.catch(() => {});
    await ctx.instruments.sleep(coverLeadMs);
    await ctx.instruments.sample({
      rules: sampleRulesFor(ctx.adapter, [pid]),
      hz: SAMPLE_HZ,
      durationS: windowS,
      csv: coveredSamples.abs,
    });
    await covering;
    const durationMs = elapsedMs(started, ctx.instruments.now());
    const covered = ratesOf(coveredSamples.abs);
    if (covered === null) return invalidVariantRows(ctx, { ...base, durationMs }, OUTPUTS, "no covered samples");

    const frontReceipts = typeof frontRel === "string" ? { ...emptyReceipts(), samples: frontRel } : emptyReceipts();
    const frontNotes = skippedNote(front);
    const coveredNotes = skippedNote(covered);
    return weightRows(ctx, { ...base, durationMs }, [
      {
        variant: "front",
        value: front.cpu_percent,
        unit: "%",
        receipts: frontReceipts,
        invalidReason: counterReason(front.cpu_percent, "cpu"),
        notes: frontNotes,
      },
      {
        variant: "covered",
        value: covered.cpu_percent,
        unit: "%",
        invalidReason: counterReason(covered.cpu_percent, "cpu"),
        notes: coveredNotes,
      },
      {
        variant: "front-wakeups",
        value: front.wakeups_per_s,
        unit: "per s",
        receipts: frontReceipts,
        invalidReason: counterReason(front.wakeups_per_s, "wakeup"),
        notes: frontNotes,
      },
      {
        variant: "covered-wakeups",
        value: covered.wakeups_per_s,
        unit: "per s",
        invalidReason: counterReason(covered.wakeups_per_s, "wakeup"),
        notes: coveredNotes,
      },
      {
        variant: "front-energy",
        value: front.energy_mw,
        unit: "mW",
        receipts: frontReceipts,
        invalidReason: counterReason(front.energy_mw, "energy"),
        notes: frontNotes,
      },
      {
        variant: "covered-energy",
        value: covered.energy_mw,
        unit: "mW",
        invalidReason: counterReason(covered.energy_mw, "energy"),
        notes: coveredNotes,
      },
    ]);
  },
};
