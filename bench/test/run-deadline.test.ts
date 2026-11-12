import { afterEach, beforeEach, describe, expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_IDS, adapters } from "../adapters/registry.ts";
import type { TestId } from "../core/contracts.ts";
import { shuffle } from "../core/order.ts";
import { RunWriter } from "../core/results.ts";
import { dryInstruments } from "../run/dry.ts";
import { runAll } from "../run/loop.ts";
import type { TestRunner } from "../run/registry.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const A = "deadline-a";
const B = "deadline-b";
const START = Date.parse("2026-10-21T22:00:00.000Z");
const RECEIPTS = { samples: null, video: null, frames: null, capture: null, log: null };

let resultsDir: string;
let tasksDir: string;
let arenaDir: string;
let calls: string[];
const saved: Record<string, string | undefined> = {};

function advance(ms: number): void {
  setSystemTime(new Date(Date.now() + ms));
}

// One A5 row per call; `after` runs before the row is returned, so a test can move the clock inside a block.
function runner(id: string, after: () => void): TestRunner {
  return {
    id: "A5",
    track: "A",
    repeats: () => 1,
    maxExtraRuns: 0,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => {
      calls.push(id);
      after();
      return [
        ctx.row({
          test_id: "A5",
          variant: "",
          rep,
          server: "replay",
          value: 300,
          unit: "MB",
          duration_ms: 1000,
          valid: true,
          invalid_reason: null,
          receipts: RECEIPTS,
          notes: "",
        }),
      ];
    },
  };
}

function runnersFor(map: Record<string, TestRunner>): Map<TestId, TestRunner> {
  return new Map(Object.entries(map).map(([id, value]) => [id as TestId, value]));
}

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "ademark-deadline-"));
  tasksDir = mkdtempSync(join(tmpdir(), "ademark-deadline-tasks-"));
  arenaDir = mkdtempSync(join(tmpdir(), "ademark-deadline-arena-"));
  for (const name of ["ADEMARK_RESULTS", "ADEMARK_TASKS", "ADEMARK_ARENA"]) saved[name] = process.env[name];
  process.env.ADEMARK_RESULTS = resultsDir;
  process.env.ADEMARK_TASKS = tasksDir;
  process.env.ADEMARK_ARENA = arenaDir;
  adapters[A] = makeFixtureAdapter({ id: A });
  adapters[B] = makeFixtureAdapter({ id: B });
  for (const id of [A, B]) if (!ADAPTER_IDS.includes(id)) ADAPTER_IDS.push(id);
  calls = [];
  setSystemTime(new Date(START));
});

afterEach(() => {
  setSystemTime();
  for (const id of [A, B]) {
    delete adapters[id];
    const index = ADAPTER_IDS.indexOf(id);
    if (index >= 0) ADAPTER_IDS.splice(index, 1);
  }
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of [resultsDir, tasksDir, arenaDir]) rmSync(dir, { recursive: true, force: true });
});

describe("runAll deadline", () => {
  test("a deadline in the past starts no ADE", async () => {
    const runId = "deadline-past";
    const writer = new RunWriter(resultsDir).open(runId);
    const result = await runAll({
      ades: [A, B],
      tracks: ["A"],
      runId,
      seed: "deadline",
      instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
      runners: runnersFor({ A5: runner(A, () => {}) }),
      writer,
      deadline: START - 1,
    });

    expect(result.skippedForTime.sort()).toEqual([A, B]);
    expect(result.blocks).toEqual([]);
    expect(result.rows).toBe(0);
    expect(result.stopped).toBe(false);
    expect(calls).toEqual([]);
  }, 30000);

  test("an ADE that started finishes, and the next one is skipped", async () => {
    const runId = "deadline-mid";
    const order = shuffle([A, B], "deadline");
    const first = order[0]!;
    const second = order[1]!;
    const writer = new RunWriter(resultsDir).open(runId);
    const result = await runAll({
      ades: [A, B],
      tracks: ["A"],
      runId,
      seed: "deadline",
      instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
      // The block starts before the deadline and moves the clock past it while it measures.
      runners: runnersFor({
        A5: runner(first, () => setSystemTime(new Date(START + 60_000))),
      }),
      writer,
      deadline: START + 1000,
    });

    expect(calls).toEqual([first]);
    expect(result.skippedForTime).toEqual([second]);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]!.ade).toBe(first);
    expect(result.blocks[0]!.finished).toBe(true);
    expect(result.rows).toBe(1);
  }, 30000);

  test("a retry is skipped once the deadline has passed", async () => {
    const runId = "deadline-retry";
    const failing: TestRunner = {
      id: "A5",
      track: "A",
      repeats: () => 1,
      maxExtraRuns: 0,
      needsExtraRun: () => false,
      runRep: async () => {
        calls.push(A);
        setSystemTime(new Date(START + 60_000));
        throw new Error("fixture stopped");
      },
    };
    const writer = new RunWriter(resultsDir).open(runId);
    const result = await runAll({
      ades: [A],
      tracks: ["A"],
      runId,
      seed: "deadline",
      instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
      runners: runnersFor({ A5: failing }),
      writer,
      deadline: START + 1000,
    });

    expect(calls).toEqual([A]);
    expect(result.retried).toEqual([]);
    expect(result.skippedForTime).toEqual([A]);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]!.finished).toBe(false);
    expect(result.stopped).toBe(true);
  }, 30000);
});
