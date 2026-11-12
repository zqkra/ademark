// One line per app and test, for the rehearsal report, the panel and the morning report (ADEMARK-44, 45). A test is
// valid only when every one of its rows is valid: one invalid repetition is enough to show it.
import { NOT_SUPPORTED } from "../calibrate/pass.ts";
import type { ResultRow } from "../core/contracts.ts";
import { ACCEPTED_LIMITS, markOf, type AcceptedLimit, type LimitMark } from "../night/known-failures.ts";
import { isSetAside } from "../night/set-aside.ts";

// `set aside`: a review found a wrong number in rows that looked valid (bench/night/set-aside.ts). It is not valid and
// not NEW: the pass measures it again, and the report says why.
export type TestStatus = "valid" | "invalid" | "not supported" | "missing" | "set aside";

export interface TestLine {
  /** The row ade: `<ade>` or an agent variant such as `<ade>-own`. */
  rowAde: string;
  test: string;
  status: TestStatus;
  reason: string;
  /** For an invalid or missing test: NEW unless every invalid row is an approved accepted limit. */
  mark: LimitMark | null;
  rows: number;
  invalid: number;
  /** Invalid rows that are not accepted limits. A missing test counts as one. */
  fresh: number;
}

export function belongsTo(rowAde: string, ade: string): boolean {
  return rowAde === ade || rowAde.startsWith(`${ade}-`);
}

const TEST_NUMBER = (test: string): number => Number(test.slice(1)) + (test.charCodeAt(0) - 65) * 100;

/**
 * `expected` names the tests the app should have run. A test with no row at all is `missing`, and so is an app with no
 * row: a hole is never silent.
 */
export function testLines(
  ade: string,
  rows: readonly ResultRow[],
  expected: readonly string[] = [],
  limits: readonly AcceptedLimit[] = ACCEPTED_LIMITS,
): TestLine[] {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    if (!belongsTo(row.ade, ade)) continue;
    const key = `${row.ade} ${row.test_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines: TestLine[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const aside = list.find(isSetAside);
    if (aside !== undefined) {
      lines.push({ rowAde: first.ade, test: first.test_id, status: "set aside", reason: aside.invalid_reason ?? "", mark: null, rows: list.length, invalid: list.length, fresh: 0 });
      continue;
    }
    const supported = list.filter((row) => !(row.invalid_reason ?? "").startsWith(NOT_SUPPORTED));
    if (supported.length === 0) {
      lines.push({ rowAde: first.ade, test: first.test_id, status: "not supported", reason: first.invalid_reason ?? "", mark: null, rows: list.length, invalid: 0, fresh: 0 });
      continue;
    }
    const invalid = supported.filter((row) => !row.valid);
    const fresh = invalid.filter((row) => markOf(row, limits) === "NEW").length;
    lines.push({
      rowAde: first.ade,
      test: first.test_id,
      status: invalid.length === 0 ? "valid" : "invalid",
      reason: invalid.at(-1)?.invalid_reason ?? "",
      mark: invalid.length === 0 ? null : fresh === 0 ? "accepted limit" : "NEW",
      rows: list.length,
      invalid: invalid.length,
      fresh,
    });
  }
  const seen = new Set(lines.map((line) => line.test));
  for (const test of expected) {
    if (!seen.has(test)) lines.push({ rowAde: ade, test, status: "missing", reason: "no row: the block stopped before it", mark: "NEW", rows: 0, invalid: 0, fresh: 1 });
  }
  if (lines.length === 0) lines.push({ rowAde: ade, test: "-", status: "missing", reason: "no rows", mark: "NEW", rows: 0, invalid: 0, fresh: 1 });
  return lines.sort((a, b) => a.rowAde.localeCompare(b.rowAde) || TEST_NUMBER(a.test) - TEST_NUMBER(b.test));
}

/** How a line reads in a report: `valid`, `invalid (NEW): reason`, or `set aside after review: reason`. */
export function lineText(line: TestLine): string {
  if (line.status === "valid") return "valid";
  if (line.status === "not supported") return `not supported: ${line.reason}`;
  if (line.status === "set aside") return line.reason;
  return `invalid (${line.mark ?? "NEW"}): ${line.reason}`;
}

export function freshCount(lines: readonly TestLine[]): number {
  return lines.reduce((sum, line) => sum + line.fresh, 0);
}
