import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunWriter, validateRow } from "../core/results.ts";
import type { ResultRow } from "../core/contracts.ts";

function validRow(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    run_id: "2026-10-21T19-00Z-3f9c2a1",
    machine_id: "ref-mac-mini-m4-16gb",
    ade: "t3code",
    ade_version: "0.1.0",
    ade_build_sha256: "a".repeat(64),
    family: "EL-SDK",
    test_id: "A1",
    variant: "cold",
    rep: 3,
    model: null,
    effort: null,
    server: "none",
    value: 2.41,
    unit: "s",
    started_at: "2026-10-21T19:42:07.113Z",
    duration_ms: 41230,
    valid: true,
    invalid_reason: null,
    drive: "cdp",
    receipts: {
      samples: "t3code/A1/rep-03/samples.csv",
      video: null,
      frames: null,
      capture: null,
      log: null,
    },
    notes: "",
    ...overrides,
  };
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ademark-results-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("RunWriter", () => {
  test("accepts a valid row and writes one JSON line", () => {
    withTmp((dir) => {
      const writer = new RunWriter(dir).open("run-1");
      writer.appendRow(validRow({ run_id: "run-1" }));
      const lines = readFileSync(writer.rowsPath, "utf8").trim().split("\n");
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!).test_id).toBe("A1");
    });
  });

  test("rejects a bad family", () => {
    expect(() => validateRow(validRow({ family: "EL-SDKX" as never }))).toThrow(/family/);
  });

  test("rejects an unknown test id", () => {
    expect(() => validateRow(validRow({ test_id: "A99" as never }))).toThrow(/test_id/);
  });

  test("rejects rep below 1 and a non-integer rep", () => {
    expect(() => validateRow(validRow({ rep: 0 }))).toThrow(/rep/);
    expect(() => validateRow(validRow({ rep: 1.5 }))).toThrow(/rep/);
  });

  test("rejects a non-numeric value", () => {
    expect(() => validateRow(validRow({ value: "2.41" as never }))).toThrow(/value/);
    expect(() => validateRow(validRow({ value: Number.NaN }))).toThrow(/value/);
  });

  test("rejects valid:false without invalid_reason", () => {
    expect(() => validateRow(validRow({ valid: false, invalid_reason: null }))).toThrow(/invalid_reason/);
    expect(() => validateRow(validRow({ valid: false, invalid_reason: "" }))).toThrow(/invalid_reason/);
  });

  test("accepts valid:false with a reason", () => {
    expect(validateRow(validRow({ valid: false, invalid_reason: "system dialog" })).valid).toBe(false);
  });

  test("rejects an unknown server and drive", () => {
    expect(() => validateRow(validRow({ server: "proxy" as never }))).toThrow(/server/);
    expect(() => validateRow(validRow({ drive: "mouse" as never }))).toThrow(/drive/);
  });

  test("rejects a receipt field that is not a string or null", () => {
    expect(() =>
      validateRow(validRow({ receipts: { samples: 4 as never, video: null, frames: null, capture: null, log: null } })),
    ).toThrow(/receipts.samples/);
  });

  test("rejects a missing receipt key", () => {
    expect(() =>
      validateRow(validRow({ receipts: { samples: null, video: null, frames: null, capture: null } as never })),
    ).toThrow(/receipts.log/);
  });

  test("rejects a row whose run_id differs from the writer's", () => {
    withTmp((dir) => {
      const writer = new RunWriter(dir).open("run-1");
      expect(() => writer.appendRow(validRow({ run_id: "run-2" }))).toThrow(/run_id/);
    });
  });

  test("rejects an unsafe run id", () => {
    withTmp((dir) => {
      expect(() => new RunWriter(dir).open("../escape")).toThrow(/safe path segment/);
    });
  });

  test("open(runId) sets the run and a bad id is refused", () => {
    withTmp((dir) => {
      expect(() => new RunWriter(dir).open("run-1")).not.toThrow();
      const writer = new RunWriter(dir);
      expect(() => writer.appendRow(validRow())).toThrow(/call open/);
      expect(() => writer.open("../escape")).toThrow(/safe path segment/);
    });
  });

  test("receiptDir uses two digits and creates the folder", () => {
    withTmp((dir) => {
      const writer = new RunWriter(dir).open("run-1");
      const rep3 = writer.receiptDir("t3code", "A1", 3);
      expect(rep3.endsWith(join("t3code", "A1", "rep-03"))).toBe(true);
      expect(existsSync(rep3)).toBe(true);
      const rep12 = writer.receiptDir("t3code", "A10", 12);
      expect(rep12.endsWith(join("t3code", "A10", "rep-12"))).toBe(true);
    });
  });

  test("receiptDir rejects a bad rep", () => {
    withTmp((dir) => {
      const writer = new RunWriter(dir).open("run-1");
      expect(() => writer.receiptDir("t3code", "A1", 0)).toThrow(/rep/);
    });
  });

  test("event writes a timestamped line and rejects unknown kinds", () => {
    withTmp((dir) => {
      const writer = new RunWriter(dir).open("run-1");
      writer.event("gate_failure", "swap used 1200 MB");
      const line = readFileSync(writer.eventsPath, "utf8").trim();
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z gate_failure swap used 1200 MB$/);
      expect(() => writer.event("explosion" as never, "x")).toThrow(/unknown event kind/);
    });
  });
});
