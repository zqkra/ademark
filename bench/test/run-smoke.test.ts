// Smoke mode (ADEMARK-17): one repetition per test, short windows, a smoke manifest and a banner in the summary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_IDS, adapters } from "../adapters/registry.ts";
import type { Manifest, ResultRow } from "../core/contracts.ts";
import { RunWriter } from "../core/results.ts";
import { SMOKE_BANNER, formatSummary, type RunSummary } from "../core/summarize.ts";
import { dryInstruments } from "../run/dry.ts";
import { runAll } from "../run/loop.ts";
import type { TestRunner } from "../run/registry.ts";
import { SMOKE, smokeCount, smokeSeconds } from "../run/smoke.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const ADE_ID = "smoke-ade";
const RECEIPTS = { samples: null, video: null, frames: null, capture: null, log: null };

let dir: string;
let previousArena: string | undefined;
let sends: string[];
let reps: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-smoke-"));
  previousArena = process.env.ADEMARK_ARENA;
  process.env.ADEMARK_ARENA = join(dir, "arena");
  sends = [];
  reps = [];
  adapters[ADE_ID] = makeFixtureAdapter({
    id: ADE_ID,
    onCall: (call, args) => {
      if (call === "adapter.send") sends.push(String(args.text));
    },
  });
  if (!ADAPTER_IDS.includes(ADE_ID)) ADAPTER_IDS.push(ADE_ID);
});

afterEach(() => {
  delete adapters[ADE_ID];
  const index = ADAPTER_IDS.indexOf(ADE_ID);
  if (index >= 0) ADAPTER_IDS.splice(index, 1);
  if (previousArena === undefined) delete process.env.ADEMARK_ARENA;
  else process.env.ADEMARK_ARENA = previousArena;
  rmSync(dir, { recursive: true, force: true });
});

const runner: TestRunner = {
  id: "A5",
  track: "A",
  repeats: () => 10,
  maxExtraRuns: 3,
  adaptive: { variant: "", min: 6, absTol: 1 },
  needsExtraRun: () => true,
  runRep: async (ctx, rep) => {
    reps.push(rep);
    return [
      ctx.row({
        test_id: "A5",
        variant: "",
        rep,
        server: "replay",
        value: 300,
        unit: "MB",
        duration_ms: 1,
        valid: true,
        invalid_reason: null,
        receipts: RECEIPTS,
        notes: "settle 20 s",
      }),
    ];
  },
};

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

describe("smoke numbers", () => {
  test("every duration comes from the table only in smoke mode", () => {
    expect(smokeSeconds({ smoke: true }, 60, SMOKE.a7WindowS)).toBe(20);
    expect(smokeSeconds({ smoke: false }, 60, SMOKE.a7WindowS)).toBe(60);
    expect(smokeCount({ smoke: true }, 15, SMOKE.a10ExtraThreads)).toBe(3);
    expect(smokeCount({ smoke: false }, 15, SMOKE.a10ExtraThreads)).toBe(15);
  });
});

describe("a smoke run", () => {
  test("runs one repetition per test, seeds two threads and is never published as full", async () => {
    const writer = new RunWriter(dir).open("smoke-run");
    const result = await runAll({
      ades: [ADE_ID],
      tracks: ["A"],
      runId: "smoke-run",
      seed: "smoke",
      instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
      runners: new Map([["A5", runner]]),
      writer,
      adeVersions: {},
      smoke: true,
    });
    expect(result.stopped).toBe(false);
    expect(reps).toEqual([1]);
    expect(sends).toEqual(["replay:seed", "replay:seed"]);

    const manifest = JSON.parse(readFileSync(join(writer.runDir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.mode).toBe("smoke");

    const rows = lines(join(writer.runDir, "rows.jsonl")).map((line) => JSON.parse(line) as ResultRow);
    expect(rows.length).toBe(1);
    expect(rows[0]!.notes).toBe("dry run; smoke; settle 20 s");

    const summary = JSON.parse(readFileSync(join(writer.runDir, "summary.json"), "utf8")) as RunSummary;
    expect(summary.smoke).toBe(true);
    expect(formatSummary(summary).split("\n")[0]).toBe(SMOKE_BANNER);
  }, 60000);

  test("a full run keeps the full mode, the five seed threads and no banner", async () => {
    const writer = new RunWriter(dir).open("full-run");
    await runAll({
      ades: [ADE_ID],
      tracks: ["A"],
      runId: "full-run",
      seed: "full",
      instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
      runners: new Map([["A5", runner]]),
      writer,
      adeVersions: {},
    });
    expect(sends.length).toBe(5);
    expect(reps).toEqual([1, 2, 3, 4, 5, 6]);
    const manifest = JSON.parse(readFileSync(join(writer.runDir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.mode).toBeUndefined();
    const summary = JSON.parse(readFileSync(join(writer.runDir, "summary.json"), "utf8")) as RunSummary;
    expect(summary.smoke).toBe(false);
    expect(formatSummary(summary)).not.toContain(SMOKE_BANNER);
  }, 60000);
});
