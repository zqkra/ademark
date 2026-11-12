import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent, CaptureRow, ResultRow, RunOptions } from "../core/contracts.ts";
import { validateRow, RunWriter } from "../core/results.ts";
import { loadTask } from "../core/tasks.ts";
import { dryInstruments } from "../run/dry.ts";
import { createTestContext, type TestContext } from "../run/context.ts";
import type { CaptureControl } from "../run/instruments.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";
import { b1HelloTax } from "../tracks/b/b1-hello-tax.ts";
import { b2RequestAnatomy } from "../tracks/b/b2-request-anatomy.ts";
import { b3RealPromptTax } from "../tracks/b/b3-real-prompt-tax.ts";
import { b4RepoRules } from "../tracks/b/b4-repo-rules.ts";
import { anatomyOf, estimateTokens } from "../tracks/b/b2-request-anatomy.ts";
import { promptLeft, readPrices, repComponents, repProblem, tokenRowSet, type RepCapture } from "../tracks/b/shared.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures", "tracks-b");
const TASKS = resolve(import.meta.dir, "..", "..", "tasks");
const BODY = JSON.parse(readFileSync(join(FIXTURES, "claude-code-body.json"), "utf8"));
// One fixture row serves both B1 and B3, so its last user message carries both prompts.
const lastUser = BODY.messages.findLast((message: { role: string }) => message.role === "user");
lastUser.content = [
  ...(typeof lastUser.content === "string" ? [{ type: "text", text: lastUser.content }] : lastUser.content),
  { type: "text", text: loadTask("B3-real-prompt").prompt },
];
const MAIN_USAGE = { input: 1000, cache_write: 200, cache_write_1h: 0, cache_read: 3000, output: 50 };
const SIDE_USAGE = { input: 10, cache_write: 0, cache_read: 0, output: 5 };

let root: string;
let home: string;
let worktree: string;
let logPath: string;
let previous: Record<string, string | undefined>;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function captureRow(partial: Partial<CaptureRow>): CaptureRow {
  return {
    t_ns: 1,
    host: "api.anthropic.com",
    path: "/v1/messages",
    pid: 1,
    process: "claude",
    model: "claude-opus-5-5",
    user_agent: "claude-cli/2.1.303",
    req_bytes: 1000,
    status: 200,
    usage: null,
    main_thread: null,
    user_text_sha256: [],
    chunk_t_ns: [],
    body_file: null,
    ...partial,
  };
}

interface Harness {
  ctx: TestContext;
  state: Map<string, unknown>;
  capture: CaptureControl;
  rows: ResultRow[];
}

function sessionLog(): string {
  const dir = join(home, ".claude", "projects", "-tmp-ademark-tracks-b");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  const content = readFileSync(join(FIXTURES, "claude-session.jsonl"), "utf8").replaceAll("/tmp/ademark-tracks-b", worktree);
  const asked = JSON.stringify({ type: "user", isSidechain: false, cwd: worktree, message: { role: "user", content: loadTask("B3-real-prompt").prompt } });
  writeFileSync(path, `${asked}\n${content}`);
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(path, future, future);
  return path;
}

