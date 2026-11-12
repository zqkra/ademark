// ADEMARK-45: an invalid row is an accepted limit only when an approved entry names its app, test and reason.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leftoverReason } from "../tracks/a-timing/a2-relaunch.ts";
import { NO_REPLAY_MARKER } from "../tracks/a-timing/a3-thread-open.ts";
import { row } from "./control-rows.ts";
import { ACCEPTED_LIMITS, KNOWN_FAILURES, limitFor, markOf, type AcceptedLimit } from "../night/known-failures.ts";
import { freshCount, testLines } from "../control/verdicts.ts";

// The reasons of today, built by the code that writes them (read only).
const ORCA_A2 = leftoverReason(1.58, 1);
const T3_A7 = "streams never reached the model: stream-5, stream-1";

const approved = (limits: readonly AcceptedLimit[]): AcceptedLimit[] => limits.map((limit) => ({ ...limit, approved: "2026-11-10" }));

describe("accepted limits", () => {
  test("the list keeps what its callers read: the repair notes per app", () => {
    expect(KNOWN_FAILURES.orca).toContain("A2 stopped");
    expect(KNOWN_FAILURES.t3code).toContain("Seed thread");
  });

  test("the entries are the limits found so far, all waiting for the owner", () => {
    expect(ACCEPTED_LIMITS.map((limit) => `${limit.ade} ${limit.test}`)).toEqual([
      "orca A2",
      "claude-desktop A3",
      "t3code A7",
      "diri A2",
      "traycer A2",
    ]);
    expect(ACCEPTED_LIMITS.every((limit) => limit.approved === "" && limit.evidence.length > 0)).toBe(true);
  });

  // R1 of the review, 2026-11-10: the Orca pattern quoted a reason the code no longer wrote, so the limit would have shown
  // as NEW every night. Each entry must match a reason the code of today produces.
  test("every entry matches the reason the code of today writes", () => {
    // a7-fight-weight.ts builds this reason inline; the test fails when that expression changes.
    const a7 = readFileSync(join(import.meta.dir, "..", "tracks", "a-weight", "a7-fight-weight.ts"), "utf8");
    expect(a7).toContain("`streams never reached the model: ${unsent.map((stream) => `stream-${stream}`).join(\", \")}`");
    const a7Reason = (unsent: number[]): string => `streams never reached the model: ${unsent.map((stream) => `stream-${stream}`).join(", ")}`;
    const produced: Record<string, string[]> = {
      "orca A2": [leftoverReason(1.58, 1), `A2 ended for this app: ${leftoverReason(1.58, 1)}`, leftoverReason(0.4, 3)],
      "claude-desktop A3": [NO_REPLAY_MARKER],
      "t3code A7": [a7Reason([5, 1])],
      // The reasons of the night of 10 Nov (ADEMARK-54).
      "diri A2": [leftoverReason(0, 3), `A2 ended for this app: ${leftoverReason(0, 3)}`],
      "traycer A2": [leftoverReason(0.1, 14), `A2 ended for this app: ${leftoverReason(0.36, 9)}`],
    };
    for (const limit of ACCEPTED_LIMITS) {
      const reasons = produced[`${limit.ade} ${limit.test}`];
      expect(reasons).toBeDefined();
      for (const reason of reasons!) expect(limitFor({ ade: limit.ade, test_id: limit.test, invalid_reason: reason })).toBe(limit);
    }
    // The text of before 2026-11-10 no longer matches: it is not written any more.
    expect(limitFor({ ade: "orca", test_id: "A2", invalid_reason: "the Mac stayed busy after the quit (1.58 cores): 1 processes of the app kept working" })).toBeNull();
    expect(limitFor({ ade: "t3code", test_id: "A7", invalid_reason: a7Reason([2, 3, 4, 5, 1]) })).toBeNull();
  });

  test("matches the exact app and test, and the pattern on the reason", () => {
    expect(limitFor({ ade: "orca", test_id: "A2", invalid_reason: ORCA_A2 })?.test).toBe("A2");
    // The repetitions after the first carry a prefix, and the cores change.
    expect(limitFor({ ade: "orca", test_id: "A2", invalid_reason: `A2 ended for this app: ${ORCA_A2.replace("1.58", "0.9")}` })).not.toBeNull();
    expect(limitFor({ ade: "orca-own", test_id: "A2", invalid_reason: ORCA_A2 })).not.toBeNull();
    expect(limitFor({ ade: "orcaish", test_id: "A2", invalid_reason: ORCA_A2 })).toBeNull();
    expect(limitFor({ ade: "paseo", test_id: "A2", invalid_reason: ORCA_A2 })).toBeNull();
    expect(limitFor({ ade: "orca", test_id: "A1", invalid_reason: ORCA_A2 })).toBeNull();
    expect(limitFor({ ade: "orca", test_id: "A2", invalid_reason: "0.00 cores: 0 processes" })).toBeNull();
    expect(limitFor({ ade: "orca", test_id: "A2", invalid_reason: "quit failed: the app is still running" })).toBeNull();
    expect(limitFor({ ade: "t3code", test_id: "A7", invalid_reason: T3_A7 })).not.toBeNull();
    // Traycer's gate failure of 10 Nov (top-up rep 1) is another fault and stays NEW.
    expect(limitFor({ ade: "traycer", test_id: "A2", invalid_reason: "gate failure" })).toBeNull();
    expect(limitFor({ ade: "diri", test_id: "A3", invalid_reason: leftoverReason(0, 3) })).toBeNull();
    // Five lost streams is another fault, not the 2 of 5 of 8 Nov.
    expect(limitFor({ ade: "t3code", test_id: "A7", invalid_reason: "streams never reached the model: stream-2, stream-3, stream-4, stream-5, stream-1" })).toBeNull();
  });

  test("an entry that is not approved still shows as NEW", () => {
    const orca = { ade: "orca", test_id: "A2", invalid_reason: ORCA_A2 };
    expect(markOf(orca)).toBe("NEW");
    expect(markOf(orca, approved(ACCEPTED_LIMITS))).toBe("accepted limit");
    expect(markOf({ ...orca, invalid_reason: "timed_out" }, approved(ACCEPTED_LIMITS))).toBe("NEW");
    expect(markOf(orca, [{ ...ACCEPTED_LIMITS[0]!, approved: "soon" }])).toBe("NEW");
  });

  test("a test line counts only the rows no approved limit names", () => {
    const rows = [
      row({ rep: 1, valid: false, invalid_reason: ORCA_A2 }),
      row({ rep: 2, valid: false, invalid_reason: `A2 ended for this app: ${ORCA_A2}` }),
      row({ test_id: "A4", variant: "total", valid: false, invalid_reason: "timed_out" }),
      row({ test_id: "A5", variant: "app", valid: true }),
    ];
    const now = testLines("orca", rows);
    expect(now.map((line) => `${line.test} ${line.status} ${line.mark}`)).toEqual(["A2 invalid NEW", "A4 invalid NEW", "A5 valid null"]);
    expect(freshCount(now)).toBe(3);
    const later = testLines("orca", rows, [], approved(ACCEPTED_LIMITS));
    expect(later.find((line) => line.test === "A2")?.mark).toBe("accepted limit");
    expect(freshCount(later)).toBe(1);
    // A row stays invalid: the mark never changes valid.
    expect(later.find((line) => line.test === "A2")?.status).toBe("invalid");
  });

  test("a missing test and an app with no row count as NEW", () => {
    expect(testLines("orca", [row({ test_id: "A5", variant: "app" })], ["A5", "A11"]).map((line) => `${line.test} ${line.status}`)).toEqual(["A5 valid", "A11 missing"]);
    expect(freshCount(testLines("orca", []))).toBe(1);
  });
});
