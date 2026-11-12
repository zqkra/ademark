// Statistics for TESTS.md 0.1 and METHODOLOGY.md 6: median, R-7 quantiles, paired bootstrap CI.
export interface Summary {
  n: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export interface BootstrapCI {
  lo: number;
  hi: number;
  diffMedian: number;
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
}

// mulberry32: small seeded PRNG, so a published seed reproduces every interval (METHODOLOGY.md 6).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(xs: readonly number[], q: number): number {
  if (!(q >= 0 && q <= 1)) throw new Error(`quantile: q must be in [0,1], got ${q}`);
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (h - lo) * (b - a);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

export function summary(xs: readonly number[]): Summary {
  if (xs.length === 0) {
    return { n: 0, median: Number.NaN, p25: Number.NaN, p75: Number.NaN, min: Number.NaN, max: Number.NaN };
  }
  return {
    n: xs.length,
    median: median(xs),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

// The 95 % interval of the median of paired differences a[i] - b[i] (TESTS.md 0.1).
export function pairedBootstrapCI(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions = {},
): BootstrapCI {
  if (a.length !== b.length) throw new Error(`pairedBootstrapCI: lengths differ (${a.length} vs ${b.length})`);
  if (a.length === 0) throw new Error("pairedBootstrapCI: no pairs");
  const resamples = options.resamples ?? 10000;
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error("pairedBootstrapCI: resamples must be >= 1");
  const rng = mulberry32(options.seed ?? 1);

  const diffs = a.map((value, index) => value - b[index]!);
  const diffMedian = median(diffs);
  const boot: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample = new Array<number>(diffs.length);
    for (let i = 0; i < diffs.length; i++) sample[i] = diffs[Math.floor(rng() * diffs.length)]!;
    boot.push(median(sample));
  }
  return { lo: quantile(boot, 0.025), hi: quantile(boot, 0.975), diffMedian };
}

export function isTie(ci: Pick<BootstrapCI, "lo" | "hi">): boolean {
  return ci.lo <= 0 && 0 <= ci.hi;
}

export interface MedianInterval {
  lo: number;
  hi: number;
  median: number;
}

export interface ConvergedOptions {
  relTol: number;
  absTol: number;
}

// Smallest sample size the distribution-free median interval is defined for (TESTS.md §1.3).
export const MEDIAN_INTERVAL_MIN_N = 6;

// P(Binomial(n, 0.5) <= k), as an exact integer count out of 2^n. No table and no floating point.
function binomialCdfCount(n: number, k: number): bigint {
  let count = 0n;
  let coefficient = 1n;
  for (let i = 0; i <= k; i++) {
    count += coefficient;
    coefficient = (coefficient * BigInt(n - i)) / BigInt(i + 1);
  }
  return count;
}

// The largest k >= 1 with P(Binomial(n, 0.5) <= k - 1) <= 0.025: the rank of both ends of the
// distribution-free 95 % interval of the median. n = 6 to 8 give 1; n = 9 and 10 give 2.
export function medianIntervalRank(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`medianIntervalRank: n must be an integer >= 1, got ${n}`);
  const total = 1n << BigInt(n);
  let rank = 1;
  for (let candidate = 2; candidate * 2 <= n; candidate++) {
    // count / 2^n <= 0.025, compared as integers so no rounding can flip the boundary case.
    if (binomialCdfCount(n, candidate - 1) * 1000n > 25n * total) break;
    rank = candidate;
  }
  return rank;
}

// The order-statistic 95 % interval of the median of `values` (TESTS.md §1.3, "Adaptive repetitions").
export function medianInterval95(values: readonly number[]): MedianInterval | null {
  const n = values.length;
  if (n < MEDIAN_INTERVAL_MIN_N) return null;
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("medianInterval95: every value must be finite");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const k = medianIntervalRank(n);
  return { lo: sorted[k - 1]!, hi: sorted[n - k]!, median: median(sorted) };
}

// True when the interval's half-width is at most the larger of a relative and an absolute tolerance.
export function medianConverged(values: readonly number[], options: ConvergedOptions): boolean {
  const interval = medianInterval95(values);
  if (interval === null) return false;
  return (interval.hi - interval.lo) / 2 <= Math.max(options.relTol * interval.median, options.absTol);
}
