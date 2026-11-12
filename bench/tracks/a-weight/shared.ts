// Shared code of the Track A weight runners and A12 (TESTS.md §0.1, §1.2, §2).
// Every pure computation is here, so the unit tests can feed it synthetic sample rows.
import { basename } from "node:path";
import type { Adapter, Receipts, ResultRow, Server, TestId } from "../../core/contracts.ts";
import { profileStreamSetupMs } from "../../adapters/profile.ts";
import { median, quantile } from "../../core/stats.ts";
import type { TestContext } from "../../run/context.ts";
import { BYTES_PER_MB, invalidRow, type SampleRow } from "../../run/kit.ts";
import { isAgentExecutable } from "../../core/agents.ts";
import { SMOKE, smokeSeconds } from "../../run/smoke.ts";

// TESTS.md §1.2: the sampler runs at 4 Hz.
export const SAMPLE_HZ = 4;

// TESTS.md A5: the `app` group counts as settled under 1 MB/min over a 60 s window, capped at 10 min.
export const SETTLE_MB_PER_MIN = 1;
export const SETTLE_WINDOW_NS = 60 * 1e9;

// TESTS.md A7: the five streams are opened in this order, so thread 1 ends in front.
export const STREAM_ORDER: readonly number[] = [2, 3, 4, 5, 1];
export const STREAM_GAP_MS = 2_000;

export interface SeriesPoint {
  t_ns: number;
  bytes: number;
}

export interface Tick {
  t_ns: number;
  rows: SampleRow[];
}

function mean(xs: readonly number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

// Rows grouped per sampler tick (all rows of one tick share t_ns), oldest first.
export function ticks(rows: readonly SampleRow[]): Tick[] {
  const byTick = new Map<number, SampleRow[]>();
  for (const row of rows) {
    const list = byTick.get(row.t_ns);
    if (list === undefined) byTick.set(row.t_ns, [row]);
    else list.push(row);
  }
  return [...byTick.entries()]
    .sort(([left], [right]) => left - right)
    .map(([t_ns, tickRows]) => ({ t_ns, rows: tickRows }));
}

// One process alone, which is what Activity Monitor readers compare against (TESTS.md A5 `main`).
export function pidSeries(rows: readonly SampleRow[], pid: number): SeriesPoint[] {
  return rows
    .filter((row) => row.pid === pid)
    .map((row) => ({ t_ns: row.t_ns, bytes: row.phys_footprint_b }))
    .sort((left, right) => left.t_ns - right.t_ns);
}

// Two sample runs of the settle phase can both tick on the boundary instant. Summing that tick twice
// would put a false spike in the series, so the later duplicate is dropped.
export function mergeSampleRows(chunks: ReadonlyArray<readonly SampleRow[]>): SampleRow[] {
  const seen = new Set<number>();
  const merged: SampleRow[] = [];
  for (const chunk of chunks) {
    const duplicated = new Set<number>();
    for (const row of chunk) {
      if (seen.has(row.t_ns)) duplicated.add(row.t_ns);
    }
    for (const row of chunk) {
      seen.add(row.t_ns);
      if (!duplicated.has(row.t_ns)) merged.push(row);
    }
  }
  return merged;
}

export function tailWindow(series: readonly SeriesPoint[], windowNs: number): SeriesPoint[] {
  if (series.length === 0) return [];
  const last = series[series.length - 1]!.t_ns;
  const from = last - windowNs;
  return series.filter((point) => point.t_ns >= from);
}

// Least-squares slope in MB/min; NaN when there is no line to fit (fewer than 2 points, or one instant).
export function slopeMbPerMin(series: readonly SeriesPoint[]): number {
  if (series.length < 2) return Number.NaN;
  const t0 = series[0]!.t_ns;
  const xs = series.map((point) => (point.t_ns - t0) / 60e9);
  const ys = series.map((point) => point.bytes / BYTES_PER_MB);
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index]! - mx;
    sxy += dx * (ys[index]! - my);
    sxx += dx * dx;
  }
  return sxx === 0 ? Number.NaN : sxy / sxx;
}

export function isSettled(slope: number): boolean {
  return slope < SETTLE_MB_PER_MIN;
}

export function medianMb(series: readonly SeriesPoint[]): number {
  return quantile(series.map((point) => point.bytes), 0.5) / BYTES_PER_MB;
}

export function p95Mb(series: readonly SeriesPoint[]): number {
  return quantile(series.map((point) => point.bytes), 0.95) / BYTES_PER_MB;
}

