import { describe, expect, test } from "bun:test";
import { passFailures, type PassBlock, type PassRow } from "../calibrate/pass.ts";

function block(over: Partial<PassBlock> = {}): PassBlock {
  return { ade: "t3code", track: "A", finished: true, error: null, ...over };
}

function row(over: Partial<PassRow> = {}): PassRow {
  return { ade: "t3code", test_id: "A1", variant: "cold", valid: true, invalid_reason: null, ...over };
}

describe("smoke-run pass rule", () => {
  test("finished blocks and valid rows pass", () => {
    expect(passFailures([block()], [row(), row({ test_id: "A5", variant: "" })])).toEqual([]);
  });

  test("a row whose reason starts with not supported is not a failure", () => {
    expect(
      passFailures([block()], [row({ valid: false, invalid_reason: "not supported: C1 has no orchestration" })]),
    ).toEqual([]);
  });

  test("not supported anywhere but the start is a failure", () => {
    expect(passFailures([block()], [row({ valid: false, invalid_reason: "crashed: not supported" })])).toEqual([
      "t3code A1 cold: crashed: not supported",
    ]);
  });

  test("a stopped block is a failure with its error", () => {
    expect(passFailures([block({ finished: false, error: "gates: swap used 512 MB" })], [])).toEqual([
      "t3code A block: gates: swap used 512 MB",
    ]);
  });

  test("a stopped block without an error says it did not finish", () => {
    expect(passFailures([block({ finished: false, track: "B" })], [])).toEqual([
      "t3code B block: did not finish",
    ]);
  });

  test("an invalid row is a failure with its reason", () => {
    expect(passFailures([block()], [row({ test_id: "A5", variant: "", valid: false, invalid_reason: "timeout" })])).toEqual([
      "t3code A5: timeout",
    ]);
  });

  test("an invalid row with no reason still fails", () => {
    expect(passFailures([], [row({ valid: false, invalid_reason: null })])).toEqual(["t3code A1 cold: invalid"]);
  });

  test("every failure is listed, blocks first", () => {
    expect(
      passFailures(
        [block({ finished: false, error: "harness" }), block({ ade: "zeron", finished: false, error: "quit" })],
        [row({ ade: "zeron", valid: false, invalid_reason: "no window" })],
      ),
    ).toEqual(["t3code A block: harness", "zeron A block: quit", "zeron A1 cold: no window"]);
  });
});
