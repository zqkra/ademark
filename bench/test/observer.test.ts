import { describe, expect, test } from "bun:test";
import { appPids, appUsage, coalitionOf, usageOf } from "../observer/observer.ts";

describe("observer", () => {
  test("reads this process: RAM, instructions, cpu", () => {
    const usage = usageOf(process.pid);
    expect(usage).not.toBeNull();
    expect(usage!.footprintBytes).toBeGreaterThan(1_000_000);
    expect(usage!.instructions).toBeGreaterThan(1_000);
  });

  test("instructions only grow", () => {
    const before = usageOf(process.pid)!.instructions;
    let sum = 0;
    for (let i = 0; i < 5_000_000; i++) sum += i;
    expect(sum).toBeGreaterThan(0);
    expect(usageOf(process.pid)!.instructions).toBeGreaterThan(before);
  });

  test("a gone process reads as null", () => {
    expect(usageOf(999_999)).toBeNull();
    expect(coalitionOf(999_999)).toBeNull();
    expect(appPids(999_999)).toEqual([]);
  });

  test("the app total holds this process", () => {
    expect(appPids(process.pid)).toContain(process.pid);
    expect(appUsage(process.pid).processes).toBeGreaterThan(0);
  });
});