export interface AgentsSplit {
  /** RAM of the agents group per tick; a tick with no agent counts as zero. */
  agents: SeriesPoint[];
  /** RAM of app plus agents per tick. */
  total: SeriesPoint[];
  /** Agents per tick: each subtree rooted at an agent counts once, its git and test children do not. */
  counts: number[];
}

// An ADE can look heavy only because of the Claude sessions it keeps alive. Every tick of the window counts, so an
// app with no agents reads 0 MB instead of having no number.
export function agentsSplit(rows: readonly SampleRow[]): AgentsSplit {
  const ticks = new Map<number, SampleRow[]>();
  for (const row of rows) ticks.set(row.t_ns, [...(ticks.get(row.t_ns) ?? []), row]);
  const agents: SeriesPoint[] = [];
  const total: SeriesPoint[] = [];
  const counts: number[] = [];
  for (const t_ns of [...ticks.keys()].sort((left, right) => left - right)) {
    const tick = ticks.get(t_ns)!;
    const agentRows = tick.filter((row) => row.group === "agents");
    const agentPids = new Set(agentRows.map((row) => row.pid));
    const agentBytes = agentRows.reduce((sum, row) => sum + row.phys_footprint_b, 0);
    const appBytes = tick.filter((row) => row.group === "app").reduce((sum, row) => sum + row.phys_footprint_b, 0);
    agents.push({ t_ns, bytes: agentBytes });
    total.push({ t_ns, bytes: appBytes + agentBytes });
    counts.push(agentRows.filter((row) => !agentPids.has(row.ppid)).length);
  }
  return { agents, total, counts };
}

// RAM of one agent: each tick's agents sum over its agent count. Compared with the Bare CLI, this shows whether an
// ADE's way of running Claude costs more than Claude itself.
export function perAgentSeries(split: AgentsSplit): SeriesPoint[] {
  return split.agents.flatMap((point, index) => {
    const count = split.counts[index] ?? 0;
    return count > 0 ? [{ t_ns: point.t_ns, bytes: point.bytes / count }] : [];
  });
}

// The binaries at the root of each agent subtree. A bundled Claude Code carries its version in its path.
export function agentRootExecutables(rows: readonly SampleRow[]): string[] {
  const byTick = new Map<number, Set<number>>();
  for (const row of rows) {
    if (row.group !== "agents") continue;
    byTick.set(row.t_ns, (byTick.get(row.t_ns) ?? new Set()).add(row.pid));
  }
  const roots = new Set<string>();
  for (const row of rows) {
    if (row.group === "agents" && !byTick.get(row.t_ns)!.has(row.ppid)) roots.add(row.exe);
  }
  return [...roots].sort();
}

// TESTS.md A7 `app-peak`: the highest lifetime maximum the `app` group ever reached, so each tick sums its processes.
export function peakLifetimeMb(rows: readonly SampleRow[]): number {
  const ticks = new Map<number, number>();
  for (const row of rows) {
    if (row.group === "app") ticks.set(row.t_ns, (ticks.get(row.t_ns) ?? 0) + row.lifetime_max_b);
  }
  return ticks.size === 0 ? Number.NaN : Math.max(...ticks.values()) / BYTES_PER_MB;
}

export interface AppRates {
  /** `app` pids present in both ticks of the window. */
  pids: number;
  dt_ns: number;
  cpu_percent: number | null;
  wakeups_per_s: number | null;
  energy_mw: number | null;
  /** Pids whose counter was unreadable in the first or the last tick. */
  skipped: { cpu: number; wakeups: number; energy: number };
}

function readable(...values: readonly number[]): boolean {
  return values.every((value) => value >= 0);
}

