// ADEMARK-56: a test set aside after review counts as not measured in its attempt, the pass measures it again, the merge
// takes the attempt that ran it again, and the report says why. The rows on disk never change.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultRow } from "../core/contracts.ts";
import { rowsIn } from "../control/qa.ts";
import { buildRunReport } from "../control/report.ts";
import { mergeAttempts, missing, missingLine, planTopUp, type Minimum } from "../control/topup.ts";
import { lineText, testLines } from "../control/verdicts.ts";
import type { AcceptedLimit } from "../night/known-failures.ts";
import { applySetAside, folderOf, SET_ASIDE, SET_ASIDE_PREFIX, type SetAside } from "../night/set-aside.ts";
import { row } from "./control-rows.ts";

const RUN = "control-2026-11-10T08-31-19Z";
const MIN = new Map<string, Minimum>([
  ["A1", { variant: "cold", min: 3 }],
  ["A3", { variant: null, min: 3 }],
  ["A9", { variant: null, min: 3 }],
]);
const ENTRY: SetAside = { run: RUN, ade: "t3code", test: "A3", attempt: "1", reason: "the probe misread the window", evidence: `${RUN}-t3code-1/t3code/A3/rep-02/frames.json`, date: "2026-11-10" };
const reps = (test: string, variant: string, n: number, folder: string, valid = true): ResultRow[] =>
  Array.from({ length: n }, (_, index) => row({ run_id: `${RUN}-${folder}`, ade: "t3code", test_id: test as never, variant, rep: index + 1, valid, invalid_reason: valid ? null : "timed_out" }));
const firstRows = (): ResultRow[] => [...reps("A1", "cold", 3, "t3code-1"), ...reps("A3", "open", 3, "t3code-1")];

let root: string;
const write = (name: string, rows: readonly ResultRow[]): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rows.jsonl"), rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return dir;
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-set-aside-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the reviewed list", () => {
  test("has the first entries of the night of 10 Nov, each with evidence of its own attempt", () => {
    const named = SET_ASIDE.map((entry) => `${entry.run} ${entry.ade} ${entry.test} ${entry.attempt}`);
    for (const key of ["t3code A1", "t3code A2", "t3code A3", "emdash A3", "synara A9"]) expect(named).toContain(`${RUN} ${key.split(" ")[0]} ${key.split(" ")[1]} 1`);
    for (const entry of SET_ASIDE) {
      expect(entry.attempt).toMatch(/^(\d+|topup-\d+|tokens-\d+|orchestration-\d+)$/);
      expect(entry.date).toMatch(/^\d{4}-\d\d-\d\d$/);
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.evidence.startsWith(`${folderOf(entry)}/`)).toBe(true);
      expect(`${entry.reason}${entry.evidence}`).not.toContain(String.fromCharCode(0x2014));
    }
    expect(new Set(named).size).toBe(named.length);
  });
});

describe("rowsIn applies the list", () => {
  test("the rows of a listed test are not valid with the reason, in a real and a dry folder, and the file stays as it is", () => {
    for (const name of [`${RUN}-t3code-1`, `${RUN}-t3code-1-dry`]) {
      const dir = write(name, firstRows());
      const before = readFileSync(join(dir, "rows.jsonl"), "utf8");
      const rows = rowsIn(dir, [ENTRY]);
      const a3 = rows.filter((entry) => entry.test_id === "A3");
      expect(a3.every((entry) => !entry.valid && entry.invalid_reason === `${SET_ASIDE_PREFIX}${ENTRY.reason}`)).toBe(true);
      expect(rows.filter((entry) => entry.test_id === "A1").every((entry) => entry.valid)).toBe(true);
      expect(readFileSync(join(dir, "rows.jsonl"), "utf8")).toBe(before);
    }
  });

  test("the default list sets aside T3 Code A1, A2 and A3 of the first attempt of 10 Nov, and not its top-up", () => {
    const rows = [...firstRows(), ...reps("A2", "warm", 3, "t3code-1"), ...reps("A4", "total", 3, "t3code-1")];
    const aside = rowsIn(write(`${RUN}-t3code-1`, rows)).filter((entry) => !entry.valid).map((entry) => entry.test_id);
    expect([...new Set(aside)].sort()).toEqual(["A1", "A2", "A3"]);
    expect(rowsIn(write(`${RUN}-t3code-topup-1`, rows)).every((entry) => entry.valid)).toBe(true);
  });
});

describe("the pass", () => {
  test("names a set-aside test that had its minimum, and gives it a top-up", () => {
    const dir = join(root, `${RUN}-t3code-1`);
    const app = (rows: readonly ResultRow[]) => [{ ade: "t3code", measured: true, attempts: [{ label: "attempt 1", rows }], expected: ["A1", "A3"] }];
    expect(missing(RUN, app(firstRows()), MIN).topUps).toEqual([]);
    const plan = missing(RUN, app(applySetAside(dir, firstRows(), [ENTRY])), MIN);
    expect(plan.topUps).toEqual([{ ade: "t3code", short: ["A3"], tests: ["A3"] }]);
    expect(missingLine(plan, () => "T3 Code")).toBe("T3 Code: A3.");
  });

  test("is not skipped as an accepted limit when the set-aside reason matches one", () => {
    const limits: AcceptedLimit[] = [{ ade: "t3code", test: "A3", reason: /misread/, evidence: "x", approved: "2026-11-10" }];
    const rows = applySetAside(join(root, `${RUN}-t3code-1`), firstRows(), [ENTRY]);
    expect(planTopUp("t3code", rows, MIN, [], limits).short).toEqual(["A3"]);
  });
});

