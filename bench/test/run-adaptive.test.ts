// Adaptive repetitions (TESTS.md §1.3): the stop rule of runTest on stable, noisy and invalid fixtures.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultRow, TestId } from "../core/contracts.ts";
import { RunWriter } from "../core/results.ts";
import { createTestContext, type TestContext } from "../run/context.ts";
import { dryInstruments } from "../run/dry.ts";
import { runTest } from "../run/loop.ts";
import type { TestRunner } from "../run/registry.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const ID: TestId = "A3";
const VARIANT = "default-mode";
const RECEIPTS = { samples: null, video: null, frames: null, capture: null, log: null };

// `null` writes an invalid row: it must never count toward the minimum or the stop rule.
type Spec = ReadonlyArray<number | null>;

interface Harness {
  ctx: TestContext;
  runner: TestRunner;
  writer: RunWriter;
  logs: string[];
  restore(): void;
}

function harness(spec: Spec): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ademark-adaptive-"));
  const writer = new RunWriter(dir).open("adaptive-run");
  const adapter = makeFixtureAdapter();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((part) => String(part)).join(" "));
  };
  const ctx = createTestContext({
    runId: "adaptive-run",
    runDir: writer.runDir,
    machineId: "machine-1",
    adapter,
    rowAde: adapter.id,
    track: "A",
    options: { model: null, effort: null, server: "replay", agent: "claude" },
    instruments: dryInstruments(join(dir, "plan.jsonl")),
    writer,
    adapterCtx: {
      runDir: writer.runDir,
      arenaPath: dir,
      worktree: dir,
      home: dir,
      env: {},
      dryRun: true,
      log: () => {},
    },
    installed: { installed: true, version: "1.0.0", path: null, binarySha256: null },
    freshArena: async () => dir,
    state: new Map(),
  });
  const runner: TestRunner = {
    id: ID,
    track: "A",
    repeats: () => 10,
    maxExtraRuns: 3,
    adaptive: { variant: VARIANT, min: 6, absTol: 1000 / 60 },
    needsExtraRun: () => false,
    runRep: async (c, rep): Promise<ResultRow[]> => {
      const value = spec[rep - 1];
      return [
        c.row({
          test_id: ID,
          variant: VARIANT,
          rep,
          server: "replay",
          value: value ?? null,
          unit: "ms",
          duration_ms: 1,
          valid: value !== null && value !== undefined,
          invalid_reason: value === null || value === undefined ? "fixture invalid" : null,
          receipts: RECEIPTS,
          notes: "",
        }),
      ];
    },
  };
  return {
    ctx,
    runner,
    writer,
    logs,
    restore: () => {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let active: Harness | null = null;

beforeEach(() => {
  active = null;
});

afterEach(() => {
  active?.restore();
});

function open(spec: Spec): Harness {
  active = harness(spec);
  return active;
}

describe("runTest adaptive repetitions", () => {
  test("a stable fixture stops at six with the converged reason", async () => {
    const h = open([1200, 1201, 1199, 1200, 1202, 1198, 1200, 1201, 1199, 1200]);
    const written = await runTest(h.runner, h.ctx, h.writer);
    expect(written).toBe(6);
    expect(h.logs).toEqual(["[fixture-ade] A3 default-mode: stopped at n=6 of 6 (converged)"]);
  });

  test("a noisy fixture runs to the ten-run cap without converging", async () => {
    const h = open([1200, 1500, 1000, 1400, 1100, 1600, 900, 1300, 1700, 800, 1250, 1350, 1450]);
    const written = await runTest(h.runner, h.ctx, h.writer);
    expect(written).toBe(10);
    expect(h.logs).toEqual(["[fixture-ade] A3 default-mode: stopped at n=10 of 10 (cap)"]);
  });

  test("invalid rows do not count toward the minimum, so the stop moves to the sixth valid run", async () => {
    const h = open([null, null, 1200, 1201, 1199, 1200, 1202, 1198, 1200, 1201, 1199, 1200, 1200]);
    const written = await runTest(h.runner, h.ctx, h.writer);
    expect(written).toBe(8);
    expect(h.logs).toEqual(["[fixture-ade] A3 default-mode: stopped at n=6 of 8 (converged)"]);
  });

  test("a fixture that is always invalid stops after three failed repetitions in a row", async () => {
    const h = open([null, null, null, null, null, null, null, null, null, null, null, null, null]);
    const written = await runTest(h.runner, h.ctx, h.writer);
    expect(written).toBe(3);
    expect(h.logs).toEqual([
      "[fixture-ade] A3: stopped after 3 failed repetitions in a row",
      "[fixture-ade] A3 default-mode: stopped at n=0 of 3 (failed)",
    ]);
  });
});

describe("the agent between repetitions", () => {
  function watchSpy(repairs: boolean) {
    const calls: string[] = [];
    return {
      calls,
      watch: {
        before: async (testId: TestId, rep: number) => void calls.push(`before ${testId} ${rep}`),
        recover: async (testId: TestId, rep: number, reason: string) => {
          calls.push(`recover ${testId} ${rep} ${reason}`);
          return repairs;
        },
      },
    };
  }

  test("a failed repetition the agent repaired runs once more, and the test is not given up", async () => {
    const h = open([null, null, null, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    h.runner.adaptive = undefined;
    h.runner.repeats = () => 4;
    h.runner.maxExtraRuns = 0;
    const spy = watchSpy(true);
    const written = await runTest(h.runner, h.ctx, h.writer, spy.watch);
    // Reps 1 and 2 failed and were repaired (the cap is 2); rep 3 failed with no repair left; rep 4 passed; then the
    // two owed repetitions ran as reps 5 and 6.
    expect(written).toBe(6);
    expect(spy.calls.filter((call) => call.startsWith("recover"))).toEqual([
      "recover A3 1 fixture invalid",
      "recover A3 2 fixture invalid",
    ]);
    expect(spy.calls.filter((call) => call.startsWith("before")).length).toBe(6);
  });

  test("with no repair nothing is added and three failures in a row still stop the test", async () => {
    const h = open([null, null, null, 100]);
    h.runner.adaptive = undefined;
    h.runner.repeats = () => 4;
    h.runner.maxExtraRuns = 0;
    const spy = watchSpy(false);
    const written = await runTest(h.runner, h.ctx, h.writer, spy.watch);
    expect(written).toBe(3);
  });
});