// TESTS.md A6: deltas over the pids of the `app` group present in the first and the last tick.
// A counter of -1 is not readable, so it is skipped instead of counted as zero.
export function appRates(first: Tick, last: Tick): AppRates {
  const before = new Map(first.rows.filter((row) => row.group === "app").map((row) => [row.pid, row]));
  const after = last.rows.filter((row) => row.group === "app" && before.has(row.pid));
  const dt_ns = last.t_ns - first.t_ns;
  const skipped = { cpu: 0, wakeups: 0, energy: 0 };
  let cpuDelta = 0;
  let cpuPids = 0;
  let wakeupDelta = 0;
  let wakeupPids = 0;
  let energyDelta = 0;
  let energyPids = 0;

  for (const row of after) {
    const previous = before.get(row.pid)!;
    if (readable(previous.cpu_user_ns, previous.cpu_sys_ns, row.cpu_user_ns, row.cpu_sys_ns)) {
      cpuDelta += row.cpu_user_ns + row.cpu_sys_ns - (previous.cpu_user_ns + previous.cpu_sys_ns);
      cpuPids += 1;
    } else skipped.cpu += 1;
    if (readable(previous.wakeups_idle, previous.wakeups_irq, row.wakeups_idle, row.wakeups_irq)) {
      wakeupDelta += row.wakeups_idle + row.wakeups_irq - (previous.wakeups_idle + previous.wakeups_irq);
      wakeupPids += 1;
    } else skipped.wakeups += 1;
    if (readable(previous.energy_nj, row.energy_nj)) {
      energyDelta += row.energy_nj - previous.energy_nj;
      energyPids += 1;
    } else skipped.energy += 1;
  }

  const usable = dt_ns > 0 && after.length > 0;
  return {
    pids: after.length,
    dt_ns,
    cpu_percent: usable && cpuPids > 0 ? (cpuDelta / dt_ns) * 100 : null,
    wakeups_per_s: usable && wakeupPids > 0 ? wakeupDelta / (dt_ns / 1e9) : null,
    energy_mw: usable && energyPids > 0 ? (energyDelta / dt_ns) * 1000 : null,
    skipped,
  };
}

// TESTS.md A7: how many sampler ticks had at least `minimum` live agent processes.
export function ticksWithAgents(
  rows: readonly SampleRow[],
  agentExecutables: readonly string[],
  minimum: number,
): number {
  let count = 0;
  for (const tick of ticks(rows)) {
    const live = tick.rows.filter((row) => row.group === "agents" && isAgentExecutable(row.exe, agentExecutables)).length;
    if (live >= minimum) count += 1;
  }
  return count;
}

export function mbPerThread(restMb: number, baselineMb: number, threads = 15): number {
  return (restMb - baselineMb) / threads;
}

// TESTS.md A12: the window is the first 30 minutes when the block ran that long.
export function firstWindowMinutes(series: readonly SeriesPoint[], minutes: number): SeriesPoint[] {
  if (series.length === 0) return [];
  const limit = series[0]!.t_ns + minutes * 60e9;
  return series.filter((point) => point.t_ns <= limit);
}

// One point per full minute: the median of that minute's ticks, at the minute's midpoint.
// 4 Hz ticks 250 ms apart are strongly autocorrelated, so an interval fitted on them would be far too
// narrow; the per-minute median is the independent unit A12 publishes (TESTS.md §2 A12).
// `series` must be oldest first; a trailing minute that does not reach its end is dropped.
export function minuteMedians(series: readonly SeriesPoint[]): SeriesPoint[] {
  if (series.length === 0) return [];
  const minuteNs = 60 * 1e9;
  const t0 = series[0]!.t_ns;
  const buckets = new Map<number, number[]>();
  for (const point of series) {
    const minute = Math.floor((point.t_ns - t0) / minuteNs);
    const bytes = buckets.get(minute);
    if (bytes === undefined) buckets.set(minute, [point.bytes]);
    else bytes.push(point.bytes);
  }
  const end = series[series.length - 1]!.t_ns;
  const points: SeriesPoint[] = [];
  for (const minute of [...buckets.keys()].sort((left, right) => left - right)) {
    const start = t0 + minute * minuteNs;
    if (end < start + minuteNs) break;
    points.push({ t_ns: start + minuteNs / 2, bytes: median(buckets.get(minute)!) });
  }
  return points;
}

export function seriesMinutes(series: readonly SeriesPoint[]): number {
  if (series.length < 2) return 0;
  return (series[series.length - 1]!.t_ns - series[0]!.t_ns) / 60e9;
}

export interface LeakSlope {
  slope_mb_per_h: number;
  se: number;
  lo: number;
  hi: number;
  ticks: number;
  minutes: number;
}

