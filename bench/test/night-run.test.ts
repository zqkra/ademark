import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_IDS, adapters } from "../adapters/registry.ts";
import type { CalibrationGate, TestId } from "../core/contracts.ts";
import type { CheckResult } from "../ops/doctor.ts";
import { dryInstruments } from "../run/dry.ts";
import type { TestRunner } from "../run/registry.ts";
import { defaultNightDeps, type NightDeps } from "../night/deps.ts";
import { runNight } from "../night/night.ts";
import type { RepairDeps } from "../night/repair.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const GOOD = "night-good";
const BAD = "night-bad";
const RECEIPTS = { samples: null, video: null, frames: null, capture: null, log: null };

let resultsDir: string;
let tasksDir: string;
let arenaDir: string;
let machineCalls: string[];
const saved: Record<string, string | undefined> = {};

function gate(ade: string): CalibrationGate {
  return {
    ade,
    runs: 5,
    passed: 5,
    at: "2026-10-21T00:00:00.000Z",
    harnessCommit: "abc1234",
    version: "1.0.0",
    bundleSha256: "a".repeat(64),
    failures: [],
  };
}

function runners(): Map<TestId, TestRunner> {
  const one: TestRunner = {
    id: "A5",
    track: "A",
    repeats: () => 1,
    maxExtraRuns: 0,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => [
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
    ],
  };
  return new Map([["A5", one]]);
}

const OK_CHECK: CheckResult = {
  name: "fake check",
  blocking: true,
  status: "ok",
  detail: "ok",
  fix: "",
};

function deps(overrides: Partial<NightDeps> = {}): Partial<NightDeps> {
  return {
    username: () => "owner",
    home: () => "/Users/ademark",
    adapters: () => [adapters[GOOD]!, adapters[BAD]!],
    readGate: (id) => (id === GOOD ? gate(GOOD) : null),
    exists: () => true,
    pruneAside: () => {},
    machine: (action, apply, out) => {
      machineCalls.push(`${action}:${apply}`);
      out(`machine ${action}${apply ? "" : " (plan)"}`);
    },
    doctor: async () => ({ results: [OK_CHECK], exitCode: 0 }),
    runners: async () => runners(),
    instruments: (_dryRun, planPath) => dryInstruments(planPath),
    caffeinate: () => {
      throw new Error("a dry night must not start caffeinate");
    },
    ask: async () => {
      throw new Error("a dry night answers yes itself");
    },
    out: () => {},
    now: () => Date.now(),
    git: () => ({ commit: "abc1234def5678", dirty: [] }),
    resultsRoot: () => resultsDir,
    ...overrides,
  };
}

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "ademark-night-"));
  tasksDir = mkdtempSync(join(tmpdir(), "ademark-night-tasks-"));
  arenaDir = mkdtempSync(join(tmpdir(), "ademark-night-arena-"));
  for (const name of ["ADEMARK_RESULTS", "ADEMARK_TASKS", "ADEMARK_ARENA"]) saved[name] = process.env[name];
  process.env.ADEMARK_RESULTS = resultsDir;
  process.env.ADEMARK_TASKS = tasksDir;
  process.env.ADEMARK_ARENA = arenaDir;
  adapters[GOOD] = {
    ...makeFixtureAdapter({ id: GOOD }),
    login: { kind: "agent-cli", files: [], signIn: null },
  };
  adapters[BAD] = {
    ...makeFixtureAdapter({ id: BAD }),
    login: { kind: "agent-cli", files: [], signIn: null },
  };
  for (const id of [GOOD, BAD]) if (!ADAPTER_IDS.includes(id)) ADAPTER_IDS.push(id);
  machineCalls = [];
});

