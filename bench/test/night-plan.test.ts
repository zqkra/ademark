import { describe, expect, test } from "bun:test";
import { estimateMinutes, formatLocal, formatPlan, nextDeadline } from "../night/plan.ts";

describe("night plan", () => {
  test("estimates 25 minutes per ADE for Track A and 7 for Track B", () => {
    expect(estimateMinutes(3, ["A"])).toBe(75);
    expect(estimateMinutes(2, ["B"])).toBe(14);
    expect(estimateMinutes(2, ["A", "B"])).toBe(64);
    expect(estimateMinutes(0, ["A"])).toBe(0);
  });

  test("nextDeadline is the next local occurrence of HH:MM", () => {
    const now = new Date(2026, 9, 21, 22, 0, 0, 0).getTime();
    const morning = new Date(nextDeadline("07:30", now));
    expect(morning.getDate()).toBe(22);
    expect(morning.getHours()).toBe(7);
    expect(morning.getMinutes()).toBe(30);
    expect(morning.getSeconds()).toBe(0);
    const sameEvening = new Date(nextDeadline("23:00", now));
    expect(sameEvening.getDate()).toBe(21);
    expect(sameEvening.getHours()).toBe(23);
  });

  test("nextDeadline rejects a time that is not HH:MM", () => {
    expect(() => nextDeadline("7:30", Date.now())).toThrow(/HH:MM/);
    expect(() => nextDeadline("24:00", Date.now())).toThrow(/HH:MM/);
    expect(() => nextDeadline("07:60", Date.now())).toThrow(/HH:MM/);
  });

  test("the plan lists the run order, the skips and the expected end", () => {
    const now = new Date(2026, 9, 21, 20, 0, 0, 0).getTime();
    const plan = formatPlan({
      order: ["t3code", "zeron"],
      skipped: [{ ade: "paseo", reason: "not installed" }],
      tracks: ["A"],
      now,
    });
    expect(plan).toContain("plan: 2 ADE(s) chosen, 1 skipped");
    expect(plan).toContain("chosen, in run order: t3code, zeron");
    expect(plan).toContain("  paseo: not installed");
    expect(plan).toContain("estimate: 50 min (25 min per ADE for Track A; retries are not included)");
    expect(plan).toContain(`expected end: ${formatLocal(now + 50 * 60_000)} (local)`);
  });

  test("an empty choice says none", () => {
    const plan = formatPlan({ order: [], skipped: [], tracks: ["A"], now: Date.now() });
    expect(plan).toContain("chosen, in run order: none");
    expect(plan).not.toContain("skipped:");
  });
});
