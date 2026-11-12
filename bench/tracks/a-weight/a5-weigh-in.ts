// A5 Weigh-in: RAM of the app at rest (TESTS.md §2 A5).
import type { ResultRow } from "../../core/contracts.ts";
import { sampleRulesFor, type TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { BYTES_PER_MB, emptyReceipts, groupSeries, readSamples, receipt, type SampleRow } from "../../run/kit.ts";
import { NOT_SUPPORTED } from "../../calibrate/pass.ts";
import { median } from "../../core/stats.ts";
import { SMOKE, smokeSeconds } from "../../run/smoke.ts";
import {
  SAMPLE_HZ,
  SETTLE_WINDOW_NS,
  agentsSplit,
  appPidsAt,
  elapsedMs,
  invalidVariantRows,
  isSettled,
  launchPid,
  medianMb,
  mergeSampleRows,
  pidSeries,
  slopeMbPerMin,
  tailWindow,
  weightRows,
} from "./shared.ts";

const TEST = "A5";
const MB_VARIANTS = ["app", "main", "dedup", "windowserver-delta", "agents"] as const;
// The app alone, the agents it keeps alive at rest, and what the Mac pays for both (TESTS.md A5).
const OUTPUTS = [
  ...MB_VARIANTS.map((variant) => ({ variant, unit: "MB" })),
  { variant: "agent-count", unit: "count" },
  { variant: "total", unit: "MB" },
];
const SETTLE_CHUNK_S = 20;
const SETTLE_CAP_S = 600;
const WINDOW_S = 60;

interface Settle {
  settled: boolean;
  seconds: number;
}

// A5 step 1: 20 s chunks, a line through the last 60 s of the `app` series, stop under 1 MB/min.
async function settle(ctx: TestContext, rep: number, pid: number, capS: number): Promise<Settle> {
  const chunks: SampleRow[][] = [];
  const chunkCount = Math.ceil(capS / SETTLE_CHUNK_S);
  let seconds = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    const csv = receipt(ctx, TEST, rep, `settle-${String(chunk).padStart(2, "0")}.csv`);
    await ctx.instruments.sample({
      rules: sampleRulesFor(ctx.adapter, [pid]),
      hz: SAMPLE_HZ,
      durationS: SETTLE_CHUNK_S,
      csv: csv.abs,
    });
    chunks.push(readSamples(csv.abs));
    seconds += SETTLE_CHUNK_S;
    const window = tailWindow(groupSeries(mergeSampleRows(chunks), "app"), SETTLE_WINDOW_NS);
    if (window.length >= 2 && isSettled(slopeMbPerMin(window))) return { settled: true, seconds };
  }
  return { settled: false, seconds };
}

interface WindowServerReading {
  mb: number | null;
  note: string;
}

// TESTS.md A5: memory that lands in WindowServer because of the ADE's windows, before and after the window.
// WindowServer runs as another user, so procs() usually does not list it; pgrep still finds it by name.
async function windowServerFootprint(ctx: TestContext, rep: number, tag: string): Promise<WindowServerReading> {
  const listed = (await ctx.instruments.procs()).find((proc) => proc.name === "WindowServer");
  const pid = listed?.pid ?? (await ctx.instruments.pidOf("WindowServer"));
  if (pid === null) return { mb: null, note: "procs and pgrep found no WindowServer" };
  const out = receipt(ctx, TEST, rep, `windowserver-${tag}.json`);
  const footprint = await ctx.instruments.footprint({ pids: [pid], out: out.abs });
  return { mb: footprint.total_b / BYTES_PER_MB, note: "" };
}

// An app whose agents run detached from it (Diri: ppid 1, own responsible pid) would read 0 MB of agents and a total too
// low; its profile excludes that part with a reason instead (excludeTests "A5:agents").
function agentOutputs(ctx: TestContext, split: ReturnType<typeof agentsSplit>) {
  const excluded = ctx.adapter.excludedTests?.["A5:agents"];
  const reason = excluded === undefined ? undefined : `${NOT_SUPPORTED} here: ${excluded}`;
  return [
    { variant: "agents", value: reason === undefined ? medianMb(split.agents) : null, unit: "MB", invalidReason: reason },
    { variant: "agent-count", value: reason === undefined ? median(split.counts) : null, unit: "count", invalidReason: reason },
    { variant: "total", value: reason === undefined ? medianMb(split.total) : null, unit: "MB", invalidReason: reason },
  ];
}

