import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAdapter } from "../adapters/registry.ts";
import { SAMPLE_COLUMNS } from "../core/contracts.ts";
import { RunWriter } from "../core/results.ts";
import { createTestContext, type TestContext } from "../run/context.ts";
import { dryInstruments } from "../run/dry.ts";
import {
  BYTES_PER_MB,
  emptyReceipts,
  groupSeries,
  invalidRow,
  missingCalibration,
  readSamples,
  receipt,
  type CalibrationKey,
} from "../run/kit.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

let dir: string;

function makeContext(root: string): TestContext {
  const instruments = dryInstruments(join(root, "plan.jsonl"));
  const writer = new RunWriter(root).open("kit-run");
  const adapter = makeFixtureAdapter();
  return createTestContext({
    runId: "kit-run",
    runDir: writer.runDir,
    machineId: "machine-1",
    adapter,
    rowAde: adapter.id,
    track: "A",
    options: { model: null, effort: null, server: "replay", agent: "claude" },
    instruments,
    writer,
    adapterCtx: { runDir: writer.runDir, arenaPath: root, worktree: root, home: root, env: {}, dryRun: true, log: () => {} },
    installed: { installed: true, version: "1.0.0", path: null, binarySha256: null },
    freshArena: async () => root,
    state: new Map(),
  });
}

const SAMPLE_CSV = [
  SAMPLE_COLUMNS.join(","),
  `0,101,1,app,"/Applications/Example, Inc.app/Contents/MacOS/Example",314572800,314572800,0,0,0,0,-1`,
  "0,202,101,agents,/usr/local/bin/claude,157286400,157286400,0,0,0,0,-1",
  `250000000,101,1,app,"/Applications/Example, Inc.app/Contents/MacOS/Example",300000000,314572800,0,0,0,0,-1`,
  "250000000,202,101,agents,/usr/local/bin/claude,150000000,157286400,0,0,0,0,-1",
].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-kit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("kit", () => {
  test("BYTES_PER_MB is the MB unit of TESTS.md §0.1", () => {
    expect(BYTES_PER_MB).toBe(1_048_576);
  });

  test("emptyReceipts has five null fields", () => {
    expect(emptyReceipts()).toEqual({ samples: null, video: null, frames: null, capture: null, log: null });
  });

  test("receipt gives the absolute path and the run-relative one", () => {
    const ctx = makeContext(dir);
    const path = receipt(ctx, "A5", 1, "samples.csv");
    expect(path.abs).toBe(join(dir, "kit-run", "fixture-ade", "A5", "rep-01", "samples.csv"));
    expect(path.rel).toBe("fixture-ade/A5/rep-01/samples.csv");
    expect(existsSync(dirname(path.abs))).toBe(true);
    expect(() => receipt(ctx, "A5", 1, "../escape.csv")).toThrow(/unsafe/);
    expect(() => receipt(ctx, "A5", 1, "/tmp/escape.csv")).toThrow(/unsafe/);
  });

  test("invalidRow clears the value and explains the invalidity", () => {
    const ctx = makeContext(dir);
    const row = invalidRow(
      ctx,
      {
        test_id: "A5",
        variant: "",
        rep: 1,
        server: "replay",
        unit: "s",
        duration_ms: 10,
        receipts: emptyReceipts(),
        notes: "",
      },
      "window closed",
    );
    expect(row.value).toBeNull();
    expect(row.valid).toBe(false);
    expect(row.invalid_reason).toBe("window closed");
    expect(row.test_id).toBe("A5");
    expect(row.notes).toBe("dry run");
  });

  test("missingCalibration names the first missing key", () => {
    const all: CalibrationKey[] = ["composerRect", "threadRect", "launch", "newThread", "send", "longThread", "shortThread"];
    const t3code = getAdapter("t3code");
    const noLong = { ...t3code, timed: { ...t3code.timed, longThread: undefined } };
    expect(missingCalibration(noLong, ["longThread"])).toBe("not calibrated: longThread");
    const cleared = { ...t3code, calibration: { ...t3code.calibration, composerRect: null } };
    expect(missingCalibration(cleared, ["composerRect"])).toBe("not calibrated: composerRect");

    const zeroSized = makeFixtureAdapter();
    zeroSized.calibration.composerRect = { x: 0, y: 0, w: 0, h: 0 };
    expect(missingCalibration(zeroSized, ["composerRect"])).toBe("not calibrated: composerRect");

    const calibrated = makeFixtureAdapter();
    calibrated.calibration.composerRect = { x: 0, y: 0, w: 10, h: 10 };
    calibrated.calibration.threadRect = { x: 0, y: 0, w: 10, h: 10 };
    calibrated.timed.launch = [{ kind: "wait", ms: 0 }];
    calibrated.timed.newThread = [{ kind: "enter" }];
    calibrated.timed.send = [{ kind: "type", text: "hi" }];
    calibrated.timed.longThread = [{ kind: "click", point: { x: 1, y: 1 } }];
    calibrated.timed.shortThread = [{ kind: "wait", ms: 1 }];
    expect(missingCalibration(calibrated, all)).toBeNull();

    calibrated.timed.send = [];
    expect(missingCalibration(calibrated, all)).toBe("not calibrated: send");
    calibrated.timed.send = [{ kind: "type", text: "hi" }];
    delete calibrated.timed.longThread;
    expect(missingCalibration(calibrated, all)).toBe("not calibrated: longThread");
  });

  test("readSamples parses numbers and keeps -1", () => {
    const csv = join(dir, "samples.csv");
    writeFileSync(csv, `${SAMPLE_CSV}\n`);
    const rows = readSamples(csv);
    expect(rows.length).toBe(4);
    expect(rows[0]!.t_ns).toBe(0);
    expect(rows[0]!.phys_footprint_b).toBe(314572800);
    expect(rows[0]!.exe).toContain(", Inc.app");
    expect(rows[0]!.energy_nj).toBe(-1);
    expect(rows[3]!.group).toBe("agents");
  });

  test("readSamples rejects a foreign header and non-numeric cells", () => {
    const csv = join(dir, "samples.csv");
    writeFileSync(csv, "nope,pid\n0,1\n");
    expect(() => readSamples(csv)).toThrow(/header/);
    writeFileSync(csv, `${SAMPLE_COLUMNS.join(",")}\n0,x,1,app,/bin/x,1,1,0,0,0,0,0\n`);
    expect(() => readSamples(csv)).toThrow(/not a number/);
  });

  test("groupSeries sums each tick for app, agents and total", () => {
    const csv = join(dir, "samples.csv");
    writeFileSync(csv, `${SAMPLE_CSV}\n`);
    const rows = readSamples(csv).reverse();
    expect(groupSeries(rows, "app")).toEqual([
      { t_ns: 0, bytes: 314572800 },
      { t_ns: 250000000, bytes: 300000000 },
    ]);
    expect(groupSeries(rows, "agents")).toEqual([
      { t_ns: 0, bytes: 157286400 },
      { t_ns: 250000000, bytes: 150000000 },
    ]);
    expect(groupSeries(rows, "total")).toEqual([
      { t_ns: 0, bytes: 471859200 },
      { t_ns: 250000000, bytes: 450000000 },
    ]);
  });
});
