import { gatesDir as liveGatesDir } from "../adapters/gates.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_IDS, adapters } from "../adapters/registry.ts";
import { calibrateGate, gateOutputDir } from "../calibrate/gate.ts";
import type { TestId } from "../core/contracts.ts";
import type { TestRunner } from "../run/registry.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const ADE_ID = "gate-ade";
const RECEIPTS = { samples: null, video: null, frames: null, capture: null, log: null };

let resultsDir: string;
let gatesDir: string;
let tasksDir: string;
let arenaDir: string;
const saved: Record<string, string | undefined> = {};

function runner(valid: boolean): { runners: Map<TestId, TestRunner>; calls: () => number } {
  let calls = 0;
  const one: TestRunner = {
    id: "A5",
    track: "A",
    repeats: () => 1,
    maxExtraRuns: 0,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => {
      calls += 1;
      if (!valid) throw new Error("fixture stopped");
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
  return { runners: new Map([["A5", one]]), calls: () => calls };
}

function runFolders(): string[] {
  return readdirSync(resultsDir).filter((name) => name.startsWith(`gate-${ADE_ID}-`));
}

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "ademark-gate-runs-"));
  gatesDir = mkdtempSync(join(tmpdir(), "ademark-gate-outs-"));
  tasksDir = mkdtempSync(join(tmpdir(), "ademark-gate-tasks-"));
  arenaDir = mkdtempSync(join(tmpdir(), "ademark-gate-arena-"));
  for (const name of ["ADEMARK_TASKS", "ADEMARK_ARENA"]) saved[name] = process.env[name];
  process.env.ADEMARK_TASKS = tasksDir;
  process.env.ADEMARK_ARENA = arenaDir;
  adapters[ADE_ID] = makeFixtureAdapter({ id: ADE_ID });
  if (!ADAPTER_IDS.includes(ADE_ID)) ADAPTER_IDS.push(ADE_ID);
});

afterEach(() => {
  delete adapters[ADE_ID];
  const index = ADAPTER_IDS.indexOf(ADE_ID);
  if (index >= 0) ADAPTER_IDS.splice(index, 1);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of [resultsDir, gatesDir, tasksDir, arenaDir]) rmSync(dir, { recursive: true, force: true });
});

describe("calibrate gate", () => {
  test("five dry passes write passed: 5 and one run folder per run", async () => {
    const runs = runner(true);
    const git = { head: () => "abc1234", dirty: () => [] as string[] };
    const outcome = await calibrateGate({
      ade: ADE_ID,
      runs: 5,
      dryRun: true,
      runners: runs.runners,
      resultsRoot: resultsDir,
      gatesDir,
      git,
      out: () => {},
    });

    expect(outcome.passed).toBe(true);
    expect(runs.calls()).toBe(5);
    expect(runFolders().length).toBe(5);
    const gate = JSON.parse(readFileSync(outcome.file, "utf8")) as Record<string, unknown>;
    expect(gate).toEqual({
      ade: ADE_ID,
      runs: 5,
      passed: 5,
      at: gate.at as string,
      harnessCommit: "abc1234",
      version: "1.0.0",
      bundleSha256: "a".repeat(64),
      failures: [],
    });
    expect(Number.isNaN(Date.parse(gate.at as string))).toBe(false);
    expect(outcome.file).toBe(join(gatesDir, `${ADE_ID}.json`));
  }, 60000);

  test("it stops at the first failing run and records the failures", async () => {
    const runs = runner(false);
    const outcome = await calibrateGate({
      ade: ADE_ID,
      runs: 3,
      dryRun: true,
      runners: runs.runners,
      resultsRoot: resultsDir,
      gatesDir,
      git: { head: () => "abc1234", dirty: () => [] },
      out: () => {},
    });

    // One smoke run fails, and runAll's retry of the stopped ADE fails again; the gate stops after that run.
    expect(runs.calls()).toBe(2);
    expect(runFolders().length).toBe(1);
    expect(outcome.passed).toBe(false);
    expect(outcome.gate.runs).toBe(3);
    expect(outcome.gate.passed).toBe(0);
    expect(outcome.gate.failures).toEqual([`${ADE_ID} A block: A5 rep 1: fixture stopped`]);
    expect(JSON.parse(readFileSync(outcome.file, "utf8"))).toEqual(outcome.gate);
  }, 60000);

  test("a scratch gate writes to a temp folder, never to the live gates", () => {
    expect(gateOutputDir({ ade: ADE_ID, scratch: true }, false)).not.toBe(liveGatesDir());
    expect(gateOutputDir({ ade: ADE_ID }, false)).toBe(liveGatesDir());
    expect(gateOutputDir({ ade: ADE_ID, gatesDir }, false)).toBe(gatesDir);
  });

  test("it refuses to write a passing gate on a dirty tree", async () => {
    const runs = runner(true);
    await expect(
      calibrateGate({
        ade: ADE_ID,
        runs: 1,
        dryRun: true,
        runners: runs.runners,
        resultsRoot: resultsDir,
        gatesDir,
        git: { head: () => "abc1234", dirty: () => [" M bench/cli.ts"] },
        out: () => {},
      }),
    ).rejects.toThrow(/refusing to write a passing gate/);
    expect(existsSync(join(gatesDir, `${ADE_ID}.json`))).toBe(false);
    expect(runs.calls()).toBe(1);
  }, 60000);

  test("a real gate refuses a dirty tree before the first run", async () => {
    const runs = runner(true);
    await expect(
      calibrateGate({
        ade: ADE_ID,
        runs: 2,
        dryRun: false,
        username: "ademark",
        runners: runs.runners,
        resultsRoot: resultsDir,
        gatesDir,
        git: { head: () => "abc1234", dirty: () => [" M bench/calibrate/gate.ts"] },
        out: () => {},
      }),
    ).rejects.toThrow(/refusing to write a passing gate.*1 uncommitted file/s);
    expect(runs.calls()).toBe(0);
    expect(runFolders().length).toBe(0);
    expect(existsSync(join(gatesDir, `${ADE_ID}.json`))).toBe(false);
  }, 30000);

  test("it refuses to write a passing gate when HEAD changed during the runs", async () => {
    const runs = runner(true);
    const heads = ["abc1234", "def5678"];
    let calls = 0;
    await expect(
      calibrateGate({
        ade: ADE_ID,
        runs: 2,
        dryRun: true,
        runners: runs.runners,
        resultsRoot: resultsDir,
        gatesDir,
        git: { head: () => heads[calls++] ?? "def5678", dirty: () => [] },
        out: () => {},
      }),
    ).rejects.toThrow(/the harness changed while the gate ran \(HEAD abc1234 -> def5678\)/);
    expect(calls).toBe(2);
    expect(runs.calls()).toBe(2);
    expect(existsSync(join(gatesDir, `${ADE_ID}.json`))).toBe(false);
  }, 60000);

  test("a real gate is refused outside the ademark user", async () => {
    await expect(
      calibrateGate({ ade: ADE_ID, runs: 1, dryRun: false, username: "owner", out: () => {} }),
    ).rejects.toThrow(/refusing to measure as "owner"/);
    expect(runFolders().length).toBe(0);
  }, 30000);
});