function harness(agent: Agent, model: string | null, options: { emptyCapture?: boolean } = {}): Harness {
  const writer = new RunWriter(join(root, "results")).open("tracks-b");
  const state = new Map<string, unknown>();
  const adapter = makeFixtureAdapter({ id: "fixture-ade" });
  const captureDir = join(writer.runDir, "fixture-ade");
  mkdirSync(join(captureDir, "bodies"), { recursive: true });
  writeFileSync(join(captureDir, "bodies", "0001.json"), `${JSON.stringify(BODY, null, 2)}\n`);
  writeFileSync(join(captureDir, "bodies", "0002.json"), '{"model":"claude-opus-5-5"}\n');
  const capture: CaptureControl = {
    outPath: join(captureDir, "capture.jsonl"),
    rows: () => {
      if (options.emptyCapture === true) return [];
      const start = Number(state.get("B.window.start_ns") ?? 0);
      return [
        captureRow({
          t_ns: start + 1,
          usage: { ...MAIN_USAGE },
          user_text_sha256: [sha256(loadTask("B1-hello").prompt.trim()), sha256(loadTask("B3-real-prompt").prompt.trim())],
          body_file: "bodies/0001.json",
        }),
        captureRow({
          t_ns: start + 2,
          usage: { ...SIDE_USAGE },
          user_text_sha256: [sha256("Name this thread")],
          body_file: "bodies/0002.json",
        }),
      ];
    },
    stop: async () => {},
  };
  state.set("capture", capture);
  const runOptions: RunOptions = { agent, model, effort: agent === "own" ? null : "high", server: "live" };
  const ctx = createTestContext({
    runId: "tracks-b",
    runDir: writer.runDir,
    machineId: "test-machine",
    adapter,
    rowAde: "fixture-ade",
    track: "B",
    options: runOptions,
    instruments: dryInstruments(join(root, "plan.jsonl")),
    writer,
    adapterCtx: {
      runDir: writer.runDir,
      arenaPath: worktree,
      worktree,
      home,
      env: {},
      dryRun: true,
      log: () => {},
    },
    installed: { installed: true, version: "1.0.0", path: "/Applications/Fixture.app", binarySha256: "a".repeat(64) },
    freshArena: async () => worktree,
    state,
  });
  return { ctx, state, capture, rows: [] };
}