afterEach(() => {
  for (const id of [GOOD, BAD]) {
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

describe("night", () => {
  test("--smoke runs the whole night as smoke runs in its own -smoke folder", async () => {
    const outcome = await runNight({ tracks: ["A"], dryRun: true, runId: "night-smoke", smoke: true, deps: deps() });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.runDir).toBe(join(resultsDir, "night-smoke-dry-smoke"));
    expect(outcome.state.result?.rows).toBe(1);
  }, 60000);

  test("--agent skips an ADE that runs none of the agents and passes them to doctor", async () => {
    adapters[BAD] = { ...adapters[BAD]!, agents: ["codex"] };
    let doctorAgents: readonly string[] | undefined;
    const outcome = await runNight({
      tracks: ["A"],
      dryRun: true,
      runId: "night-agents",
      agents: ["claude"],
      deps: deps({
        doctor: async (agents) => {
          doctorAgents = agents;
          return { results: [OK_CHECK], exitCode: 0 };
        },
      }),
    });
    expect(outcome.exitCode).toBe(0);
    expect(doctorAgents).toEqual(["claude"]);
    expect(outcome.state.skipped).toContainEqual({ ade: BAD, reason: "runs none of --agent claude" });
    expect(outcome.state.result?.order).toEqual([GOOD]);
  }, 60000);

  test("an ungated night measures ADEs without a gate, rehearses the control alone and honours --skip", async () => {
    const outcome = await runNight({
      tracks: ["A"],
      dryRun: true,
      runId: "night-ungated",
      ungated: true,
      skip: [GOOD],
      deps: deps(),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state.rehearsal?.ades).toEqual(["bare-cli"]);
    expect(outcome.state.skipped).toContainEqual({ ade: GOOD, reason: "--skip" });
    expect(outcome.state.result?.order).toEqual([BAD]);
  }, 60000);

  test("a dry night rehearses, plans, measures and writes night.md", async () => {
    const outcome = await runNight({
      tracks: ["A"],
      dryRun: true,
      runId: "night-test",
      deps: deps(),
    });

    expect(outcome.exitCode).toBe(0);
    expect(machineCalls).toEqual(["on:false", "off:false"]);
    expect(outcome.runDir).toBe(join(resultsDir, "night-test-dry"));
    expect(outcome.reportPath).toBe(join(outcome.runDir, "night.md"));
    expect(existsSync(outcome.reportPath)).toBe(true);
    expect(existsSync(join(outcome.runDir, "rows.jsonl"))).toBe(true);

    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("# Night night-test-dry");
    expect(report).toContain("- status: finished");
    expect(report).toContain("- dry run: yes");
    expect(report).toContain("| night-good | measured | 1 |");
    expect(report).toContain("no gate: ademark calibrate gate --ade night-bad");
    expect(report).toContain("## Doctor");
    expect(report).toContain("ok      fake check");
    expect(report).toContain("## Rehearsal");
    expect(report).toContain("- ADEs: bare-cli, night-good");
    expect(report).toContain("- result: passed");
    expect(report).toContain("## Machine");
    expect(report).toContain("machine on (plan)");

    expect(outcome.state.result?.order).toEqual(["night-good"]);
    expect(outcome.state.result?.rows).toBe(1);
    expect(outcome.state.rehearsal?.rows).toBe(3);
  }, 60000);

  test("machine off runs after an error in the middle of the night", async () => {
    const outcome = await runNight({
      tracks: ["A"],
      dryRun: true,
      runId: "night-error",
      deps: deps({
        doctor: async () => {
          throw new Error("doctor exploded");
        },
      }),
    });

    expect(outcome.exitCode).toBe(1);
    expect(machineCalls).toEqual(["on:false", "off:false"]);
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("- status: stopped: doctor exploded");
    expect(report).toContain("## Machine");
    expect(report).toContain("machine off (plan)");
  }, 30000);

  test("a real night is refused outside the ademark user and touches nothing", async () => {
    await expect(
      runNight({ tracks: ["A"], dryRun: false, runId: "night-real", deps: deps() }),
    ).rejects.toThrow(/night: refusing to measure as "owner"/);
    expect(machineCalls).toEqual([]);
    expect(existsSync(join(resultsDir, "night-real"))).toBe(false);
  }, 30000);

  test("without a chosen ADE the rehearsal is the Bare CLI alone", async () => {
    const outcome = await runNight({
      tracks: ["A"],
      dryRun: true,
      runId: "night-empty",
      deps: deps({ readGate: () => null }),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state.rehearsal?.ades).toEqual(["bare-cli"]);
    expect(outcome.state.result?.order).toEqual([]);
    expect(outcome.state.result?.rows).toBe(0);
    expect(readFileSync(outcome.reportPath, "utf8")).toContain("chosen, in run order: none");
  }, 60000);

  test("a blocking doctor failure is reported and a dry night goes on", async () => {
    const failed: CheckResult = { ...OK_CHECK, status: "fail", detail: "swap" };
    const outcome = await runNight({
      tracks: ["A"],
      dryRun: true,
      runId: "night-doctor",
      deps: deps({
        doctor: async () => ({ results: [failed], exitCode: 1 }),
        // A dry run reports the failure and goes on; force the real path by making the check blocking and not dry.
        username: () => "ademark",
      }),
    });
    // Dry runs continue past doctor by design; the report says a real night would stop.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state.warnings.join(" ")).toContain("a real night would stop here");
  }, 60000);

  const noAgent = (): RepairDeps => {
    throw new Error("no repair agent may start");
  };

  test("a dry run prints the repair step and starts no agent", async () => {
    const lines: string[] = [];
    const outcome = await runNight({
      tracks: ["A"],
      dryRun: true,
      runId: "night-repair-dry",
      deps: deps({ repair: noAgent, out: (line) => lines.push(line) }),
    });
    expect(outcome.exitCode).toBe(0);
    expect(lines).toContain("repair: dry run, no agent starts");
  }, 60000);

  test("--no-repair prints that repair is off and starts no agent", async () => {
    const lines: string[] = [];
    await runNight({
      tracks: ["A"],
      dryRun: true,
      repair: false,
      runId: "night-repair-off",
      deps: deps({ repair: noAgent, out: (line) => lines.push(line) }),
    });
    expect(lines).toContain("repair: off");
  }, 60000);

  test("doctor ignores swap only in a night without Track A or C", async () => {
    const seen: Array<boolean | undefined> = [];
    const doctor: NightDeps["doctor"] = async (_agents, options) => {
      seen.push(options?.ignoreSwap);
      return { results: [OK_CHECK], exitCode: 0 };
    };
    await runNight({ tracks: ["A"], dryRun: true, runId: "night-swap-a", deps: deps({ doctor }) });
    await runNight({ tracks: ["B"], dryRun: true, runId: "night-swap-b", deps: deps({ doctor }) });
    expect(seen).toEqual([false, true]);
  }, 60000);
});
