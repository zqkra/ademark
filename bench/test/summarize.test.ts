import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultRow } from "../core/contracts.ts";
import { readRows, summarizeRows, summarizeRun } from "../core/summarize.ts";
import { isTie } from "../core/stats.ts";

function row(overrides: Partial<ResultRow>): ResultRow {
  return {
    run_id: "run-1",
    machine_id: "ref-mac-mini-m4-16gb",
    ade: "t3code",
    ade_version: "0.1.0",
    ade_build_sha256: null,
    family: "EL-SDK",
    test_id: "A1",
    variant: "",
    rep: 1,
    model: null,
    effort: null,
    server: "none",
    value: 2,
    unit: "s",
    started_at: "2026-10-21T19:42:07.113Z",
    duration_ms: 1000,
    valid: true,
    invalid_reason: null,
    drive: "cdp",
    receipts: { samples: null, video: null, frames: null, capture: null, log: null },
    notes: "",
    ...overrides,
  };
}

describe("summarizeRows", () => {
  test("groups by ade and test, and ignores invalid rows in the aggregates", () => {
    const rows = [
      row({ rep: 1, value: 1 }),
      row({ rep: 2, value: 3 }),
      row({ rep: 3, value: 99, valid: false, invalid_reason: "system dialog" }),
    ];
    const summary = summarizeRows(rows);
    expect(summary.rows).toBe(3);
    expect(summary.invalid_rows).toBe(1);
    expect(summary.ades.t3code!.tests.A1).toMatchObject({ n: 2, median: 2, min: 1, max: 3 });
  });

  test("splits variants into their own groups", () => {
    const rows = [row({ variant: "p50", value: 1 }), row({ variant: "p95", value: 5 })];
    const summary = summarizeRows(rows);
    expect(Object.keys(summary.ades.t3code!.tests).sort()).toEqual(["A1/p50", "A1/p95"]);
  });

  test("pairs against the Bare CLI by test, variant and rep", () => {
    const rows = [
      row({ ade: "bare-cli-claude", family: "control", rep: 1, value: 1 }),
      row({ ade: "bare-cli-claude", family: "control", rep: 2, value: 2 }),
      row({ ade: "t3code", rep: 1, value: 3 }),
      row({ ade: "t3code", rep: 2, value: 4 }),
    ];
    const summary = summarizeRows(rows, 7);
    const paired = summary.ades.t3code!.tests.A1!.against_bare_cli!;
    expect(paired.n_pairs).toBe(2);
    expect(paired.diffMedian).toBe(2);
    expect(isTie(paired)).toBe(false);
  });

  test("the Bare CLI itself has no paired comparison", () => {
    const rows = [row({ ade: "bare-cli-claude", family: "control", value: 1 }), row({ ade: "bb", value: 2 })];
    const summary = summarizeRows(rows);
    expect(summary.ades["bare-cli-claude"]!.tests.A1!.against_bare_cli).toBeNull();
  });

  test("no pair means no comparison", () => {
    const rows = [row({ ade: "bb", rep: 1, value: 2 })];
    expect(summarizeRows(rows).ades.bb!.tests.A1!.against_bare_cli).toBeNull();
  });
});

describe("summarizeRun", () => {
  test("reads rows.jsonl and writes summary.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-summary-"));
    try {
      writeFileSync(join(dir, "rows.jsonl"), `${JSON.stringify(row({ value: 2 }))}\n${JSON.stringify(row({ rep: 2, value: 4 }))}\n`);
      const { path, summary } = summarizeRun(dir);
      expect(path).toBe(join(dir, "summary.json"));
      expect(summary.ades.t3code!.tests.A1!.median).toBe(3);
      expect(readRows(join(dir, "rows.jsonl")).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a missing rows file", () => {
    expect(() => readRows("/tmp/ademark-does-not-exist/rows.jsonl")).toThrow(/rows file not found/);
  });

  test("reports the line number of a broken row", () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-summary-"));
    try {
      writeFileSync(join(dir, "rows.jsonl"), '{"ok":1}\nnot json\n');
      expect(() => readRows(join(dir, "rows.jsonl"))).toThrow(/line 2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