async function run(runner: { runRep(ctx: TestContext, rep: number): Promise<ResultRow[]> }, h: Harness, rep = 1): Promise<ResultRow[]> {
  const produced = await runner.runRep(h.ctx, rep);
  for (const row of produced) validateRow(row);
  h.rows.push(...produced);
  return produced;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-tracks-b-"));
  home = join(root, "home");
  worktree = join(root, "worktree");
  mkdirSync(home, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  previous = {
    ADEMARK_RESULTS: process.env.ADEMARK_RESULTS,
    ADEMARK_TASKS: process.env.ADEMARK_TASKS,
    ADEMARK_PRICES: process.env.ADEMARK_PRICES,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.ADEMARK_RESULTS = join(root, "results-root");
  process.env.ADEMARK_TASKS = TASKS;
  process.env.ADEMARK_PRICES = join(FIXTURES, "prices.json");
  delete process.env.ANTHROPIC_API_KEY;
  logPath = sessionLog();
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("Track B runners", () => {
  test("B1 writes six rows per repetition with the split and the price", async () => {
    const h = harness("claude", "claude-opus-5-5");
    const first = await run(b1HelloTax, h, 1);
    expect(first.map((row) => row.variant)).toEqual([
      "fresh-input",
      "cache-write",
      "cache-read",
      "output",
      "side-tokens",
      "usd",
    ]);
    expect(first.slice(0, 5).every((row) => row.unit === "tokens")).toBe(true);
    expect(first.every((row) => row.valid)).toBe(true);
    const value = (variant: string) => first.find((row) => row.variant === variant)!.value;
    expect(value("fresh-input")).toBe(1000);
    expect(value("cache-write")).toBe(200);
    expect(value("cache-read")).toBe(3000);
    expect(value("output")).toBe(50);
    expect(value("side-tokens")).toBe(15);
    expect(first[5]!.unit).toBe("USD");
    expect(value("usd")).toBeCloseTo(0.00674, 10);
    expect(first[0]!.receipts.capture).toBe("fixture-ade/capture.jsonl");
    expect(first[0]!.receipts.log).toBe("fixture-ade/B1/claude/rep-01/notes.md");
    expect(existsSync(join(h.ctx.runDir, first[0]!.receipts.log!))).toBe(true);
  });

  test("B1 runs three repetitions and stores each window in state", async () => {
    const h = harness("claude", "claude-opus-5-5");
    for (const rep of [1, 2, 3]) {
      expect(await run(b1HelloTax, h, rep)).toHaveLength(6);
    }
    expect(h.rows).toHaveLength(18);
    const reps = h.state.get("B1.claude.reps") as Array<{ rep: number }>;
    expect(reps.map((entry) => entry.rep)).toEqual([1, 2, 3]);
  });

  test("B3 adds the request count and the tool calls from the session log", async () => {
    const h = harness("claude", "claude-opus-5-5");
    await run(b1HelloTax, h, 1);
    const rows = await run(b3RealPromptTax, h, 1);
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.variant)).toContain("requests");
    expect(rows.map((row) => row.variant)).toContain("tool-calls");
    const value = (variant: string) => rows.find((row) => row.variant === variant)!.value;
    expect(value("requests")).toBe(1);
    expect(value("tool-calls")).toBe(1);
    expect(value("fresh-input")).toBe(1000);
    expect(rows.filter((row) => row.variant === "requests" || row.variant === "tool-calls").every((row) => row.unit === "count")).toBe(true);
  });

  test("B2 splits the first B1 body into five estimated segments", async () => {
    const h = harness("claude", "claude-opus-5-5");
    await run(b1HelloTax, h, 1);
    const rows = await run(b2RequestAnatomy, h, 1);
    expect(rows.map((row) => row.variant)).toEqual(["system", "tools", "mcp-tools", "injected", "params"]);
    expect(rows.every((row) => row.unit === "tokens" && row.valid)).toBe(true);

    const anatomy = anatomyOf(BODY, loadTask("B1-hello").prompt);
    for (const [index, segment] of anatomy.segments.entries()) {
      expect(rows[index]!.value).toBe(estimateTokens(segment.text));
    }
    const anatomyPath = join(h.ctx.runDir, "fixture-ade", "B2", "claude", "rep-01", "anatomy.json");
    expect(existsSync(anatomyPath)).toBe(true);
    const written = JSON.parse(readFileSync(anatomyPath, "utf8")) as {
      tool_names: string[];
      mcp_tool_names: string[];
      user_agent: string;
      method: string;
    };
    expect(written.tool_names).toEqual(["Read", "Bash"]);
    expect(written.mcp_tool_names).toEqual(["mcp__ledger__lookup"]);
    expect(written.user_agent).toBe("claude-cli/2.1.303");
    expect(written.method).toBe("estimate");
  });

  test("B2 without B1 capture writes one invalid row per segment", async () => {
    const h = harness("claude", "claude-opus-5-5");
    const rows = await run(b2RequestAnatomy, h, 1);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => !row.valid)).toBe(true);
    expect(rows.every((row) => row.invalid_reason === "no B1 capture")).toBe(true);
  });

  test("B4 finds the canary in the B1 body and reads obedience from the session log", async () => {
    const h = harness("claude", "claude-opus-5-5");
    await run(b1HelloTax, h, 1);
    const rows = await run(b4RepoRules, h, 1);
    expect(rows.map((row) => row.variant)).toEqual(["in-request", "obeyed"]);
    expect(rows.map((row) => row.value)).toEqual([1, 1]);
    expect(rows.every((row) => row.unit === "bool" && row.valid)).toBe(true);
    const canaryPath = join(h.ctx.runDir, "fixture-ade", "B4", "claude", "rep-01", "canary.json");
    expect(existsSync(canaryPath)).toBe(true);
    expect((JSON.parse(readFileSync(canaryPath, "utf8")) as { found: boolean }).found).toBe(true);
  });

  test("B4 obeyed is invalid, not a valid null, for an agent without a session log", async () => {
    const h = harness("own", null);
    await run(b1HelloTax, h, 1);
    const rows = await run(b4RepoRules, h, 1);
    expect(rows.find((row) => row.variant === "in-request")!.value).toBe(1);
    const obeyed = rows.find((row) => row.variant === "obeyed")!;
    expect(obeyed.value).toBeNull();
    expect(obeyed.valid).toBe(false);
    expect(obeyed.invalid_reason).toBe("no session log");
  });

  test("B4 without any captured body invalidates in-request and obeyed", async () => {
    const h = harness("claude", "claude-opus-5-5");
    const rows = await run(b4RepoRules, h, 1);
    const inRequest = rows.find((row) => row.variant === "in-request")!;
    expect(inRequest.valid).toBe(false);
    expect(inRequest.value).toBeNull();
    expect(inRequest.invalid_reason).toBe("no main-thread request captured");
    const obeyed = rows.find((row) => row.variant === "obeyed")!;
    expect(obeyed.valid).toBe(false);
    expect(obeyed.value).toBeNull();
    expect(obeyed.invalid_reason).toBe("no session log");
  });

  test("B4 reports in-request 0 only when a body exists without the canary", async () => {
    const h = harness("claude", "claude-opus-5-5");
    await run(b1HelloTax, h, 1);
    writeFileSync(join(h.ctx.runDir, "fixture-ade", "bodies", "0001.json"), '{"model":"claude-opus-5-5"}\n');
    const rows = await run(b4RepoRules, h, 1);
    expect(rows.find((row) => row.variant === "in-request")!.value).toBe(0);
    expect(rows.find((row) => row.variant === "in-request")!.valid).toBe(true);
    expect(rows.find((row) => row.variant === "obeyed")!.value).toBe(1);
  });

  test("B4 obeyed is invalid when one B1 rep has no session log", async () => {
    const h = harness("claude", "claude-opus-5-5");
    await run(b1HelloTax, h, 1);
    rmSync(logPath);
    await run(b1HelloTax, h, 2);
    const rows = await run(b4RepoRules, h, 1);
    expect(rows.find((row) => row.variant === "in-request")!.value).toBe(1);
    const obeyed = rows.find((row) => row.variant === "obeyed")!;
    expect(obeyed.valid).toBe(false);
    expect(obeyed.value).toBeNull();
    expect(obeyed.invalid_reason).toBe("no session log");
    expect(obeyed.notes).toContain("no session log (reps 2)");
  });

  test("B3 tool calls are invalid, not a valid null, without a session log", async () => {
    const h = harness("own", null);
    const rows = await run(b3RealPromptTax, h, 1);
    const tools = rows.find((row) => row.variant === "tool-calls")!;
    expect(tools.valid).toBe(false);
    expect(tools.value).toBeNull();
    expect(tools.invalid_reason).toBe("no session log");
    // The request count comes from the capture, so it stays measured.
    expect(rows.find((row) => row.variant === "requests")!.valid).toBe(true);
  });

  // 2026-11-07, MonoCode: every B1 rep ran claude-sonnet-5, yet B2 and B4 were valid from those same requests.
  test("B2 and B4 do not read evidence from B1 reps on another model", async () => {
    const h = harness("claude", "claude-sonnet-5-5");
    for (const rep of [1, 2, 3]) await run(b1HelloTax, h, rep);
    const b2 = await run(b2RequestAnatomy, h, 1);
    expect(b2.every((row) => !row.valid && row.invalid_reason === "no valid B1 repetition: wrong model: claude-opus-5-5")).toBe(true);
    const b4 = await run(b4RepoRules, h, 1);
    expect(b4.find((row) => row.variant === "in-request")!.invalid_reason).toBe("no valid B1 or B3 repetition: wrong model: claude-opus-5-5");
    expect(b4.find((row) => row.variant === "obeyed")!.invalid_reason).toBe("no valid B1 repetition: wrong model: claude-opus-5-5");
    expect(b4.every((row) => !row.valid && row.value === null)).toBe(true);
  });

  test("B2 takes the first B1 rep that passed its checks", async () => {
    const h = harness("claude", "claude-opus-5-5");
    await run(b1HelloTax, h, 1);
    await run(b1HelloTax, h, 2);
    const reps = h.state.get("B1.claude.reps") as RepCapture[];
    reps[0]!.wrongModel = "claude-sonnet-5";
    const rows = await run(b2RequestAnatomy, h, 1);
    expect(rows.every((row) => row.valid)).toBe(true);
    const notes = readFileSync(join(h.ctx.runDir, "fixture-ade", "B2", "claude", "rep-01", "notes.md"), "utf8");
    expect(notes).toContain("body: bodies/0001.json (B1 rep 2)");
  });

  test("an empty capture without a session log makes every B1 and B3 value invalid", async () => {
    const h = harness("own", null, { emptyCapture: true });
    const b1 = await run(b1HelloTax, h, 1);
    expect(b1).toHaveLength(6);
    expect(b1.every((row) => !row.valid && row.value === null)).toBe(true);
    expect(b1.every((row) => row.invalid_reason === "no main-thread request captured")).toBe(true);
    const reps = h.state.get("B1.own.reps") as RepCapture[];
    expect(reps[0]!.notes).toContain("no main-thread request captured");

    const b3 = await run(b3RealPromptTax, h, 1);
    expect(b3).toHaveLength(8);
    expect(b3.every((row) => !row.valid && row.value === null)).toBe(true);
    expect(b3.find((row) => row.variant === "requests")!.invalid_reason).toBe("no main-thread request captured");
    expect(b3.find((row) => row.variant === "tool-calls")!.invalid_reason).toBe("no main-thread request captured");
  });

  test("an empty capture with a session log takes the token values from the log", async () => {
    const h = harness("claude", "claude-opus-5-5", { emptyCapture: true });
    const b1 = await run(b1HelloTax, h, 1);
    expect(b1.every((row) => row.valid)).toBe(true);
    const value = (variant: string) => b1.find((row) => row.variant === variant)!.value;
    expect(value("fresh-input")).toBe(1000);
    expect(value("cache-write")).toBe(200);
    expect(value("cache-read")).toBe(3000);
    expect(value("output")).toBe(50);
    expect(value("side-tokens")).toBe(0);
    expect(value("usd")).toBeCloseTo(0.0066, 10);
    const reps = h.state.get("B1.claude.reps") as RepCapture[];
    expect(reps[0]!.notes).toContain("from session log, capture empty");

    const b3 = await run(b3RealPromptTax, h, 1);
    const requests = b3.find((row) => row.variant === "requests")!;
    expect(requests.valid).toBe(false);
    expect(requests.invalid_reason).toBe("no main-thread request captured");
    const toolCalls = b3.find((row) => row.variant === "tool-calls")!;
    expect(toolCalls.valid).toBe(true);
    expect(toolCalls.value).toBe(1);
  });

  test("a session log on another model cannot stand in for the capture", async () => {
    const h = harness("claude", "claude-sonnet-5-5", { emptyCapture: true });
    const rows = await run(b1HelloTax, h, 1);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "wrong model: claude-opus-5-5")).toBe(true);
  });

  test("a capture that disagrees with the session log makes the token rows invalid", async () => {
    const usage = { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 };
    const line = JSON.stringify({ type: "assistant", cwd: worktree, message: { id: "x", role: "assistant", model: "claude-opus-5-5", content: [], usage } });
    writeFileSync(logPath, `${readFileSync(logPath, "utf8").split("\n").filter((entry) => entry.includes('"user"')).join("\n")}\n${line}\n`);
    utimesSync(logPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const rows = await run(b1HelloTax, harness("claude", "claude-opus-5-5"), 1);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "capture and session log disagree")).toBe(true);
  });

  test("a prompt counts as gone once a model call starts, and a silent app is reported", async () => {
    const slept: number[] = [];
    const ctx = { instruments: { sleep: async (ms: number) => void slept.push(ms) } } as unknown as Pick<TestContext, "instruments">;
    const capture = (started: (ns: number) => boolean): CaptureControl => ({ outPath: "x", rows: () => [], requestsSince: (ns) => (started(ns) ? 1 : 0), stop: async () => {} });
    expect(await promptLeft(ctx, capture(() => true), 1)).toBe(true);
    expect(slept).toHaveLength(0);
    expect(await promptLeft(ctx, capture(() => slept.length >= 3), 1)).toBe(true);
    expect(await promptLeft(ctx, capture(() => false), 1)).toBe(false);
    expect(await promptLeft(ctx, { outPath: "x", rows: () => [], stop: async () => {} }, 1)).toBe(true);
    const telemetryOnly: CaptureControl = { ...capture(() => false), rows: () => [captureRow({ t_ns: 5, path: "/v1/messages" })] };
    expect(await promptLeft(ctx, telemetryOnly, 1)).toBe(true);
  });

  test("two requests that left with the same task make the repetition invalid, answered or not", async () => {
    const h = harness("claude", "claude-opus-5-5");
    const capture = h.ctx.state.get("capture") as CaptureControl;
    capture.startsSince = () => 2;
    const rows = await run(b1HelloTax, h, 1);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "the prompt ran twice")).toBe(true);
  });

  test("a repetition that cannot be trusted has no valid counts either", async () => {
    const rows = await run(b3RealPromptTax, harness("claude", "claude-sonnet-5-5"), 1);
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => !row.valid)).toBe(true);
  });

  test("a main thread at another effort makes the token rows invalid", () => {
    expect(repProblem({ failedTurn: false, wrongModel: null, wrongEffort: "medium", unresolvedThread: false, logMismatch: false, promptTwice: false } as RepCapture)).toBe("wrong effort: medium");
  });

  test("a main thread on another model makes the token rows invalid", async () => {
    const h = harness("claude", "claude-sonnet-5-5");
    const rows = await run(b1HelloTax, h, 1);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "wrong model: claude-opus-5-5")).toBe(true);
  });

  test("an incomplete capture without a session log makes the token rows invalid", () => {
    const h = harness("own", null);
    const capture: RepCapture = {
      rep: 1,
      window: { start_ns: 1, end_ns: 2, start_ms: 0 },
      main: [captureRow({ main_thread: true, usage: { ...MAIN_USAGE } })],
      side: [captureRow({ main_thread: false, usage: { ...SIDE_USAGE } })],
      firstMainRow: null,
      firstBodyFile: null,
      sessionIds: [],
      lastText: null,
      toolCalls: null,
      hasSessionLog: false,
      logUsage: null,
      logModel: null,
      incomplete: true,
      wrongModel: null,
      durationMs: 1,
      notes: ["capture incomplete"],
    };
    const receipts = { samples: null, video: null, frames: null, capture: null, log: null };
    const rows = tokenRowSet(h.ctx, "B1", 1, capture, readPrices(), receipts);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => !row.valid && row.value === null)).toBe(true);
    expect(rows.every((row) => row.invalid_reason === "capture incomplete")).toBe(true);
  });

  test("an incomplete capture takes its main components and price from the session log", () => {
    const h = harness("claude", "claude-opus-5-5");
    const capture: RepCapture = {
      rep: 1,
      window: { start_ns: 1, end_ns: 2, start_ms: 0 },
      main: [captureRow({ main_thread: true, usage: { ...MAIN_USAGE } })],
      side: [captureRow({ main_thread: false, usage: { ...SIDE_USAGE } })],
      firstMainRow: null,
      firstBodyFile: null,
      sessionIds: [],
      lastText: null,
      toolCalls: null,
      hasSessionLog: true,
      logUsage: { input: 40, cache_write: 5, cache_read: 10, output: 7 },
      logModel: "claude-opus-5-5",
      incomplete: true,
      wrongModel: null,
      durationMs: 1,
      notes: ["capture incomplete"],
    };
    expect(repComponents(capture, "claude")).toEqual({
      "fresh-input": 40,
      "cache-write": 5,
      "cache-read": 10,
      output: 7,
      "side-tokens": 15,
    });
  });
});
