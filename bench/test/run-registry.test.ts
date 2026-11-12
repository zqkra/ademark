import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { TRACK_ORDER, loadRunners } from "../run/registry.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures", "run");

describe("runner registry", () => {
  test("orders every track exactly as RUNBOOK.md §7", () => {
    expect(TRACK_ORDER.A).toEqual(["A5", "A6", "A7", "A8", "A10", "A11", "A3", "A4", "A9", "A2", "A1"]);
    expect(TRACK_ORDER.B).toEqual(["B1", "B3", "B2", "B4"]);
    expect(TRACK_ORDER.C).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "A12"]);
  });

  test("loads the runners of a, b and c", async () => {
    const runners = await loadRunners(resolve(FIXTURES, "runners"));
    expect([...runners.keys()].sort()).toEqual(["A5", "B1", "C1"]);
    expect(runners.get("B1")?.track).toBe("B");
  });

  test("loads folders with any name, not only track letters", async () => {
    const runners = await loadRunners(resolve(FIXTURES, "runners-named"));
    expect([...runners.keys()].sort()).toEqual(["A5", "B1"]);
    expect(runners.get("B1")?.track).toBe("B");
  });

  test("a missing track folder is not an error", async () => {
    expect(await loadRunners(resolve(FIXTURES, "does-not-exist"))).toEqual(new Map());
  });

  test("throws on a duplicate id", async () => {
    await expect(loadRunners(resolve(FIXTURES, "runners-duplicate"))).rejects.toThrow(
      /duplicate test runner id A5/,
    );
  });
});
