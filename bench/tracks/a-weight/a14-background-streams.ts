// A14 Background Streams (pilot): the app's CPU while 5 agents stream, first with a streaming thread in front, then with
// a seeded idle thread in front and the 5 streams in the background (TESTS.md §2 A14). Do hidden threads still render?
import type { ResultRow, TestId } from "../../core/contracts.ts";
import { median } from "../../core/stats.ts";
import { sampleRulesFor, type TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { emptyReceipts, missingCalibration, readSamples, receipt, type SampleRow } from "../../run/kit.ts";
import { SMOKE, smokeSeconds } from "../../run/smoke.ts";
import { NativeError } from "../../core/native.ts";
import { SEED_FUZZY, SEED_MARKER, threadRectOf } from "../a-timing/shared.ts";
import {
  SAMPLE_HZ,
  STREAM_SECONDS,
  agentsSplit,
  elapsedMs,
  firstStreamEndNs,
  invalidVariantRows,
  missingStreams,
  openStreams,
  rateOutputs,
  replayLog,
  runningPid,
  streamCounts,
  ticksWithAgents,
  weightRows,
  windowRates,
  type Output,
} from "./shared.ts";

const TEST: TestId = "A14";
const WINDOW_S = 45;
// Both windows and the switch fit inside one 3-minute stream, with room for a slow app's starts (Orca: about 40 s).
const LEAD_MS = 5_000;
const SWITCH_TIMEOUT_S = 10;
const AGENT_MINIMUM = 5;
// A7's rule: five agents for 150 s of 180 s, the same share of each window.
const AGENT_ACTIVE_FRACTION = 150 / 180;
const WINDOWS = ["front", "background"] as const;
const OUTPUTS = [
  ...WINDOWS.flatMap((name) => [
    ...rateOutputs(`${name}-`, null).map(({ variant, unit }) => ({ variant, unit })),
    { variant: `${name}-agents-cpu`, unit: "%" },
  ]),
  { variant: "agent-count", unit: "count" },
];

function windowOutputs(name: string, rows: readonly SampleRow[], rel: string): Output[] {
  const receipts = { ...emptyReceipts(), samples: rel };
  return [
    ...rateOutputs(`${name}-`, windowRates(rows, "app")),
    { ...rateOutputs(`${name}-agents-`, windowRates(rows, "agents"))[0]! },
  ].map((output) => ({ ...output, receipts }));
}

async function sampleWindow(ctx: TestContext, pid: number, rep: number, name: string): Promise<{ rows: SampleRow[]; rel: string }> {
  const csv = receipt(ctx, TEST, rep, `samples-${name}.csv`);
  await ctx.instruments.sample({
    rules: sampleRulesFor(ctx.adapter, [pid]),
    hz: SAMPLE_HZ,
    durationS: smokeSeconds(ctx, WINDOW_S, SMOKE.a14WindowS),
    csv: csv.abs,
  });
  return { rows: readSamples(csv.abs), rel: csv.rel };
}

export const backgroundStreams: TestRunner = {
  id: TEST,
  track: "A",
  pilot: true,
  repeats: () => 1,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const switchFrames = receipt(ctx, TEST, rep, "frames-switch.json");
    const base = { testId: TEST, rep, server: ctx.options.server, receipts: emptyReceipts(), notes: "", durationMs: 0 };
    const missing = missingCalibration(ctx.adapter, ["newThread", "send", "threadRect", "shortThread"]);
    if (missing !== null) return invalidVariantRows(ctx, base, OUTPUTS, missing);

    const { pid, launched } = await runningPid(ctx);
    const streamsBefore = await streamCounts(ctx);
    const opensAtNs = Number(ctx.instruments.now());
    await openStreams(ctx);
    await ctx.instruments.sleep(smokeSeconds(ctx, LEAD_MS / 1000, 1) * 1000);
    const front = await sampleWindow(ctx, pid, rep, "front");

    // A seeded thread comes to the front; its marker on screen proves the streaming threads are hidden.
    let switchReason: string | null = null;
    try {
      const seen = await ctx.instruments.watch({
        pid,
        text: SEED_MARKER,
        fuzzy: SEED_FUZZY,
        region: threadRectOf(ctx),
        triggers: ctx.adapter.timed.shortThread ?? [],
        timeoutS: SWITCH_TIMEOUT_S,
        frames: switchFrames.abs,
      });
      if (seen.timed_out || seen.ms === null) switchReason = "no seeded thread came to the front";
    } catch (error) {
      if (!(error instanceof NativeError)) throw error;
      switchReason = `switch failed: ${error.message}`;
    }
    const background = switchReason === null ? await sampleWindow(ctx, pid, rep, "background") : null;
    const windowEndNs = Number(ctx.instruments.now());
    const durationMs = elapsedMs(started, ctx.instruments.now());

    // Validity, as A7: every stream reached the model, five agents ran through each window, and no stream had ended.
    const streamsAfter = streamsBefore === null ? null : await streamCounts(ctx);
    const unsent = streamsBefore === null || streamsAfter === null ? [] : missingStreams(streamsBefore, streamsAfter);
    const log = streamsBefore === null ? null : replayLog(ctx);
    const firstEnd = log === null ? null : firstStreamEndNs(log, opensAtNs, STREAM_SECONDS);
    const executables = ctx.adapter.processes().agentExecutables;
    const shortOf = (rows: readonly SampleRow[]): boolean => {
      const ticks = Math.round(AGENT_ACTIVE_FRACTION * smokeSeconds(ctx, WINDOW_S, SMOKE.a14WindowS) * SAMPLE_HZ);
      return ticksWithAgents(rows, executables, AGENT_MINIMUM) < ticks;
    };
    const blockReason =
      unsent.length > 0
        ? `streams never reached the model: ${unsent.map((stream) => `stream-${stream}`).join(", ")}`
        : firstEnd !== null && firstEnd < windowEndNs
        ? "a stream ended before the background window did"
        : null;
    const notes = [launched ? "launched for A14" : "app already running", "thread 1 in front, then a seeded thread"].join("; ");
    const rowBase = { ...base, durationMs, notes, invalidReason: blockReason };

    const frontOutputs = windowOutputs("front", front.rows, front.rel).map((output) =>
      shortOf(front.rows) ? { ...output, invalidReason: `fewer than 5 agents in the front window` } : output,
    );
    const backgroundOutputs =
      background === null
        ? OUTPUTS.filter((output) => output.variant.startsWith("background-")).map((output) => ({
            ...output,
            value: null,
            invalidReason: switchReason ?? undefined,
          }))
        : windowOutputs("background", background.rows, background.rel).map((output) =>
            shortOf(background.rows) ? { ...output, invalidReason: "fewer than 5 agents in the background window" } : output,
          );
    // Per window: two sample files can share tick times, and one split over both would add their agents together.
    const counts = [front.rows, background?.rows ?? []].flatMap((rows) => agentsSplit(rows).counts);
    return weightRows(ctx, rowBase, [
      ...frontOutputs,
      ...backgroundOutputs,
      { variant: "agent-count", value: counts.length === 0 ? null : median(counts), unit: "count" },
    ]);
  },
};
