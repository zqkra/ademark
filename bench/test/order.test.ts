import { describe, expect, test } from "bun:test";
import { seedToUint32, shuffle } from "../core/order.ts";

describe("shuffle", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

  test("is stable for a seed", () => {
    expect(shuffle(ids, "test")).toEqual(shuffle(ids, "test"));
    expect(shuffle(ids, "test")).toEqual(shuffle(ids, "test"));
  });

  test("different seeds give different orders", () => {
    const seen = new Set<string>();
    for (const seed of ["a", "b", "c", "d", "e"]) seen.add(shuffle(ids, seed).join(""));
    expect(seen.size).toBeGreaterThan(1);
  });

  test("is a permutation of the input", () => {
    const out = shuffle(ids, "seed");
    expect(out.length).toBe(ids.length);
    expect([...out].sort()).toEqual([...ids].sort());
  });

  test("does not mutate the input", () => {
    const input = [...ids];
    shuffle(input, "seed");
    expect(input).toEqual(ids);
  });

  test("handles empty and single-element lists", () => {
    expect(shuffle([], "seed")).toEqual([]);
    expect(shuffle(["only"], "seed")).toEqual(["only"]);
  });

  test("seeds with a real 32-bit value are not all zero", () => {
    const values = new Set(["test", "abc", "ademark", "2026-10-21"].map(seedToUint32));
    expect(values.size).toBe(4);
    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });
});
