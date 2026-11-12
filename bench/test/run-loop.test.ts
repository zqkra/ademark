import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ADAPTER_IDS, adapters } from "../adapters/registry.ts";
import { main } from "../cli.ts";
import type { TestId } from "../core/contracts.ts";
import { RunWriter } from "../core/results.ts";
import type { ResultRow } from "../core/contracts.ts";
import { checkContamination } from "../run/contamination.ts";
import { dryInstruments } from "../run/dry.ts";
import type { ReplayControl } from "../run/instruments.ts";
import { runAde, runAll } from "../run/loop.ts";
import { loadRunners, type TestRunner } from "../run/registry.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures", "run");
const RUNNERS = join(FIXTURES, "runners");
const THROWING = join(FIXTURES, "runners-throwing");
const ADE_ID = "fixture-ade";

let resultsDir: string;
let tasksDir: string;
let arenaDir: string;
let previousResults: string | undefined;
let previousTasks: string | undefined;
let previousArena: string | undefined;
let planPath: string | null = null;

interface PlanLine {
  call: string;
  args: Record<string, unknown>;
}

// The fixture adapter writes its own steps into the same plan the dry instruments write to.
function mark(call: string, args: Record<string, unknown> = {}): void {
  if (planPath === null) return;
  mkdirSync(dirname(planPath), { recursive: true });
  appendFileSync(planPath, `${JSON.stringify({ call, args })}\n`);
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function plan(file: string): PlanLine[] {
  return lines(file).map((line) => JSON.parse(line) as PlanLine);
}

function parseRows(path: string): Array<Record<string, unknown>> {
  return lines(path).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function seedSends(entries: PlanLine[]): PlanLine[] {
  return entries.filter((entry) => entry.call === "adapter.send" && entry.args.text === "replay:seed");
}

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "ademark-run-"));
  tasksDir = mkdtempSync(join(tmpdir(), "ademark-tasks-"));
  arenaDir = mkdtempSync(join(tmpdir(), "ademark-arena-"));
  previousResults = process.env.ADEMARK_RESULTS;
  previousTasks = process.env.ADEMARK_TASKS;
  previousArena = process.env.ADEMARK_ARENA;
  process.env.ADEMARK_RESULTS = resultsDir;
  process.env.ADEMARK_TASKS = tasksDir;
  process.env.ADEMARK_ARENA = arenaDir;
  adapters[ADE_ID] = makeFixtureAdapter({ id: ADE_ID, onCall: mark });
  if (!ADAPTER_IDS.includes(ADE_ID)) ADAPTER_IDS.push(ADE_ID);
  planPath = null;
});

afterEach(() => {
  delete adapters[ADE_ID];
  const index = ADAPTER_IDS.indexOf(ADE_ID);
  if (index >= 0) ADAPTER_IDS.splice(index, 1);
  if (previousResults === undefined) delete process.env.ADEMARK_RESULTS;
  else process.env.ADEMARK_RESULTS = previousResults;
  if (previousTasks === undefined) delete process.env.ADEMARK_TASKS;
  else process.env.ADEMARK_TASKS = previousTasks;
  if (previousArena === undefined) delete process.env.ADEMARK_ARENA;
  else process.env.ADEMARK_ARENA = previousArena;
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(tasksDir, { recursive: true, force: true });
  rmSync(arenaDir, { recursive: true, force: true });
  planPath = null;
});

// 2026-11-11: Superset, Capy and Cloudroom each lost a block to an error, and nothing said what was on screen.
describe("the window at a block's error", () => {
  test("a screenshot is kept in the block folder, numbered; a dry run and an app that never launched keep none", async () => {
    const { failureShot } = await import("../run/loop.ts");
    const shots: Array<{ pid: number; out: string }> = [];
    const real = { dryRun: false, screenshot: async (o: { pid: number; out: string }) => {
      shots.push(o);
      writeFileSync(o.out, "png");
      return { path: o.out };
    } } as never;
    const block = join(resultsDir, "run-x", "superset");
    expect(await failureShot(real, 4242, block, "A")).toBe(join(block, "failure-A-1.png"));
    expect(await failureShot(real, 4242, block, "A")).toBe(join(block, "failure-A-2.png"));
    expect(shots.map((shot) => shot.pid)).toEqual([4242, 4242]);
    expect(await failureShot(real, undefined, block, "A")).toBeNull();
    expect(await failureShot(real, 0, block, "A")).toBeNull();
    expect(await failureShot({ dryRun: true, screenshot: async () => ({ path: "" }) } as never, 4242, block, "A")).toBeNull();
    expect(shots.length).toBe(2);
  });
});

