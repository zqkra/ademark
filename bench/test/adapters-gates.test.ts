import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateFile, gateStatus, readGate, writeGate } from "../adapters/gates.ts";
import type { CalibrationGate, InstallInfo } from "../core/contracts.ts";

const GATE: CalibrationGate = {
  ade: "demo-ade",
  runs: 3,
  passed: 3,
  at: "2026-10-19T00:00:00.000Z",
  harnessCommit: "abc1234",
  version: "1.0.0",
  bundleSha256: "a".repeat(64),
  failures: [],
};

const INSTALLED: InstallInfo = {
  installed: true,
  version: "1.0.0",
  path: "/Applications/Demo.app",
  binarySha256: "a".repeat(64),
};

let dir = "";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.ADEMARK_GATES;
  dir = mkdtempSync(join(tmpdir(), "ademark-gates-"));
  process.env.ADEMARK_GATES = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.ADEMARK_GATES;
  else process.env.ADEMARK_GATES = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("gate records", () => {
  test("a missing gate is null", () => {
    expect(readGate("demo-ade")).toBeNull();
  });

  test("writeGate then readGate round-trips", () => {
    const file = writeGate(GATE);
    expect(file).toBe(gateFile("demo-ade"));
    expect(readGate("demo-ade")).toEqual(GATE);
  });

  test("writeGate then readGate take their own directory", () => {
    const other = mkdtempSync(join(tmpdir(), "ademark-gates-other-"));
    try {
      const file = writeGate(GATE, other);
      expect(file).toBe(join(other, "demo-ade.json"));
      expect(readGate("demo-ade", other)).toEqual(GATE);
      expect(readGate("demo-ade")).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("an invalid gate record names its bad fields", () => {
    writeGate(GATE);
    const broken = { ...GATE, runs: -1, failures: "nope" };
    writeFileSync(gateFile("demo-ade"), JSON.stringify(broken));
    expect(() => readGate("demo-ade")).toThrow(/runs: must be a non-negative integer/);
    expect(() => readGate("demo-ade")).toThrow(/failures: must be an array of strings/);
  });

  test("the ade field matches the file name", () => {
    writeFileSync(gateFile("demo-ade"), JSON.stringify({ ...GATE, ade: "other-ade" }));
    expect(() => readGate("demo-ade")).toThrow(/ade: "other-ade" does not match the gate file "demo-ade.json"/);
  });

  test("passed cannot exceed runs", () => {
    writeFileSync(gateFile("demo-ade"), JSON.stringify({ ...GATE, passed: 4 }));
    expect(() => readGate("demo-ade")).toThrow(/passed: must not be greater than runs/);
  });

  test("broken JSON is reported", () => {
    writeFileSync(gateFile("demo-ade"), "{oops");
    expect(() => readGate("demo-ade")).toThrow(/not valid JSON/);
  });
});

describe("gateStatus", () => {
  test("ok when the run passed and the installed bundle matches", () => {
    expect(gateStatus(GATE, INSTALLED)).toBe("ok");
  });

  test("missing when the app is not installed", () => {
    expect(gateStatus(GATE, { installed: false, version: null, path: null, binarySha256: null })).toBe("missing");
  });

  test("failed when fewer runs passed than were attempted", () => {
    expect(gateStatus({ ...GATE, passed: 2 }, INSTALLED)).toBe("failed");
  });

  test("stale when the installed version differs", () => {
    expect(gateStatus(GATE, { ...INSTALLED, version: "1.0.1" })).toBe("stale");
  });

  test("stale when the installed bundle hash differs", () => {
    expect(gateStatus(GATE, { ...INSTALLED, binarySha256: "b".repeat(64) })).toBe("stale");
  });
});
