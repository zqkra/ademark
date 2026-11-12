// A7 Fight Weight: RAM of the app while 5 agents stream (TESTS.md §2 A7).
import { existsSync, readFileSync } from "node:fs";
import { median } from "../../core/stats.ts";
import type { ResultRow } from "../../core/contracts.ts";
import { sampleRulesFor, type TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { emptyReceipts, groupSeries, missingCalibration, readSamples, receipt } from "../../run/kit.ts";
import { SMOKE, smokeSeconds } from "../../run/smoke.ts";
import {
  SAMPLE_HZ,
  adapterStreamPlan,
  appPidsAt,
  elapsedMs,
  invalidVariantRows,
  launchPid,
  openStreams,
  p95Mb,
  agentRootExecutables,
  agentsSplit,
  missingStreams,
  perAgentSeries,
  streamCounts,
  streamOverlapSeconds,
  waitForLongerStreams,
  peakLifetimeMb,
  ticksWithAgents,
  weightRows,
} from "./shared.ts";

const TEST = "A7";
const VARIANTS = ["app-p95", "agents-p95", "total-p95", "app-peak", "per-agent-p95"] as const;
// Claude against Claude: the RAM of one agent and how many ran, next to the Bare CLI's (TESTS.md A7).
const MB_OUTPUTS = [...VARIANTS.map((variant) => ({ variant, unit: "MB" })), { variant: "agent-count", unit: "count" }];
const WINDOW_S = 180;
const AGENT_MINIMUM = 5;
// TESTS.md A7: 150 s of the 180 s window. The required ticks keep that fraction when a smoke window is short.
const AGENT_ACTIVE_FRACTION = 150 / 180;
const REQUIRED_REASON = (seconds: number): string => `fewer than 5 agents for ${seconds} s`;

function replayLog(ctx: TestContext): string | null {
  const replay = ctx.state.get("replay") as { logPath?: string } | undefined;
  if (replay?.logPath === undefined || !existsSync(replay.logPath)) return null;
  try {
    return readFileSync(replay.logPath, "utf8");
  } catch {
    return null;
  }
}

function replayOverlap(ctx: TestContext, sinceNs: number, streamSeconds: number): number | null {
  const log = replayLog(ctx);
  return log === null ? null : streamOverlapSeconds(log, sinceNs, streamSeconds);
}

export const fightWeight: TestRunner = {
  id: TEST,
  track: "A",
  repeats: () => 1,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep): Promise<ResultRow[]> => {
    const started = ctx.instruments.now();
    const pid = launchPid(ctx);
    const samples = receipt(ctx, TEST, rep, "samples.csv");
    const base = {
      testId: TEST,
      rep,
      server: ctx.options.server,
      receipts: { ...emptyReceipts(), samples: samples.rel },
      notes: "",
      durationMs: 0,
    };
    const missing = missingCalibration(ctx.adapter, ["newThread", "send"]);
    if (missing !== null) return invalidVariantRows(ctx, base, MB_OUTPUTS, missing);

    const streamsBefore = await streamCounts(ctx);
    const opensAtNs = Number(ctx.instruments.now());
    const plan = adapterStreamPlan(ctx.adapter);
    await openStreams(ctx, plan.streamSeconds);
    const windowS = smokeSeconds(ctx, WINDOW_S, SMOKE.a7WindowS);
    await ctx.instruments.sample({
      rules: sampleRulesFor(ctx.adapter, [pid]),
      hz: SAMPLE_HZ,
      durationS: windowS,
      csv: samples.abs,
    });
    const rows = readSamples(samples.abs);
    const app = groupSeries(rows, "app");
    const agents = groupSeries(rows, "agents");
    const total = groupSeries(rows, "total");
    const durationMs = elapsedMs(started, ctx.instruments.now());
    if (app.length === 0) return invalidVariantRows(ctx, { ...base, durationMs }, MB_OUTPUTS, "no app samples");

    const appPids = appPidsAt(rows);
    if (appPids.length > 0) {
      await ctx.instruments.footprint({ pids: appPids, out: receipt(ctx, TEST, rep, "footprint-app.json").abs });
    }
    const agentTicks = ticksWithAgents(rows, ctx.adapter.processes().agentExecutables, AGENT_MINIMUM);
    const requiredTicks = Math.round(AGENT_ACTIVE_FRACTION * windowS * SAMPLE_HZ);
    const requiredSeconds = Math.round(AGENT_ACTIVE_FRACTION * windowS);
    const streamsAfter = streamsBefore === null ? null : await streamCounts(ctx);
    const unsent = streamsBefore === null || streamsAfter === null ? [] : missingStreams(streamsBefore, streamsAfter);
    const overlap = streamsBefore === null ? null : replayOverlap(ctx, opensAtNs, plan.streamSeconds);
    const tooShort = overlap !== null && overlap < AGENT_ACTIVE_FRACTION * WINDOW_S;
    const valid = agentTicks >= requiredTicks && unsent.length === 0 && !tooShort;
    // Untimed, after the sample: longer streams must end before A8 opens its own five (review R3).
    const drained = ctx.instruments.dryRun ? null : await waitForLongerStreams(ctx.instruments, plan, opensAtNs, () => replayLog(ctx));
    if (drained !== null) {
      ctx.log(`A7: waited ${Math.round(drained.waitedMs / 1000)} s for the longer streams to end${drained.ended ? "" : " (bound reached)"}`);
    }
    const split = agentsSplit(rows);
    const perAgent = perAgentSeries(split);
    const executables = agentRootExecutables(rows);
    const notes = [
      `${agentTicks} ticks with >= ${AGENT_MINIMUM} agents`,
      `streams of ${plan.streamSeconds} s${plan.plannedOverlapS === null ? "" : `, planned overlap ${Math.round(plan.plannedOverlapS)} s`}`,
      ...(drained === null ? [] : [`waited ${Math.round(drained.waitedMs / 1000)} s for the streams to end${drained.ended ? "" : " (bound reached)"}`]),
      ...(executables.length > 0 ? [`agent executables: ${executables.join(", ")}`] : []),
    ].join("; ");
    return weightRows(
      ctx,
      {
        ...base,
        durationMs,
        notes,
        invalidReason: valid
          ? null
          : unsent.length > 0
          ? `streams never reached the model: ${unsent.map((stream) => `stream-${stream}`).join(", ")}`
          : tooShort
          ? `the five streams ran together only ${Math.round(overlap!)} s of the ${Math.round(AGENT_ACTIVE_FRACTION * WINDOW_S)} s needed`
          : REQUIRED_REASON(requiredSeconds),
      },
      [
        { variant: "app-p95", value: p95Mb(app), unit: "MB" },
        {
          variant: "agents-p95",
          value: agents.length === 0 ? null : p95Mb(agents),
          unit: "MB",
          invalidReason: agents.length === 0 ? "no agents samples" : undefined,
        },
        { variant: "total-p95", value: p95Mb(total), unit: "MB" },
        { variant: "app-peak", value: peakLifetimeMb(rows), unit: "MB" },
        {
          variant: "per-agent-p95",
          value: perAgent.length === 0 ? null : p95Mb(perAgent),
          unit: "MB",
          invalidReason: perAgent.length === 0 ? "no agents samples" : undefined,
        },
        { variant: "agent-count", value: median(split.counts), unit: "count" },
      ],
    );
  },
};
