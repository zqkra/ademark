// Retry of a stopped block at the end of the run (ADEMARK-17): only that block's rows and receipts move. A finished
// agent of the same track keeps its receipts and marker, and the old `<track>.done` marker still skips a finished
// single-block track.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_IDS, adapters } from "../adapters/registry.ts";
import { main } from "../cli.ts";
import type { Adapter, Agent, Receipts, ResultRow, TestId } from "../core/contracts.ts";
import { RunWriter } from "../core/results.ts";
import type { TestContext } from "../run/context.ts";
import { dryInstruments } from "../run/dry.ts";
import { runAll, type RunResult } from "../run/loop.ts";
import type { TestRunner } from "../run/registry.ts";
import { blockIsDone } from "../run/retry.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const FIRST = "retry-first";
const SECOND = "retry-second";
const PAIR = "retry-pair";
const LEGACY = "retry-legacy";
const CONTROL = "bare-cli";
const CLAUDE_MODEL = "claude-opus-5-5";
const CODEX_MODEL = "gpt-6.1-sol";
const RECEIPTS: Receipts = { samples: null, video: null, frames: null, capture: null, log: null };

let dir: string;
let previousArena: string | undefined;
let previousControl: Adapter;
/** `<rowAde>/<test>/<agent>` blocks that already stopped once: the retry pass of the same block then succeeds. */
let stopped: Set<string>;
/** How many times each block ran, written into its receipts so a moved copy is told from a fresh one. */
let blockRuns: Map<string, number>;

const RUNNERS_RETRY = join(import.meta.dir, "fixtures", "run", "runners-retry");

function row(ctx: TestContext, id: TestId, variant: string, rep: number, server: "replay" | "live"): ResultRow {
  return ctx.row({
    test_id: id,
    variant,
    rep,
    server,
    value: rep,
    unit: "MB",
    duration_ms: 1,
    valid: true,
    invalid_reason: null,
    receipts: RECEIPTS,
    notes: "",
  });
}

interface Stop {
  rowAde: string;
  agent: Agent;
}

// One receipt per repetition, numbered by the block run that wrote it, so a moved copy is told from a fresh one.
function keepReceipts(ctx: TestContext, id: TestId, rep: number): void {
  const key = `${ctx.rowAde}/${id}/${ctx.options.agent}`;
  if (rep === 1) blockRuns.set(key, (blockRuns.get(key) ?? 0) + 1);
  writeFileSync(join(ctx.receiptDir(id, rep), `note-${rep}.txt`), `run ${blockRuns.get(key) ?? 1}\n`);
}

function stopOnce(ctx: TestContext, testId: TestId, stop: Stop | null): boolean {
  if (stop === null || ctx.rowAde !== stop.rowAde || ctx.options.agent !== stop.agent) return false;
  const key = `${ctx.rowAde}/${testId}/${ctx.options.agent}`;
  if (stopped.has(key)) return false;
  stopped.add(key);
  return true;
}

function a5Runner(stop: Stop | null = null): TestRunner {
  return {
    id: "A5",
    track: "A",
    repeats: () => 2,
    maxExtraRuns: 0,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => {
      keepReceipts(ctx, "A5", rep);
      // The block writes rep 1, then stops on rep 2 on its first attempt.
      if (rep === 2 && stopOnce(ctx, "A5", stop)) throw new Error("boom");
      return [row(ctx, "A5", "", rep, "replay")];
    },
  };
}

function b1Runner(stop: Stop | null = null): TestRunner {
  return {
    id: "B1",
    track: "B",
    repeats: () => 2,
    maxExtraRuns: 0,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => {
      keepReceipts(ctx, "B1", rep);
      if (rep === 2 && stopOnce(ctx, "B1", stop)) throw new Error("boom");
      return [row(ctx, "B1", "fresh-input", rep, "live")];
    },
  };
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function parseRows(path: string): ResultRow[] {
  return lines(path).map((line) => JSON.parse(line) as ResultRow);
}

function parseSuperseded(path: string): Array<ResultRow & { superseded_by: string; attempt_dir: string }> {
  return lines(path).map((line) => JSON.parse(line) as ResultRow & { superseded_by: string; attempt_dir: string });
}

/** The first repetition's receipt, which says which run of the block wrote it. */
function note(...parts: string[]): string {
  return readFileSync(join(...parts, "note-1.txt"), "utf8");
}

async function capturingLogs(run: () => Promise<RunResult>): Promise<{ result: RunResult; logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    return { result: await run(), logs };
  } finally {
    console.log = originalLog;
  }
}

