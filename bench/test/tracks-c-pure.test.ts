// Pure Track C helpers: shipped, handoff codes, fan-out, lock runs, the survival rubric and delivery.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedUsage, CaptureRow, GradeResult, NativeProc } from "../core/contracts.ts";
import { generateHandoffCodes } from "../core/tasks.ts";
import { lockRuns, longestLockMs } from "../tracks/c/probe.ts";
import {
  adeProcessAlive,
  bodyFileHasText,
  bodyHasText,
  codesPlaced,
  fanOut,
  followupDelivered,
  groupPassed,
  handoffCount,
  handoffFrom,
  loadPrices,
  runTokens,
  shippedCount,
  survivalOutcome,
  SURVIVAL_VALUE,
  type Survival,
} from "../tracks/c/shared.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "tracks-c");
const CODES = generateHandoffCodes("ademark-validation");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-c-pure-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function captureRow(model: string | null, usage: CapturedUsage, t_ns = 0, body_file: string | null = null): CaptureRow {
  return {
    t_ns,
    host: "api.anthropic.com",
    path: "/v1/messages",
    pid: null,
    process: null,
    model,
    user_agent: null,
    req_bytes: 1,
    status: 200,
    usage,
    main_thread: null,
    user_text_sha256: [],
    chunk_t_ns: [],
    body_file,
  };
}

