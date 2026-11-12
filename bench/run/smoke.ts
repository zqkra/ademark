// Every number smoke mode uses lives here (TESTS.md §1.3): one repetition per test with short windows.
// A smoke run is the night's rehearsal and the calibration gate, and is never published.
export const SMOKE = {
  /** TESTS.md §2: the block seeds 5 threads; the rehearsal needs 2. */
  seedThreads: 2,
  /** A5: settle cap and measuring window, in seconds. */
  a5SettleCapS: 20,
  a5WindowS: 5,
  /** A6: measuring window, cover duration and the lead between covering and sampling, in seconds. */
  a6WindowS: 5,
  a6CoverS: 7,
  a6CoverLeadS: 2,
  /** A7: the streams window, in seconds. */
  a7WindowS: 20,
  /** A8: probe count at the same 250 ms cadence. */
  a8Probes: 10,
  /** A9: the wait after quit, in seconds. */
  a9WaitS: 5,
  /** A10: extra threads and the rest window, in seconds. */
  a10ExtraThreads: 3,
  a10WindowS: 5,
  /** A7, A8, A10: the gap between opening the five streams (full run 2 s). */
  streamGapS: 0.5,
} as const;

export function smokeSeconds(ctx: { smoke: boolean }, fullSeconds: number, smokeSecondsValue: number): number {
  return ctx.smoke ? smokeSecondsValue : fullSeconds;
}

export function smokeCount(ctx: { smoke: boolean }, fullCount: number, smokeCountValue: number): number {
  return ctx.smoke ? smokeCountValue : fullCount;
}

// One repetition hides faults that start at the second one: on 2026-11-09 Orca's A1 broke at repetition 2 and
// MonoCode's A2 at repetition 4. The rehearsal (ADEMARK-44) runs these tests 3 times and every other test once.
export const REHEARSAL_REPEATS: Readonly<Record<string, number>> = { A1: 3, A2: 3, A3: 3 };

/** `A1=3,A2=3` for `run --smoke-reps`; null when the text is not a list of test=count with whole counts from 1 to 20. */
export function parseSmokeRepeats(text: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const part of text.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    const match = /^([A-C]\d+)=(\d+)$/.exec(part);
    if (match === null) return null;
    const count = Number(match[2]);
    if (count < 1 || count > 20) return null;
    out[match[1]!] = count;
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function formatSmokeRepeats(repeats: Readonly<Record<string, number>>): string {
  return Object.entries(repeats).map(([test, count]) => `${test}=${count}`).join(",");
}
