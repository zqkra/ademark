import { leftoverReason } from "../tracks/a-timing/a2-relaunch.ts";
import { describe, expect, test } from "bun:test";
import type { ResultRow } from "../core/contracts.ts";
import type { RunResult } from "../run/loop.ts";
import { adeRows, buildNightReport, type NightState } from "../night/report.ts";

function row(ade: string, over: Partial<ResultRow> = {}): ResultRow {
  return {
    run_id: "r",
    machine_id: "m",
    ade,
    ade_version: "1.0.0",
    ade_build_sha256: null,
    family: "EL-SDK",
    test_id: "A5",
    variant: "",
    rep: 1,
    model: null,
    effort: null,
    server: "replay",
    value: 1,
    unit: "MB",
    started_at: "2026-10-21T22:00:00.000Z",
    duration_ms: 60_000,
    valid: true,
    invalid_reason: null,
    drive: "cdp",
    receipts: { samples: null, video: null, frames: null, capture: null, log: null },
    notes: "",
    ...over,
  };
}

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    runId: "r",
    runDir: "/nonexistent",
    order: ["a"],
    blocks: [],
    rows: 0,
    stopped: false,
    retried: [],
    skippedForTime: [],
    ...over,
  };
}

function state(over: Partial<NightState> = {}): NightState {
  return {
    runId: "r",
    seed: "s",
    dryRun: false,
    tracks: ["A"],
    startedAt: "2026-10-21T22:00:00.000Z",
    endedAt: "2026-10-22T04:00:00.000Z",
    stopReason: null,
    warnings: [],
    knownAdes: ["a", "b", "c"],
    chosen: ["a", "b"],
    order: ["a", "b"],
    skipped: [{ ade: "c", reason: "not installed" }],
    plan: "plan text",
    doctor: null,
    doctorTable: null,
    machine: ["machine on", "machine off"],
    rehearsal: null,
    result: result(),
    runDir: "/nonexistent",
    harnessCommit: "abc1234",
    ...over,
  };
}

describe("night report", () => {
  test("every ADE gets the status it earned", () => {
    const rows = [
      row("a"),
      row("a", { valid: false, invalid_reason: "timeout" }),
      row("d"),
    ];
    const table = adeRows(
      state({
        knownAdes: ["a", "b", "c", "d"],
        chosen: ["a", "b", "d"],
        result: result({ retried: ["a"], skippedForTime: ["b", "d"] }),
      }),
      rows,
    );
    expect(table.map((entry) => [entry.ade, entry.status, entry.rows, entry.invalid, entry.retried])).toEqual([
      ["a", "measured", 2, 1, "yes"],
      ["b", "skipped for time", 0, 0, "-"],
      ["c", "skipped", 0, 0, "-"],
      ["d", "measured", 1, 0, "no"],
    ]);
    expect(table[0]!.note).toBe("");
    expect(table[1]!.note).toContain("the deadline passed before it started");
    expect(table[2]!.note).toBe("not installed");
    expect(table[3]!.note).toContain("its retry was skipped");
  });

  // ADEMARK-45: an invalid row is NEW unless an approved accepted limit names it; not supported is neither.
  test("counts NEW invalid rows per ADE and on top of the report", () => {
    const rows = [
      row("orca", { test_id: "A2", valid: false, invalid_reason: leftoverReason(1.58, 1) }),
      row("orca", { test_id: "A6", valid: false, invalid_reason: "not supported here: no window" }),
      row("orca", { test_id: "A4", valid: false, invalid_reason: "timed_out" }),
    ];
    const night = state({ knownAdes: ["orca"], chosen: ["orca"], result: result() });
    expect(adeRows(night, rows).map((entry) => [entry.invalid, entry.fresh])).toEqual([[3, 2]]);
    expect(buildNightReport(night, rows)).toContain("- NEW invalid rows: 2 (invalid rows that are not accepted limits; zero is the goal)");
  });

  test("duration runs from the first row's start to the last row's end", () => {
    const rows = [
      row("a", { started_at: "2026-10-21T22:00:00.000Z", duration_ms: 60_000 }),
      row("a", { started_at: "2026-10-21T22:10:00.000Z", duration_ms: 60_000 }),
    ];
    expect(adeRows(state(), rows)[0]!.duration).toBe("11.0 min");
  });

  test("a chosen ADE that never started is not started", () => {
    const table = adeRows(state({ result: null }), []);
    expect(table.map((entry) => [entry.ade, entry.status])).toEqual([
      ["a", "not started"],
      ["b", "not started"],
      ["c", "skipped"],
    ]);
    expect(table[0]!.note).toContain("the night stopped before the run reached it");
  });

  test("the report names the run, the status, the skips and what is missing", () => {
    const report = buildNightReport(
      state({ stopReason: "doctor: 2 blocking check(s) failed" }),
      [],
    );
    expect(report).toContain("# Night r");
    expect(report).toContain("- status: stopped: doctor: 2 blocking check(s) failed");
    expect(report).toContain("- machine: not collected");
    expect(report).toContain("- harness commit: abc1234");
    expect(report).toContain("| c | not installed |");
    expect(report).toContain("The night stopped before doctor ran.");
    expect(report).toContain("The night stopped before the rehearsal.");
    expect(report).toContain("```text\nmachine on\nmachine off\n```");
    expect(report).toContain("plan text");
  });

  test("the report shows every repair attempt, and the ADE table names the repaired ADE", () => {
    const repairs = [
      { ade: "a", attempt: 1, result: "still failing", minutes: 12, commit: "abcdef1234", diff: "repairs/a/attempt-1/diff.patch", note: "timeout" },
      { ade: "a", attempt: 2, result: "repaired", minutes: 9, commit: "1234abcdef", diff: "repairs/a/attempt-2/diff.patch", note: "" },
      { ade: "b", attempt: 1, result: "rejected", minutes: 3, commit: null, diff: null, note: "changed bench/core/gates.ts" },
    ] as NightState["repairs"];
    const report = buildNightReport(state({ repairs }), [row("a-own")]);
    expect(report).toContain("## Repairs");
    expect(report).toContain("| a | 1 | still failing | 12 | abcdef1 | repairs/a/attempt-1/diff.patch | timeout |");
    expect(report).toContain("| a | 2 | repaired | 9 | 1234abc |");
    expect(report).toContain("| b | 1 | rejected | 3 | - | - | changed bench/core/gates.ts |");
    expect(report).toContain("repaired: yes (1234abc)");
  });

  test("a night with no repair has no Repairs section", () => {
    expect(buildNightReport(state(), [])).not.toContain("## Repairs");
  });
});