describe("track C pure helpers", () => {
  test("shipped counts the five C1 group units", () => {
    const grade = JSON.parse(readFileSync(join(FIXTURES, "grade.json"), "utf8")) as GradeResult;
    expect(shippedCount(grade)).toBe(4);
    expect(groupPassed(grade, "W1-limiter")).toBe(true);
    expect(groupPassed(grade, "W3-cursor")).toBe(false);
    expect(groupPassed(grade, "Integration")).toBe(true);
    expect(groupPassed(grade, "NotAGroup")).toBe(false);
    // W1 and W4 ship only when both of their groups pass.
    const halfW1: GradeResult = {
      task: "C1-orchestrated-build",
      groups: [
        { id: "W1-limiter", passed: 1, total: 1, failed: [] },
        { id: "W1-api", passed: 0, total: 1, failed: ["budget"] },
      ],
      valid: true,
      reasons: [],
    };
    expect(shippedCount(halfW1)).toBe(0);
  });

  test("handoff and codes-placed count the fixture worktree", () => {
    const worktree = join(dir, "worktree");
    cpSync(join(FIXTURES, "worktree"), worktree, { recursive: true });
    expect(Object.values(CODES)).toEqual(["ADM-W1-ZAKIR2", "ADM-W2-MTBMUN", "ADM-W3-CB3PHC", "ADM-W4-SOFZXV"]);
    expect(handoffFrom(worktree, CODES)).toBe(3);
    expect(codesPlaced(worktree, CODES)).toBe(4);
    expect(handoffFrom(join(dir, "missing"), CODES)).toBe(0);
    expect(handoffCount("W1 | main | ADM-W1-ZAKIR2\nW2 | main | ADM-W2-XXXXXX", CODES)).toBe(1);
    expect(handoffCount("nothing here", CODES)).toBe(0);
  });

  test("fan-out counts overlapping worker sessions", () => {
    expect(fanOut([])).toEqual({ max: 0, total: 0 });
    expect(fanOut([{ start_ms: 0, end_ms: 100 }])).toEqual({ max: 1, total: 1 });
    expect(
      fanOut([
        { start_ms: 0, end_ms: 100 },
        { start_ms: 50, end_ms: 150 },
        { start_ms: 200, end_ms: 300 },
      ]),
    ).toEqual({ max: 2, total: 3 });
    expect(
      fanOut([
        { start_ms: 0, end_ms: 10 },
        { start_ms: 10, end_ms: 20 },
      ]),
    ).toEqual({ max: 1, total: 2 });
    expect(
      fanOut([
        { start_ms: 0, end_ms: 100 },
        { start_ms: 10, end_ms: 20 },
        { start_ms: 15, end_ms: 25 },
      ]),
    ).toEqual({ max: 3, total: 3 });
  });

  test("lock runs come from consecutive lost probes", () => {
    const probes = [
      { t_ns: 0, ms: 12 },
      { t_ns: 2_000_000_000, ms: null },
      { t_ns: 4_000_000_000, ms: null },
      { t_ns: 6_000_000_000, ms: 5 },
      { t_ns: 8_000_000_000, ms: null },
      { t_ns: 10_000_000_000, ms: 7 },
    ];
    const locks = lockRuns(probes);
    expect(locks).toEqual([
      { start_ns: 2_000_000_000, end_ns: 6_000_000_000, duration_ms: 4_000 },
      { start_ns: 8_000_000_000, end_ns: 10_000_000_000, duration_ms: 2_000 },
    ]);
    expect(longestLockMs(locks)).toBe(4_000);
    expect(lockRuns([])).toEqual([]);
    expect(lockRuns([{ t_ns: 0, ms: 1 }])).toEqual([]);
    // A run with no following echo has no measured end: it stops at its last probe.
    expect(
      lockRuns([
        { t_ns: 0, ms: 1 },
        { t_ns: 2_000_000_000, ms: null },
        { t_ns: 4_000_000_000, ms: null },
      ]),
    ).toEqual([{ start_ns: 2_000_000_000, end_ns: 4_000_000_000, duration_ms: 2_000 }]);
  });

  test("the survival rubric table", () => {
    const cases: Array<{ completed: boolean; everyGroupPassed: boolean; manualAction: boolean; want: Survival }> = [
      { completed: true, everyGroupPassed: true, manualAction: false, want: "pass" },
      { completed: true, everyGroupPassed: true, manualAction: true, want: "partial" },
      { completed: true, everyGroupPassed: false, manualAction: false, want: "partial" },
      { completed: true, everyGroupPassed: false, manualAction: true, want: "partial" },
      { completed: false, everyGroupPassed: true, manualAction: false, want: "fail" },
      { completed: false, everyGroupPassed: true, manualAction: true, want: "fail" },
      { completed: false, everyGroupPassed: false, manualAction: false, want: "fail" },
      { completed: false, everyGroupPassed: false, manualAction: true, want: "fail" },
    ];
    const values: Record<Survival, number> = { pass: 2, partial: 1, fail: 0 };
    for (const row of cases) {
      expect(survivalOutcome(row)).toBe(row.want);
      expect(SURVIVAL_VALUE[row.want]).toBe(values[row.want]);
    }
  });

  test("follow-up delivery reads the captured request bodies", () => {
    const path = join(FIXTURES, "bodies", "request.json");
    const body: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(bodyHasText(body, "FIXTURE-FOLLOWUP-ONE:   make the limit configurable")).toBe(true);
    expect(bodyHasText(body, "another follow-up")).toBe(false);
    expect(bodyHasText(body, "")).toBe(false);
    expect(bodyFileHasText(path, "FIXTURE-FOLLOWUP-ONE")).toBe(true);
    expect(bodyFileHasText(join(FIXTURES, "bodies", "missing.json"), "FIXTURE-FOLLOWUP-ONE")).toBe(false);

    const rows = [captureRow("claude-opus-5-5", { input: 1, cache_write: 0, cache_read: 0, output: 1 }, 1_000, path)];
    expect(followupDelivered(rows, 500n, "FIXTURE-FOLLOWUP-ONE")).toBe(true);
    expect(followupDelivered(rows, 2_000n, "FIXTURE-FOLLOWUP-ONE")).toBe(false);
    expect(followupDelivered(rows, 500n, "not in the body")).toBe(false);
    expect(followupDelivered([captureRow("claude-opus-5-5", { input: 1, cache_write: 0, cache_read: 0, output: 1 }, 1_000)], 500n, "FIXTURE-FOLLOWUP-ONE")).toBe(false);
  });

  test("the crash filter matches bundle and vendor paths on a boundary", () => {
    const procs: NativeProc[] = [
      {
        pid: 1,
        ppid: 0,
        path: "/Applications/Fixture.app/Contents/MacOS/Fixture",
        name: "Fixture",
        responsible_pid: 1,
      },
      { pid: 2, ppid: 1, path: "/usr/bin/unrelated", name: "unrelated", responsible_pid: null },
      { pid: 3, ppid: 1, path: "/Users/x/.t3/helpers/server", name: "server", responsible_pid: 1 },
    ];
    expect(adeProcessAlive(procs, ["/Applications/Fixture.app"])).toBe(true);
    expect(adeProcessAlive(procs, ["/Applications/Fixture.app/"])).toBe(true);
    expect(adeProcessAlive(procs, ["/Users/x/.t3"])).toBe(true);
    expect(adeProcessAlive(procs, ["/Applications/Fixture.apprentice"])).toBe(false);
    expect(adeProcessAlive(procs, ["/Applications/Gone.app", "/Users/x/.t3"])).toBe(true);
    expect(adeProcessAlive([], ["/Applications/Fixture.app"])).toBe(false);
    expect(adeProcessAlive([], [])).toBe(true);
  });

  test("run tokens sum every component and price each request model", () => {
    const prices = loadPrices();
    const usage: CapturedUsage = { input: 1_000_000, cache_write: 0, cache_read: 0, output: 10_000 };
    const priced = runTokens([captureRow("claude-opus-5-5", usage)], prices);
    expect(priced.tokens).toBe(1_010_000);
    expect(priced.usd).toBeCloseTo(4.2, 6);
    expect(priced.unpriced).toEqual([]);

    const unpriced = runTokens([captureRow("gpt-6.1-sol", usage)], prices);
    expect(unpriced.tokens).toBe(1_010_000);
    expect(unpriced.usd).toBeNull();
    expect(unpriced.unpriced).toEqual(["gpt-6.1-sol"]);

    const unknown = runTokens([captureRow(null, usage)], prices);
    expect(unknown.usd).toBeNull();
    expect(unknown.unpriced).toEqual(["unknown"]);

    expect(runTokens([], prices)).toEqual({ tokens: 0, usd: 0, unpriced: [] });
  });

  // 2026-11-11, the first real C1 (super.engineering, 96 requests): no $ at all, "no price for claude-opus-5-5".
  test("run tokens price each request by itself: a sum has no split of its cache writes", () => {
    const prices = loadPrices();
    // The usage of a real request of that night.
    const usage: CapturedUsage = { input: 2, cache_write: 13_020, cache_read: 11_780, output: 362, cache_write_1h: 13_020 };
    const one = runTokens([captureRow("claude-opus-5-5", usage)], prices);
    expect(one.usd).not.toBeNull();
    const two = runTokens([captureRow("claude-opus-5-5", usage), captureRow("claude-opus-5-5", usage)], prices);
    expect(two.unpriced).toEqual([]);
    expect(two.usd).toBeCloseTo(2 * one.usd!, 9);
    expect(two.tokens).toBe(2 * (2 + 13_020 + 11_780 + 362));
    // A model with no price still gives no $, and names every such model once.
    const mixed = runTokens([captureRow("claude-opus-5-5", usage), captureRow("claude-fable-5", usage), captureRow("claude-fable-5", usage)], prices);
    expect(mixed.usd).toBeNull();
    expect(mixed.unpriced).toEqual(["claude-fable-5"]);
  });
});