describe("the merge", () => {
  test("takes the set-aside test from the top-up that ran it, also when the first attempt had the minimum", () => {
    const topUp = { label: "top-up 1", rows: reps("A3", "open", 3, "t3code-topup-1", false) };
    const plain = mergeAttempts("t3code", RUN, { label: "attempt 1", rows: firstRows() }, [topUp], MIN);
    expect(plain.source.get("t3code A3")).toBe("attempt 1");
    const aside = applySetAside(join(root, `${RUN}-t3code-1`), firstRows(), [ENTRY]);
    const merged = mergeAttempts("t3code", RUN, { label: "attempt 1", rows: aside }, [topUp], MIN);
    expect(merged.source.get("t3code A3")).toBe("top-up 1");
    expect(merged.source.get("t3code A1")).toBe("attempt 1");
  });
});

describe("the report", () => {
  const app = (first: string, topUps: string[] = []) => ({
    ade: "t3code",
    label: "T3 Code",
    first: { attempt: 1, dir: first },
    topUps: topUps.map((dir, index) => ({ attempt: index + 1, dir })),
    expected: ["A1", "A3"],
    note: "",
  });

  test("shows the first attempt's test as set aside with the reason, never valid and never NEW", () => {
    const first = write(`${RUN}-t3code-1`, firstRows());
    const text = buildRunReport({ runId: RUN, ended: false, apps: [app(first)], minimums: MIN, setAside: [ENTRY], root });
    expect(text.split("\n")[0]).toBe("0 invalid rows that are not accepted limits (NEW)");
    expect(text).toContain(`| A3 | attempt 1 | ${SET_ASIDE_PREFIX}${ENTRY.reason} |`);
    expect(text).toContain(`  - A3 of attempt 1: set aside after review (2026-11-10): ${ENTRY.reason}. Evidence: ${ENTRY.evidence}`);
    expect(text).not.toContain("| A3 | attempt 1 | valid |");
    const line = testLines("t3code", rowsIn(first, [ENTRY])).find((entry) => entry.test === "A3")!;
    expect(line.status).toBe("set aside");
    expect(line.mark).toBeNull();
    expect(lineText(line)).toBe(`${SET_ASIDE_PREFIX}${ENTRY.reason}`);
  });

  test("after a top-up, takes the test from it and still names the set-aside first attempt", () => {
    const first = write(`${RUN}-t3code-1`, firstRows());
    const topUp = write(`${RUN}-t3code-topup-1`, reps("A3", "open", 3, "t3code-topup-1"));
    const text = buildRunReport({ runId: RUN, ended: false, apps: [app(first, [topUp])], minimums: MIN, setAside: [ENTRY], root });
    expect(text).toContain("| A3 | top-up 1 | valid |");
    expect(text).toContain(`  - A3 of attempt 1: set aside after review (2026-11-10): ${ENTRY.reason}.`);
  });

  test("an entry of a run, an app or an attempt that does not exist changes nothing and is named in the notes", () => {
    const first = write(`${RUN}-t3code-1`, firstRows());
    const wrong: SetAside[] = [
      { ...ENTRY, run: "control-2026-11-10T08-31-19" },
      { ...ENTRY, ade: "t3cod" },
      { ...ENTRY, attempt: "topup-9" },
      { ...ENTRY, test: "A7" },
    ];
    const without = buildRunReport({ runId: RUN, ended: false, apps: [app(first)], minimums: MIN, setAside: [], root });
    const text = buildRunReport({ runId: RUN, ended: false, apps: [app(first)], minimums: MIN, setAside: wrong, root });
    expect(text).toContain("- set-aside entry control-2026-11-10T08-31-19 t3code A3 attempt 1 changed nothing: no folder of run control-2026-11-10T08-31-19.");
    expect(text).toContain(`- set-aside entry ${RUN} t3cod A3 attempt 1 changed nothing: the report reads no folder ${RUN}-t3cod-1.`);
    expect(text).toContain(`- set-aside entry ${RUN} t3code A3 attempt topup-9 changed nothing: the report reads no folder ${RUN}-t3code-topup-9.`);
    expect(text).toContain(`- set-aside entry ${RUN} t3code A7 attempt 1 changed nothing: ${RUN}-t3code-1 has no row of A7.`);
    const body = (report: string) => report.split("\n").filter((entry) => !entry.startsWith("- set-aside entry"));
    expect(body(text)).toEqual(body(without));
    expect(text).toContain("| A3 | attempt 1 | valid |");
  });
});