describe("run loop", () => {
  // 2026-11-11: super.engineering ships its orchestration off, and the reset restores that before every block.
  test("a Track C block switches orchestration on after the reset and before the launch; A and B never do", async () => {
    adapters[ADE_ID]!.prepareOrchestration = async () => mark("adapter.prepareOrchestration", {});
    planPath = join(resultsDir, "fixture-orch-dry", "plan.jsonl");
    expect(await main(["run", "--ade", ADE_ID, "--tracks", "A,B,C", "--dry-run", "--run-id", "fixture-orch", "--runners", RUNNERS])).toBe(0);
    const calls = plan(planPath).map((entry) => entry.call);
    // One call, in the last block of the three: after its reset and configure, before its launch.
    expect(calls.filter((call) => call === "adapter.prepareOrchestration").length).toBe(1);
    const at = calls.indexOf("adapter.prepareOrchestration");
    expect(calls.slice(0, at).filter((call) => call === "adapter.reset").length).toBe(3);
    expect(calls.slice(0, at).filter((call) => call === "adapter.launch").length).toBe(2);
    expect(calls[at - 1]).toBe("adapter.configure");
    expect(calls.slice(at).indexOf("adapter.launch")).toBeGreaterThan(0);
  });

  test("a switch that cannot be made stops the Track C block with the reason, before the app is launched", async () => {
    adapters[ADE_ID]!.prepareOrchestration = async () => {
      throw new Error("no experimental.agent_orchestration in /Users/ademark/.super.engineering/settings.json");
    };
    planPath = join(resultsDir, "fixture-off-dry", "plan.jsonl");
    await main(["run", "--ade", ADE_ID, "--tracks", "C", "--dry-run", "--run-id", "fixture-off", "--runners", RUNNERS]);
    const runDir = join(resultsDir, "fixture-off-dry");
    expect(plan(planPath).map((entry) => entry.call)).not.toContain("adapter.launch");
    expect(existsSync(join(runDir, ADE_ID, "C-claude.done"))).toBe(false);
    expect(existsSync(join(runDir, "rows.jsonl")) ? parseRows(join(runDir, "rows.jsonl")).length : 0).toBe(0);
    expect(readFileSync(join(runDir, "events.log"), "utf8")).toContain("orchestration could not be switched on: no experimental.agent_orchestration");
  });

  test("fixture end to end: tracks A, B and C in a dry run", async () => {
    planPath = join(resultsDir, "fixture-ok-dry", "plan.jsonl");
    const code = await main([
      "run",
      "--ade",
      ADE_ID,
      "--tracks",
      "A,B,C",
      "--dry-run",
      "--run-id",
      "fixture-ok",
      "--runners",
      RUNNERS,
    ]);
    expect(code).toBe(0);

    const runDir = join(resultsDir, "fixture-ok-dry");
    expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(runDir, "summary.json"))).toBe(true);
    expect(existsSync(join(runDir, "events.log"))).toBe(true);
    expect(existsSync(join(runDir, "plan.jsonl"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
      run_id: string;
      verified: boolean;
    };
    expect(manifest.run_id).toBe("fixture-ok-dry");
    expect(manifest.verified).toBe(false);

    const rows = parseRows(join(runDir, "rows.jsonl"));
    expect(rows.length).toBe(3 + 3 + 1);
    expect(rows.filter((row) => row.test_id === "A5").length).toBe(3);
    expect(rows.filter((row) => row.test_id === "B1").length).toBe(3);
    expect(rows.filter((row) => row.test_id === "C1").length).toBe(1);
    expect(rows.every((row) => row.valid === true)).toBe(true);
    expect(rows.every((row) => row.notes === "dry run")).toBe(true);
    expect(rows.every((row) => row.run_id === "fixture-ok-dry")).toBe(true);

    for (const track of ["A", "B", "C"]) {
      expect(existsSync(join(runDir, ADE_ID, `${track}-claude.done`))).toBe(true);
    }

    // R7: one gate_values event per block.
    const events = lines(join(runDir, "events.log"));
    expect(events.filter((line) => line.includes(" gate_values ")).length).toBe(3);

    const entries = plan(join(runDir, "plan.jsonl"));
    const calls = entries.map((entry) => entry.call);
    const gates = calls.indexOf("gates");
    const blockPrepare = entries.findIndex(
      (entry) => entry.call === "prepareArena" && String(entry.args.dest).endsWith(ADE_ID),
    );
    const startReplay = calls.indexOf("startReplay");
    const contamination = calls.indexOf("contamination");
    const reset = calls.indexOf("adapter.reset");
    const launch = calls.indexOf("adapter.launch");
    expect(gates).toBeGreaterThanOrEqual(0);
    expect(blockPrepare).toBeGreaterThan(gates);
    expect(reset).toBeGreaterThan(blockPrepare);
    expect(startReplay).toBeGreaterThan(reset);
    expect(contamination).toBeGreaterThan(startReplay);
    expect(launch).toBeGreaterThan(contamination);

    // R1: the five seed threads belong to Track A only.
    expect(seedSends(entries).length).toBe(5);

    // R3: the contamination prompt runs in the dedicated folder.
    const contaminationLines = entries.filter((entry) => entry.call === "contamination");
    expect(contaminationLines.length).toBe(3);
    for (const entry of contaminationLines) {
      expect(entry.args.workdir).toBe(join(arenaDir, "_contamination"));
    }

    // R5: Track C samples from just after launch until the block ends.
    const samplerStart = calls.indexOf("sampleStart");
    expect(samplerStart).toBeGreaterThan(calls.lastIndexOf("adapter.launch"));
    expect(calls.at(-1)).toBe("sampleStart.stop");

    // R6: the first diff lands in _start/, later ones under the previous row ade.
    expect(existsSync(join(runDir, "_start", "global-config-diff.patch"))).toBe(true);
    expect(existsSync(join(runDir, ADE_ID, "global-config-diff.patch"))).toBe(true);
  }, 120000);

  test("Track B and C send no replay:seed", async () => {
    const sends: Record<string, number> = {};
    for (const track of ["A", "B", "C"] as const) {
      const writer = new RunWriter(resultsDir).open(`seed-${track.toLowerCase()}`);
      planPath = join(writer.runDir, "plan.jsonl");
      const result = await runAde({
        ade: ADE_ID,
        tracks: [track],
        runId: writer.runId,
        runDir: writer.runDir,
        machineId: "machine-1",
        instruments: dryInstruments(planPath),
        writer,
        runners: await loadRunners(RUNNERS),
      });
      expect(result.stopped).toBe(false);
      sends[track] = seedSends(plan(planPath)).length;
    }
    expect(sends).toEqual({ A: 5, B: 0, C: 0 });
  }, 60000);

  test("a throwing runner writes a harness error, no .done and exit 1", async () => {
    planPath = join(resultsDir, "fixture-boom-dry", "plan.jsonl");
    const code = await main([
      "run",
      "--ade",
      ADE_ID,
      "--tracks",
      "A,B,C",
      "--dry-run",
      "--run-id",
      "fixture-boom",
      "--runners",
      THROWING,
    ]);
    expect(code).toBe(1);

    const runDir = join(resultsDir, "fixture-boom-dry");
    const events = readFileSync(join(runDir, "events.log"), "utf8");
    expect(events).toContain("harness_error");
    expect(events).toContain("harness error: fixture-ade/B: B1 rep 1: boom");
    expect(existsSync(join(runDir, ADE_ID, "A-claude.done"))).toBe(true);
    expect(existsSync(join(runDir, ADE_ID, "B-claude.done"))).toBe(false);
    expect(existsSync(join(runDir, ADE_ID, "C-claude.done"))).toBe(false);
    expect(parseRows(join(runDir, "rows.jsonl")).length).toBe(3);
    expect(existsSync(join(runDir, "summary.json"))).toBe(true);
  }, 120000);

  test("runAde runs one track with a writer and no manifest", async () => {
    const writer = new RunWriter(resultsDir).open("direct-run");
    planPath = join(writer.runDir, "plan.jsonl");
    const result = await runAde({
      ade: ADE_ID,
      tracks: ["A"],
      runId: writer.runId,
      runDir: writer.runDir,
      machineId: "machine-1",
      instruments: dryInstruments(planPath),
      writer,
      runners: await loadRunners(RUNNERS),
    });
    expect(result.stopped).toBe(false);
    expect(result.rows).toBe(3);
    expect(result.blocks.map((block) => block.track)).toEqual(["A"]);
    expect(existsSync(join(writer.runDir, ADE_ID, "A-claude.done"))).toBe(true);
    expect(parseRows(writer.rowsPath).length).toBe(3);
  }, 60000);

  test("a gate failure stops the block before reset", async () => {
    const writer = new RunWriter(resultsDir).open("gate-run");
    planPath = join(writer.runDir, "plan.jsonl");
    const instruments = dryInstruments(planPath);
    const result = await runAde({
      ade: ADE_ID,
      tracks: ["A"],
      runId: writer.runId,
      runDir: writer.runDir,
      machineId: "machine-1",
      instruments: {
        ...instruments,
        gates: async () => ({
          swap_ok: false,
          swap_used_mb: 2048,
          thermal_ok: true,
          cpu_quiet_ok: true,
          cpu_cores_used: 0.01,
        }),
      },
      writer,
      runners: await loadRunners(RUNNERS),
    });
    expect(result.stopped).toBe(true);
    expect(result.rows).toBe(0);
    expect(existsSync(join(writer.runDir, ADE_ID, "A-claude.done"))).toBe(false);
    const events = readFileSync(writer.eventsPath, "utf8");
    expect(events).toContain("gate_values");
    expect(events).toContain("gate_failure");
    const planFile = join(writer.runDir, "plan.jsonl");
    const calls = existsSync(planFile) ? plan(planFile).map((entry) => entry.call) : [];
    expect(calls).not.toContain("adapter.reset");
  }, 60000);

  test("a changed contamination hash is recorded and the next track still measures", async () => {
    const writer = new RunWriter(resultsDir).open("contamination-run");
    planPath = join(writer.runDir, "plan.jsonl");
    const instruments = dryInstruments(planPath);
    const hashes = ["a".repeat(64), "b".repeat(64)];
    let calls = 0;
    const result = await runAde({
      ade: ADE_ID,
      tracks: ["A", "B"],
      runId: writer.runId,
      runDir: writer.runDir,
      machineId: "machine-1",
      instruments: {
        ...instruments,
        contamination: async () => ({ bytes: 1024, body_sha256: hashes[Math.min(calls++, 1)]! }),
      },
      writer,
      runners: await loadRunners(RUNNERS),
    });
    expect(result.blocks.map((block) => block.track)).toEqual(["A", "B"]);
    expect(result.blocks[0]!.finished).toBe(true);
    expect(result.blocks[1]!.finished).toBe(true);
    expect(existsSync(join(writer.runDir, ADE_ID, "B-claude.done"))).toBe(true);
    expect(readFileSync(writer.eventsPath, "utf8")).toContain("contamination drift");
    // Every row of the drifted block says so; the first block's rows do not.
    const rowsWritten = readFileSync(join(writer.runDir, "rows.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as ResultRow);
    const drifted = rowsWritten.filter((row) => row.notes.includes("control request changed"));
    expect(drifted.length).toBeGreaterThan(0);
    expect(drifted.every((row) => row.test_id.startsWith("B"))).toBe(true);
  }, 60000);

  test("the block publishes the replay control to Track A runners and removes it for Track B", async () => {
    const seen: Record<string, unknown> = {};
    const receipts = { samples: null, video: null, frames: null, capture: null, log: null };
    const runners = new Map<TestId, TestRunner>([
      [
        "A5",
        {
          id: "A5",
          track: "A",
          repeats: () => 1,
          maxExtraRuns: 0,
          needsExtraRun: () => false,
          runRep: async (ctx, rep) => {
            seen.A = ctx.state.get("replay");
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
                receipts,
                notes: "",
              }),
            ];
          },
        },
      ],
      [
        "B1",
        {
          id: "B1",
          track: "B",
          repeats: () => 1,
          maxExtraRuns: 0,
          needsExtraRun: () => false,
          runRep: async (ctx, rep) => {
            seen.B = ctx.state.get("replay");
            return [
              ctx.row({
                test_id: "B1",
                variant: "fresh-input",
                rep,
                server: "live",
                value: 42,
                unit: "tokens",
                duration_ms: 1000,
                valid: true,
                invalid_reason: null,
                receipts,
                notes: "",
              }),
            ];
          },
        },
      ],
    ]);

    const writer = new RunWriter(resultsDir).open("replay-state");
    planPath = join(writer.runDir, "plan.jsonl");
    const result = await runAde({
      ade: ADE_ID,
      tracks: ["A", "B"],
      runId: writer.runId,
      runDir: writer.runDir,
      machineId: "machine-1",
      instruments: dryInstruments(planPath),
      writer,
      runners,
    });

    expect(result.stopped).toBe(false);
    const control = seen.A as ReplayControl | undefined;
    expect(control?.logPath).toBe(join(writer.runDir, ADE_ID, "a-replay.jsonl"));
    expect(typeof control?.port).toBe("number");
    expect(seen.B).toBeUndefined();
  }, 60000);

  test("--reference marks the manifest verified", async () => {
    planPath = join(resultsDir, "reference-dry", "plan.jsonl");
    const result = await runAll({
      ades: [ADE_ID],
      tracks: ["A"],
      runId: "reference-dry",
      seed: "reference",
      instruments: dryInstruments(planPath),
      runners: new Map(),
      reference: true,
    });
    const manifest = JSON.parse(readFileSync(join(result.runDir, "manifest.json"), "utf8")) as {
      verified: boolean;
    };
    expect(manifest.verified).toBe(true);
  }, 60000);
});

describe("contamination reference", () => {
  test("the first result becomes the reference and later results must match", () => {
    const reference = { body_sha256: null as string | null };
    expect(checkContamination(reference, { bytes: 10, body_sha256: "a".repeat(64) }).message).toBe("reference");
    expect(reference.body_sha256).toBe("a".repeat(64));
    expect(checkContamination(reference, { bytes: 10, body_sha256: "a".repeat(64) }).ok).toBe(true);
    const mismatch = checkContamination(reference, { bytes: 11, body_sha256: "b".repeat(64) });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("!=");
  });
});