export const weighIn: TestRunner = {
  id: TEST,
  track: "A",
  repeats: () => 1,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const pid = launchPid(ctx);
    const receipts = { ...emptyReceipts() };
    const base = { testId: TEST, rep, server: ctx.options.server, receipts, notes: "", durationMs: 0 };
    const settleCapS = smokeSeconds(ctx, SETTLE_CAP_S, SMOKE.a5SettleCapS);
    const windowS = smokeSeconds(ctx, WINDOW_S, SMOKE.a5WindowS);

    const settled = await settle(ctx, rep, pid, settleCapS);
    const gatesBefore = await ctx.instruments.gates();
    const windowserverBefore = await windowServerFootprint(ctx, rep, "start");

    const samples = receipt(ctx, TEST, rep, "samples.csv");
    receipts.samples = samples.rel;
    await ctx.instruments.sample({
      rules: sampleRulesFor(ctx.adapter, [pid]),
      hz: SAMPLE_HZ,
      durationS: windowS,
      csv: samples.abs,
    });
    const rows = readSamples(samples.abs);
    const appPids = appPidsAt(rows);
    const dedup =
      appPids.length === 0
        ? null
        : await ctx.instruments.footprint({ pids: appPids, out: receipt(ctx, TEST, rep, "footprint-app.json").abs });
    const windowserverAfter = await windowServerFootprint(ctx, rep, "end");
    const gatesAfter = await ctx.instruments.gates();

    const app = groupSeries(rows, "app");
    const windowServerMissing = windowserverBefore.mb === null || windowserverAfter.mb === null;
    const windowServerNote = [...new Set([windowserverBefore.note, windowserverAfter.note])]
      .filter((note) => note.length > 0)
      .join("; ");
    const notes = [
      settled.settled ? `settle ${settled.seconds} s` : `did not settle; settle ${settled.seconds} s`,
      windowServerNote,
    ]
      .filter((note) => note.length > 0)
      .join("; ");
    const durationMs = elapsedMs(started, ctx.instruments.now());
    const rowBase = { ...base, durationMs, notes };
    if (app.length === 0) return invalidVariantRows(ctx, rowBase, OUTPUTS, "no app samples");

    const appMedianMb = medianMb(app);
    const main = pidSeries(rows, pid);
    ctx.state.set("A5.app_median_b", appMedianMb * BYTES_PER_MB);
    ctx.state.set("A5.samples_csv", samples.abs);
    ctx.state.set("A5.samples_rel", samples.rel);
    const windowServerDelta = windowServerMissing ? null : windowserverAfter.mb! - windowserverBefore.mb!;
    const swapGrew = gatesAfter.swap_used_mb > gatesBefore.swap_used_mb;
    const split = agentsSplit(rows);

    return weightRows(
      ctx,
      { ...rowBase, invalidReason: swapGrew ? "swap grew" : null },
      [
        { variant: "app", value: appMedianMb, unit: "MB" },
        {
          variant: "main",
          value: main.length === 0 ? null : medianMb(main),
          unit: "MB",
          invalidReason: main.length === 0 ? "no launch pid samples" : undefined,
        },
        {
          variant: "dedup",
          value: dedup === null ? null : dedup.total_b / BYTES_PER_MB,
          unit: "MB",
          invalidReason: dedup === null ? "no app pids" : undefined,
        },
        {
          variant: "windowserver-delta",
          value: windowServerDelta,
          unit: "MB",
          invalidReason: windowServerMissing ? `windowserver not measured: ${windowServerNote}` : undefined,
        },
        ...agentOutputs(ctx, split),
      ],
    );
  },
};
