import { describe, expect, test } from "bun:test";
import {
  isTie,
  median,
  medianConverged,
  medianInterval95,
  medianIntervalRank,
  mulberry32,
  pairedBootstrapCI,
  quantile,
  summary,
} from "../core/stats.ts";

describe("median and quantile", () => {
  test("median of [1,2,3,4] is 2.5", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("R-7 p25 of [1..9] is 3", () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9], 0.25)).toBe(3);
  });

  test("R-7 p75 of [1..9] is 7", () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9], 0.75)).toBe(7);
  });

  test("R-7 interpolates between ranks: p25 of [1,2,3,4] is 1.75", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
  });

  test("median and quantile do not mutate the input", () => {
    const xs = [4, 1, 3, 2];
    median(xs);
    quantile(xs, 0.9);
    expect(xs).toEqual([4, 1, 3, 2]);
  });

  test("quantile rejects a q outside [0,1]", () => {
    expect(() => quantile([1, 2], 1.5)).toThrow(/q must be/);
  });

  test("summary reports n, median, p25, p75, min, max", () => {
    expect(summary([1, 2, 3, 4])).toEqual({ n: 4, median: 2.5, p25: 1.75, p75: 3.25, min: 1, max: 4 });
  });

  test("summary of an empty list is NaN with n = 0", () => {
    expect(summary([]).n).toBe(0);
    expect(Number.isNaN(summary([]).median)).toBe(true);
  });
});

describe("mulberry32", () => {
  test("is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
  });

  test("produces values in [0,1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("different seeds give different streams", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("pairedBootstrapCI", () => {
  const a = [10, 12, 11, 13, 12, 11, 10, 12, 13, 11, 12, 10];
  const b = [8, 9, 8, 10, 9, 8, 9, 10, 9, 8, 9, 8];

  test("is identical for the same seed", () => {
    const first = pairedBootstrapCI(a, b, { resamples: 2000, seed: 12345 });
    const second = pairedBootstrapCI(a, b, { resamples: 2000, seed: 12345 });
    expect(second).toEqual(first);
  });

  test("a different seed draws different resamples", () => {
    const noisyA = Array.from({ length: 40 }, (_, i) => 10 + i * 0.37);
    const noisyB = Array.from({ length: 40 }, (_, i) => 8 + i * 0.11);
    const first = pairedBootstrapCI(noisyA, noisyB, { resamples: 500, seed: 1 });
    const second = pairedBootstrapCI(noisyA, noisyB, { resamples: 500, seed: 2 });
    expect(second).not.toEqual(first);
    expect(second.diffMedian).toBe(first.diffMedian);
  });

  test("contains the true difference for a constructed sample", () => {
    const ci = pairedBootstrapCI(a, b, { resamples: 4000, seed: 99 });
    expect(ci.diffMedian).toBeCloseTo(3, 10);
    expect(ci.lo).toBeLessThanOrEqual(3);
    expect(ci.hi).toBeGreaterThanOrEqual(3);
    expect(ci.lo).toBeGreaterThan(0);
  });

  test("a null difference produces a tie interval", () => {
    const same = pairedBootstrapCI(a, [...a], { resamples: 500, seed: 5 });
    expect(same.diffMedian).toBe(0);
    expect(isTie(same)).toBe(true);
  });

  test("rejects unequal lengths and empty input", () => {
    expect(() => pairedBootstrapCI([1, 2], [1])).toThrow(/lengths differ/);
    expect(() => pairedBootstrapCI([], [])).toThrow(/no pairs/);
  });
});

describe("isTie", () => {
  test("is true when the interval includes 0", () => {
    expect(isTie({ lo: -1, hi: 1 })).toBe(true);
    expect(isTie({ lo: 0, hi: 0.5 })).toBe(true);
    expect(isTie({ lo: -0.5, hi: 0 })).toBe(true);
  });

  test("is false when the interval excludes 0", () => {
    expect(isTie({ lo: 0.1, hi: 1 })).toBe(false);
    expect(isTie({ lo: -2, hi: -0.1 })).toBe(false);
  });
});

describe("medianInterval95", () => {
  test("the binomial rank k for n = 6 to 10 is 1, 1, 1, 2, 2", () => {
    expect([6, 7, 8, 9, 10].map((n) => medianIntervalRank(n))).toEqual([1, 1, 1, 2, 2]);
  });

  test("needs at least six values", () => {
    expect(medianInterval95([1, 2, 3, 4, 5])).toBeNull();
  });

  test("with k = 1 the interval is the minimum and the maximum", () => {
    expect(medianInterval95([5, 1, 3, 2, 4, 6])).toEqual({ lo: 1, hi: 6, median: 3.5 });
  });

  test("with k = 2 the interval is the second and the second-to-last order statistic", () => {
    expect(medianInterval95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ lo: 2, hi: 9, median: 5.5 });
  });

  test("rejects a non-finite value", () => {
    expect(() => medianInterval95([1, 2, 3, 4, 5, Number.NaN])).toThrow(/finite/);
  });
});

describe("medianConverged", () => {
  const options = { relTol: 0.05, absTol: 1 / 60 };

  test("is false below six values", () => {
    expect(medianConverged([1, 1, 1, 1, 1], options)).toBe(false);
  });

  test("a tight set converges", () => {
    expect(medianConverged([1.2, 1.2, 1.21, 1.19, 1.2, 1.2], options)).toBe(true);
  });

  test("a spread set does not converge", () => {
    expect(medianConverged([1, 2, 3, 4, 5, 6], options)).toBe(false);
  });

  test("the absolute tolerance catches a small median with a wide relative spread", () => {
    // Half-width 0.01 s: over the 5 % relative bound (0.005 s) but under the 1/60 s absolute one.
    expect(medianConverged([0.09, 0.09, 0.1, 0.1, 0.11, 0.11], { relTol: 0.05, absTol: 1 / 60 })).toBe(true);
    expect(medianConverged([0.09, 0.09, 0.1, 0.1, 0.11, 0.11], { relTol: 0.05, absTol: 0.001 })).toBe(false);
  });
});