// TESTS.md A12: least-squares slope in MB/h with the 95 % interval slope ± 1.96 × standard error.
// The interval assumes independent points, so the caller must reduce autocorrelated ticks first:
// A12 fits `minuteMedians(...)`, not the raw 4 Hz series.
export function leakSlope(series: readonly SeriesPoint[]): LeakSlope {
  const n = series.length;
  if (n < 2) throw new Error("leakSlope: needs at least 2 ticks");
  const t0 = series[0]!.t_ns;
  const xs = series.map((point) => (point.t_ns - t0) / 3.6e12);
  const ys = series.map((point) => point.bytes / BYTES_PER_MB);
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < n; index++) {
    const dx = xs[index]! - mx;
    sxy += dx * (ys[index]! - my);
    sxx += dx * dx;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let index = 0; index < n; index++) {
    const residual = ys[index]! - (intercept + slope * xs[index]!);
    sse += residual * residual;
  }
  // Two points fit exactly, so the residuals say nothing about the noise: no interval is estimable then.
  const se = n > 2 && sxx > 0 ? Math.sqrt(sse / (n - 2) / sxx) : 0;
  return {
    slope_mb_per_h: slope,
    se,
    lo: slope - 1.96 * se,
    hi: slope + 1.96 * se,
    ticks: n,
    minutes: (series[n - 1]!.t_ns - t0) / 60e9,
  };
}

// The `app` pids of the last tick, the ones `footprint` de-duplicates at the end of a window.
export function appPidsAt(rows: readonly SampleRow[]): number[] {
  const all = ticks(rows);
  const last = all[all.length - 1];
  if (last === undefined) return [];
  return last.rows.filter((row) => row.group === "app").map((row) => row.pid);
}

// TESTS.md A9: the processes still attributed to the ADE, listed by name.
export function processList(rows: readonly SampleRow[]): Array<{ pid: number; name: string }> {
  const all = ticks(rows);
  const last = all[all.length - 1];
  if (last === undefined) return [];
  const names = new Map<number, string>();
  for (const row of last.rows) names.set(row.pid, basename(row.exe));
  return [...names.entries()]
    .map(([pid, name]) => ({ pid, name }))
    .sort((left, right) => left.pid - right.pid);
}

export function elapsedMs(start: number | bigint, end: number | bigint): number {
  return Number(end - start) / 1e6;
}

export function launchPid(ctx: TestContext): number {
  const pid = ctx.state.get("launch_pid");
  return typeof pid === "number" ? pid : 0;
}

// TESTS.md A7, A8 and A10 open the same five streams in the same order, 2 s apart.
// A7 alone passes a longer stream (streamPlan); A8 and A10 keep today's.
export async function openStreams(ctx: TestContext, streamSeconds: number = STREAM_SECONDS): Promise<void> {
  const gapMs = smokeSeconds(ctx, STREAM_GAP_MS / 1000, SMOKE.streamGapS) * 1000;
  for (const stream of STREAM_ORDER) {
    await ctx.adapter.newThread(ctx.adapterCtx);
    await ctx.adapter.send(ctx.adapterCtx, streamPrompt(stream, streamSeconds));
    await ctx.instruments.sleep(gapMs);
  }
}

export interface Output {
  variant: string;
  value: number | null;
  unit: string;
  /** Fixed invalid reason; a null value without one is invalid as `no <variant> value`. */
  invalidReason?: string;
  notes?: string;
  receipts?: Receipts;
}

export interface RowBase {
  testId: TestId;
  rep: number;
  durationMs: number;
  server: Server;
  receipts: Receipts;
  notes: string;
  /** Set when every row of this repetition is invalid, for example after a failed gate. */
  invalidReason?: string | null;
}

// The shape of a repetition that could not measure: one invalid row per output, with that reason.
export function invalidVariantRows(
  ctx: TestContext,
  base: RowBase,
  outputs: ReadonlyArray<Pick<Output, "variant" | "unit">>,
  reason: string,
): ResultRow[] {
  return weightRows(
    ctx,
    { ...base, invalidReason: reason },
    outputs.map((output) => ({ variant: output.variant, unit: output.unit, value: null })),
  );
}

// One row per output, with `variant` naming the output (TESTS.md §0.1). Invalid rows keep no value.
export function weightRows(ctx: TestContext, base: RowBase, outputs: readonly Output[]): ResultRow[] {
  return outputs.map((output) => {
    const fields = {
      test_id: base.testId,
      variant: output.variant,
      rep: base.rep,
      server: base.server,
      unit: output.unit,
      duration_ms: base.durationMs,
      receipts: output.receipts ?? base.receipts,
      notes:
        output.notes === undefined
          ? base.notes
          : [base.notes, output.notes].filter((note) => note.length > 0).join("; "),
    };
    const reason =
      base.invalidReason ?? output.invalidReason ?? (output.value === null ? `no ${output.variant} value` : null);
    if (reason !== null && reason !== undefined) return invalidRow(ctx, fields, reason);
    return ctx.row({ ...fields, value: output.value!, valid: true, invalid_reason: null });
  });
}