function addAdapter(id: string, adapter: Adapter): void {
  adapters[id] = adapter;
  if (!ADAPTER_IDS.includes(id)) ADAPTER_IDS.push(id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-retry-"));
  previousArena = process.env.ADEMARK_ARENA;
  process.env.ADEMARK_ARENA = join(dir, "arena");
  stopped = new Set<string>();
  blockRuns = new Map<string, number>();
  previousControl = adapters[CONTROL]!;
  adapters[CONTROL] = makeFixtureAdapter({ id: CONTROL, agents: ["claude", "codex"] });
  for (const id of [FIRST, SECOND, PAIR, LEGACY]) addAdapter(id, makeFixtureAdapter({ id }));
});

afterEach(() => {
  adapters[CONTROL] = previousControl;
  for (const id of [FIRST, SECOND, PAIR, LEGACY]) {
    delete adapters[id];
    const index = ADAPTER_IDS.indexOf(id);
    if (index >= 0) ADAPTER_IDS.splice(index, 1);
  }
  if (previousArena === undefined) delete process.env.ADEMARK_ARENA;
  else process.env.ADEMARK_ARENA = previousArena;
  rmSync(dir, { recursive: true, force: true });
});

describe("runAll retry", () => {
  test("a stopped block runs again, supersedes its rows and receipts, and finished blocks are skipped", async () => {
    const writer = new RunWriter(dir).open("retry-run");
    const { result, logs } = await capturingLogs(() =>
      runAll({
        ades: [FIRST, SECOND],
        tracks: ["A", "B"],
        runId: "retry-run",
        seed: "retry",
        instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
        runners: new Map<TestId, TestRunner>([
          ["A5", a5Runner()],
          ["B1", b1Runner({ rowAde: SECOND, agent: "claude" })],
        ]),
        writer,
        adeVersions: {},
      }),
    );

    expect(result.stopped).toBe(false);
    expect([...result.retried]).toEqual([SECOND]);
    expect(logs).toContain(`retry ${SECOND}`);

    const rows = parseRows(writer.rowsPath);
    expect(rows.filter((entry) => entry.ade === SECOND && entry.test_id === "A5").length).toBe(2);
    expect(rows.filter((entry) => entry.ade === SECOND && entry.test_id === "B1").length).toBe(2);
    expect(rows.filter((entry) => entry.ade === FIRST).length).toBe(4);

    const superseded = parseSuperseded(join(writer.runDir, "rows-superseded.jsonl"));
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.ade).toBe(SECOND);
    expect(superseded[0]!.test_id).toBe("B1");
    expect(superseded[0]!.model).toBe(CLAUDE_MODEL);
    expect(superseded[0]!.rep).toBe(1);
    expect(superseded[0]!.superseded_by).toBe("retry 1");
    expect(superseded[0]!.attempt_dir).toBe(`${SECOND}.attempt-1`);

    // The stopped block's receipts moved to attempt 1; the finished Track A block kept its marker and was skipped.
    expect(note(writer.runDir, `${SECOND}.attempt-1`, "B1", "claude", "rep-01")).toBe("run 1\n");
    expect(note(writer.runDir, SECOND, "B1", "claude", "rep-01")).toBe("run 2\n");
    expect(note(writer.runDir, SECOND, "A5", "rep-01")).toBe("run 1\n");
    expect(existsSync(join(writer.runDir, `${SECOND}.attempt-1`, "A5"))).toBe(false);
    expect(existsSync(join(writer.runDir, SECOND, "A-claude.done"))).toBe(true);
    expect(existsSync(join(writer.runDir, SECOND, "A5.done"))).toBe(false);
    expect(existsSync(join(writer.runDir, SECOND, "B-claude.done"))).toBe(true);
    expect(logs).toContain(`[${SECOND}/A] already done, skipped`);
  }, 60000);

  test("a stopped agent supersedes only its own rows and receipts of the row ade", async () => {
    addAdapter(PAIR, makeFixtureAdapter({ id: PAIR, agents: ["claude", "codex"] }));
    const writer = new RunWriter(dir).open("pair-run");
    const { result, logs } = await capturingLogs(() =>
      runAll({
        ades: [PAIR],
        tracks: ["A", "B"],
        runId: "pair-run",
        seed: "retry",
        instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
        runners: new Map<TestId, TestRunner>([
          ["A5", a5Runner()],
          ["B1", b1Runner({ rowAde: PAIR, agent: "codex" })],
        ]),
        writer,
        adeVersions: {},
      }),
    );

    expect(result.stopped).toBe(false);
    expect([...result.retried]).toEqual([PAIR]);

    const rows = parseRows(writer.rowsPath);
    expect(rows.filter((entry) => entry.test_id === "A5").length).toBe(2);
    expect(rows.filter((entry) => entry.test_id === "B1" && entry.model === CLAUDE_MODEL).length).toBe(2);
    expect(rows.filter((entry) => entry.test_id === "B1" && entry.model === CODEX_MODEL).length).toBe(2);

    const superseded = parseSuperseded(join(writer.runDir, "rows-superseded.jsonl"));
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.ade).toBe(PAIR);
    expect(superseded[0]!.test_id).toBe("B1");
    expect(superseded[0]!.model).toBe(CODEX_MODEL);
    expect(superseded[0]!.superseded_by).toBe("retry 1");
    expect(superseded[0]!.attempt_dir).toBe(`${PAIR}.attempt-1`);

    // Only the stopped codex block's B receipts moved; Track A and the finished claude block keep theirs.
    expect(note(writer.runDir, `${PAIR}.attempt-1`, "B1", "codex", "rep-01")).toBe("run 1\n");
    expect(note(writer.runDir, PAIR, "B1", "codex", "rep-01")).toBe("run 2\n");
    expect(note(writer.runDir, PAIR, "B1", "claude", "rep-01")).toBe("run 1\n");
    expect(note(writer.runDir, PAIR, "A5", "rep-01")).toBe("run 1\n");
    expect(existsSync(join(writer.runDir, `${PAIR}.attempt-1`, "B1", "claude"))).toBe(false);
    expect(existsSync(join(writer.runDir, `${PAIR}.attempt-1`, "A5"))).toBe(false);

    // Every marker stays where it is, and the stopped one is written by the retry.
    expect(existsSync(join(writer.runDir, PAIR, "A-claude.done"))).toBe(true);
    expect(existsSync(join(writer.runDir, PAIR, "B-claude.done"))).toBe(true);
    expect(existsSync(join(writer.runDir, PAIR, "B-codex.done"))).toBe(true);
    expect(existsSync(join(writer.runDir, `${PAIR}.attempt-1`, "B-codex.done"))).toBe(false);
    expect(logs).toContain(`[${PAIR}/B] already done, skipped`);
  }, 60000);

  test("the Bare CLI control retries only the row ade whose block stopped", async () => {
    const writer = new RunWriter(dir).open("control-run");
    const { result } = await capturingLogs(() =>
      runAll({
        ades: [CONTROL],
        tracks: ["A"],
        runId: "control-run",
        seed: "retry",
        instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
        runners: new Map<TestId, TestRunner>([["A5", a5Runner({ rowAde: "bare-cli-codex", agent: "codex" })]]),
        writer,
        adeVersions: {},
      }),
    );

    expect(result.stopped).toBe(false);
    expect([...result.retried]).toEqual([CONTROL]);

    const rows = parseRows(writer.rowsPath);
    expect(rows.filter((entry) => entry.ade === "bare-cli-claude").length).toBe(2);
    const claudeRows = rows.filter((entry) => entry.ade === "bare-cli-claude");
    expect(claudeRows.every((entry) => entry.model === CLAUDE_MODEL)).toBe(true);
    expect(rows.filter((entry) => entry.ade === "bare-cli-codex").length).toBe(2);
    const codexRows = rows.filter((entry) => entry.ade === "bare-cli-codex");
    expect(codexRows.every((entry) => entry.model === CODEX_MODEL)).toBe(true);

    const superseded = parseSuperseded(join(writer.runDir, "rows-superseded.jsonl"));
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.ade).toBe("bare-cli-codex");
    expect(superseded[0]!.model).toBe(CODEX_MODEL);
    expect(superseded[0]!.attempt_dir).toBe("bare-cli-codex.attempt-1");

    expect(note(writer.runDir, "bare-cli-codex.attempt-1", "A5", "rep-01")).toBe("run 1\n");
    expect(note(writer.runDir, "bare-cli-codex", "A5", "rep-01")).toBe("run 2\n");
    expect(note(writer.runDir, "bare-cli-claude", "A5", "rep-01")).toBe("run 1\n");
    expect(existsSync(join(writer.runDir, `${CONTROL}.attempt-1`))).toBe(false);
    expect(existsSync(join(writer.runDir, "bare-cli-claude.attempt-1"))).toBe(false);
    expect(existsSync(join(writer.runDir, "bare-cli-claude", "A-claude.done"))).toBe(true);
    expect(existsSync(join(writer.runDir, "bare-cli-codex", "A-codex.done"))).toBe(true);
  }, 60000);

  test("the old <track>.done marker still skips a finished Track A block", async () => {
    const writer = new RunWriter(dir).open("legacy-run");
    mkdirSync(join(writer.runDir, LEGACY), { recursive: true });
    writeFileSync(join(writer.runDir, LEGACY, "A.done"), "2026-10-21 pilot\n");
    const { result, logs } = await capturingLogs(() =>
      runAll({
        ades: [LEGACY],
        tracks: ["A"],
        runId: "legacy-run",
        seed: "retry",
        instruments: dryInstruments(join(writer.runDir, "plan.jsonl")),
        runners: new Map<TestId, TestRunner>([["A5", a5Runner()]]),
        writer,
        adeVersions: {},
      }),
    );

    expect(result.rows).toBe(0);
    expect(logs).toContain(`[${LEGACY}/A] already done, skipped`);
    expect(readFileSync(writer.rowsPath, "utf8")).toBe("");
    expect(existsSync(join(writer.runDir, LEGACY, "A-claude.done"))).toBe(false);
    expect(existsSync(join(writer.runDir, `${LEGACY}.attempt-1`))).toBe(false);
  }, 60000);

  test("an old marker counts only for a single-block track", () => {
    mkdirSync(join(dir, "legacy-ade"), { recursive: true });
    writeFileSync(join(dir, "legacy-ade", "A.done"), "old\n");
    expect(blockIsDone(dir, "legacy-ade", "A", "claude", false)).toBe(false);
    expect(blockIsDone(dir, "legacy-ade", "A", "claude", true)).toBe(true);
    expect(blockIsDone(dir, "legacy-ade", "B", "claude", true)).toBe(false);
    writeFileSync(join(dir, "legacy-ade", "B-codex.done"), "new\n");
    expect(blockIsDone(dir, "legacy-ade", "B", "codex", false)).toBe(true);
    expect(blockIsDone(dir, "legacy-ade", "B", "claude", false)).toBe(false);
  });

  test("the CLI retries a stopped block and archives attempt 1", async () => {
    const previousResults = process.env.ADEMARK_RESULTS;
    process.env.ADEMARK_RESULTS = dir;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map((part) => String(part)).join(" "));
    };
    let code: number;
    try {
      code = await main([
        "run",
        "--ade",
        FIRST,
        "--tracks",
        "A",
        "--dry-run",
        "--run-id",
        "cli-retry",
        "--runners",
        RUNNERS_RETRY,
      ]);
    } finally {
      console.log = originalLog;
      if (previousResults === undefined) delete process.env.ADEMARK_RESULTS;
      else process.env.ADEMARK_RESULTS = previousResults;
    }
    expect(code).toBe(0);
    expect(logs).toContain(`retry ${FIRST}`);

    const runDir = join(dir, "cli-retry-dry");
    expect(existsSync(join(runDir, "rows-superseded.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, `${FIRST}.attempt-1`, "A5.done"))).toBe(false);
    expect(existsSync(join(runDir, `${FIRST}.attempt-1`))).toBe(true);
    expect(existsSync(join(runDir, FIRST, "A-claude.done"))).toBe(true);
    const superseded = parseSuperseded(join(runDir, "rows-superseded.jsonl"));
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.ade).toBe(FIRST);
    expect(superseded[0]!.rep).toBe(1);
    expect(superseded[0]!.superseded_by).toBe("retry 1");
    expect(superseded[0]!.attempt_dir).toBe(`${FIRST}.attempt-1`);
  }, 60000);
});
