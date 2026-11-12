// The C3 chat-lock probe: one typed character every 2 s and its echo, with every lost probe kept in order
// (TESTS.md §4, C3). The probe is shared by C1 and C2; C3 reads the state it leaves behind.
import type { NativeLag } from "../../core/contracts.ts";
import type { TestContext } from "../../run/context.ts";
import { receipt } from "../../run/kit.ts";
import { launchPid } from "./shared.ts";

export const PROBE_COUNT = 30;
export const PROBE_INTERVAL_MS = 2_000;
export const PROBE_STATE_KEY = "C3.probes";
// The frames files of every probe segment in this block share one counter, so C1's repeats never overwrite.
export const PROBE_SEGMENT_KEY = "C3.probe.segments";
// C3 runs once, so every probe frames file belongs to its single repetition.
export const PROBE_RECEIPT_REP = 1;

export interface ProbeSample {
  /** When the probe character was posted. */
  t_ns: number;
  /** Echo latency in ms, or null when the probe was lost. */
  ms: number | null;
}

export interface ProbePause {
  start_ns: bigint;
  end_ns: bigint;
}

export interface LockRun {
  start_ns: number;
  end_ns: number;
  duration_ms: number;
}

export function recordedProbes(ctx: TestContext): ProbeSample[] {
  const stored = ctx.state.get(PROBE_STATE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (sample): sample is ProbeSample =>
      typeof sample === "object" &&
      sample !== null &&
      typeof (sample as ProbeSample).t_ns === "number" &&
      ((sample as ProbeSample).ms === null || typeof (sample as ProbeSample).ms === "number"),
  );
}

// A lock is a run of consecutive lost probes; it lasts from the first lost probe to the next echoed probe.
export function lockRuns(probes: readonly ProbeSample[]): LockRun[] {
  const locks: LockRun[] = [];
  let index = 0;
  while (index < probes.length) {
    if (probes[index]!.ms !== null) {
      index += 1;
      continue;
    }
    const first = index;
    while (index < probes.length && probes[index]!.ms === null) index += 1;
    const start = probes[first]!.t_ns;
    // A run with no following echo has no measured end: it stops at its last probe.
    const end = index < probes.length ? probes[index]!.t_ns : probes[index - 1]!.t_ns;
    locks.push({ start_ns: start, end_ns: end, duration_ms: Math.max(0, end - start) / 1_000_000 });
  }
  return locks;
}

export function longestLockMs(locks: readonly LockRun[]): number {
  return locks.reduce((longest, lock) => Math.max(longest, lock.duration_ms), 0);
}

// Probe segments until `untilNs`, skipping any 3 s pause window around a C2 follow-up. Every segment keeps a
// frames file, and every probe keeps its slot in `C3.probes` so the order of the lost ones survives.
export async function runProbe(
  ctx: TestContext,
  untilNs: bigint,
  pauses: readonly ProbePause[] = [],
  stopped: () => boolean = () => false,
): Promise<ProbeSample[]> {
  const region = ctx.adapter.calibration.composerRect;
  const pid = launchPid(ctx);
  if (region === null || pid === null) return recordedProbes(ctx);
  const dryRun = ctx.instruments.dryRun;
  let segments = 0;
  // A dry run measures nothing; one segment records the plan line and keeps the run short.
  while ((!dryRun || segments === 0) && !stopped() && ctx.instruments.now() < untilNs) {
    const opened = ctx.instruments.now();
    const inside = pauses.find((pause) => pause.start_ns <= opened && opened < pause.end_ns);
    if (inside !== undefined) {
      if (dryRun) break;
      await ctx.instruments.sleep(Number(inside.end_ns - opened) / 1_000_000);
      continue;
    }
    // A follow-up must land in a quiet composer, so a segment never crosses a pause window.
    const nextPause = pauses
      .filter((pause) => pause.start_ns > opened)
      .sort((left, right) => Number(left.start_ns - right.start_ns))[0];
    const segmentEnd = nextPause !== undefined && nextPause.start_ns < untilNs ? nextPause.start_ns : untilNs;
    const availableMs = Math.max(0, Number(segmentEnd - opened) / 1_000_000);
    const count = Math.max(1, Math.min(PROBE_COUNT, Math.ceil(availableMs / PROBE_INTERVAL_MS)));
    segments += 1;
    const number = nextSegmentNumber(ctx);
    const frames = receipt(ctx, "C3", PROBE_RECEIPT_REP, `probe-${String(number).padStart(2, "0")}.json`).abs;
    const measured = await ctx.instruments.lag({
      pid,
      region,
      count,
      intervalMs: PROBE_INTERVAL_MS,
      frames,
      clear: ctx.adapter.calibration.clearKeys,
    });
    recordSegment(ctx, opened, measured);
  }
  return recordedProbes(ctx);
}

function nextSegmentNumber(ctx: TestContext): number {
  const stored = ctx.state.get(PROBE_SEGMENT_KEY);
  const number = (typeof stored === "number" ? stored : 0) + 1;
  ctx.state.set(PROBE_SEGMENT_KEY, number);
  return number;
}

function recordSegment(ctx: TestContext, openedNs: bigint, measured: NativeLag): void {
  // probes_ms is the ordered array; samples_ms is the fallback for a native build without it.
  const probes = measured.probes_ms ?? measured.samples_ms;
  const samples = recordedProbes(ctx);
  const opened = Number(openedNs);
  probes.forEach((ms, index) => {
    samples.push({ t_ns: opened + index * PROBE_INTERVAL_MS * 1_000_000, ms: ms ?? null });
  });
  ctx.state.set(PROBE_STATE_KEY, samples);
}