// A7, council 2026-11-07: five live agent processes do not prove five streams; agents kept from seeding pass that
// count. The replay server's own count per stream does: each stream must have been requested during this window.
export function missingStreams(before: Record<string, number>, after: Record<string, number>): number[] {
  return STREAM_ORDER.filter((stream) => (after[`stream-${stream}`] ?? 0) <= (before[`stream-${stream}`] ?? 0));
}

// Each A7 stream lasts this long on the replay server (TESTS.md A7: the same 3-minute stream).
export const STREAM_SECONDS = 180;
// TESTS.md A7: the five streams must run together this long.
export const STREAM_OVERLAP_NEEDED_S = 150;
// Room for what the setup time does not count (key posting, a slow focus) when a stream is made longer.
export const STREAM_MARGIN_S = 20;

export interface StreamPlan {
  /** Fixed setup time of one stream (newThread and send), or null when the adapter has no profile to read it from. */
  setupMs: number | null;
  gapMs: number;
  /** How long each stream lasts on the replay server. */
  streamSeconds: number;
  /** streamSeconds minus the spread of the five starts; null without a setup time. */
  plannedOverlapS: number | null;
}

/**
 * ADEMARK-41: the A7 stream length of one adapter. 2026-11-09: Orca's five streams overlapped 139 s of the 150 s needed,
 * because each start took about 10 s. A profile whose five starts already leave 150 s keeps today's length, so its
 * conditions do not change; a slower one gets today's length plus the spread of its starts plus a margin.
 */
export function streamPlan(setupMs: number | null, gapMs: number = STREAM_GAP_MS): StreamPlan {
  if (setupMs === null) return { setupMs, gapMs, streamSeconds: STREAM_SECONDS, plannedOverlapS: null };
  const spreadS = ((STREAM_ORDER.length - 1) * (setupMs + gapMs)) / 1000;
  const streamSeconds =
    STREAM_SECONDS - spreadS >= STREAM_OVERLAP_NEEDED_S ? STREAM_SECONDS : Math.ceil(STREAM_SECONDS + spreadS + STREAM_MARGIN_S);
  return { setupMs, gapMs, streamSeconds, plannedOverlapS: streamSeconds - spreadS };
}

// ADEMARK-53: the time from one stream's first request to the next one's, as a real night measured it, for an app whose
// starts take longer than the profile's waits say. 2026-11-10, Emdash: 9.5 s in all six bursts (A7, A8, A10) of
// control-2026-11-10T08-31-19Z-emdash-1 and -topup-1 (a-replay.jsonl), so 38 s from the first start to the fifth, against
// 4.8 s planned (19 s). Its newThread wrapper (emdash.ts) clicks the project page twice (800 ms each) and the repository
// setting five times (400 ms each), 3.6 s the profile's waits do not hold, and the clicks and the app take about 1 s more.
export const MEASURED_STREAM_START_MS: Readonly<Record<string, number>> = { emdash: 9_500 };

/** A7's plan for one adapter: the profile's estimate, or the measured start interval when that is longer. */
export function adapterStreamPlan(adapter: Adapter): StreamPlan {
  const setupMs = profileStreamSetupMs(adapter);
  const measured = MEASURED_STREAM_START_MS[adapter.id];
  if (setupMs === null || measured === undefined) return streamPlan(setupMs);
  return streamPlan(Math.max(setupMs, measured - STREAM_GAP_MS));
}

// The replay server reads ` @<seconds>s` after a stream's match and makes that stream last so long (session.ts).
export function streamPrompt(stream: number, streamSeconds: number): string {
  return streamSeconds === STREAM_SECONDS ? `replay:stream-${stream}` : `replay:stream-${stream} @${streamSeconds}s`;
}

/**
 * How long all five streams ran at once, from the time the replay server first got each one after `sinceNs`. Null
 * when there is no replay log to read (a live-model app, a dry run). Council 2026-11-08: Orca's 7.5 s per thread spread
 * the starts over about 40 s, and agent processes alone kept A7 valid with only about 140 s of real overlap.
 */
export function streamOverlapSeconds(log: string, sinceNs: number, streamSeconds: number = STREAM_SECONDS): number | null {
  const firsts = new Map<string, number>();
  for (const line of log.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: { t_ns?: number; session?: string | null };
    try {
      entry = JSON.parse(line) as { t_ns?: number; session?: string | null };
    } catch {
      continue;
    }
    if (typeof entry.t_ns !== "number" || entry.t_ns < sinceNs || typeof entry.session !== "string") continue;
    if (!entry.session.startsWith("stream-")) continue;
    if (!firsts.has(entry.session)) firsts.set(entry.session, entry.t_ns);
  }
  if (firsts.size < STREAM_ORDER.length) return null;
  const starts = [...firsts.values()];
  return streamSeconds - (Math.max(...starts) - Math.min(...starts)) / 1e9;
}

// Review R3, 2026-11-10: the bound on the wait for longer streams, past the planned spread and stream length. It covers
// the tool round trip before each long turn. The tail is the room after a long turn's planned end for its last chunks.
export const STREAM_DRAIN_MARGIN_S = 15;
const STREAM_TAIL_S = 5;
const STREAM_DRAIN_POLL_MS = 5_000;

/** The last request of each A7 stream after `sinceNs`, from the replay log. A stream's long turn starts there. */
export function lastStreamRequestsNs(log: string, sinceNs: number): Map<string, number> {
  const lasts = new Map<string, number>();
  for (const line of log.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: { t_ns?: number; session?: string | null };
    try {
      entry = JSON.parse(line) as { t_ns?: number; session?: string | null };
    } catch {
      continue;
    }
    if (typeof entry.t_ns !== "number" || entry.t_ns < sinceNs || typeof entry.session !== "string") continue;
    if (!entry.session.startsWith("stream-")) continue;
    lasts.set(entry.session, Math.max(lasts.get(entry.session) ?? 0, entry.t_ns));
  }
  return lasts;
}

export interface DrainClock {
  now(): bigint;
  sleep(ms: number): Promise<void>;
}

/**
 * Review R3, 2026-11-10: when A7 made its streams longer (Orca: 240 s), they run past A7's sample window, and A8 would
 * type with more than five streams running. So A7 waits, untimed, until each stream's last request plus the stream
 * length has passed, bounded by the planned spread of the starts plus the stream length plus a margin from the opens.
 * Streams of today's length return null at once: A7 is then exactly as before.
 */
export async function waitForLongerStreams(
  clock: DrainClock,
  plan: StreamPlan,
  sinceNs: number,
  readLog: () => string | null,
): Promise<{ waitedMs: number; ended: boolean } | null> {
  if (plan.streamSeconds === STREAM_SECONDS || plan.plannedOverlapS === null) return null;
  const spreadS = plan.streamSeconds - plan.plannedOverlapS;
  const boundNs = sinceNs + (spreadS + plan.streamSeconds + STREAM_DRAIN_MARGIN_S) * 1e9;
  const startedNs = Number(clock.now());
  const target = (): { atNs: number; ended: boolean } => {
    const log = readLog();
    const lasts = log === null ? new Map<string, number>() : lastStreamRequestsNs(log, sinceNs);
    if (lasts.size < STREAM_ORDER.length) return { atNs: boundNs, ended: false };
    const endNs = Math.max(...lasts.values()) + (plan.streamSeconds + STREAM_TAIL_S) * 1e9;
    return endNs <= boundNs ? { atNs: endNs, ended: true } : { atNs: boundNs, ended: false };
  };
  // The poll count is bounded too, so a clock that does not move can never hold the block.
  const maxPolls = Math.ceil((boundNs - Math.min(startedNs, boundNs)) / 1e6 / STREAM_DRAIN_POLL_MS) + 1;
  let goal = target();
  for (let poll = 0; poll < maxPolls && Number(clock.now()) < goal.atNs; poll++) {
    await clock.sleep(Math.min(STREAM_DRAIN_POLL_MS, Math.ceil((goal.atNs - Number(clock.now())) / 1e6)));
    goal = target();
  }
  return { waitedMs: Math.max(0, (Number(clock.now()) - startedNs) / 1e6), ended: goal.ended && Number(clock.now()) >= goal.atNs };
}

export async function streamCounts(ctx: TestContext): Promise<Record<string, number> | null> {
  if (ctx.instruments.dryRun) return null;
  const replay = ctx.state.get("replay") as { stats(): Promise<{ by_session: Record<string, number> }> } | undefined;
  if (replay === undefined) return null;
  try {
    return { ...(await replay.stats()).by_session };
  } catch {
    // No count means no check, never a stopped block.
    return null;
  }
}
