import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapturedUsage, CaptureRow } from "../core/contracts";
import { userTextCandidates } from "../replay/session";
import { diffSnapshots, parseNettopCsv, reconcile } from "./nettop";
import { classifyMainThread, freshInput, isCompletion, lacksUsage, priceRows, priceUsd, splitComponents, splitUsage, threadShape, type PriceFile, type ThreadShape } from "./tokens";

function usage(partial: Partial<CapturedUsage> = {}): CapturedUsage {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0, ...partial };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function row(partial: Partial<CaptureRow> = {}): CaptureRow {
  return {
    t_ns: 1,
    host: "api.anthropic.com",
    path: "/v1/messages",
    pid: 1,
    process: "claude",
    model: "claude-opus-5-5",
    user_agent: "Claude-Code/1.0",
    req_bytes: 10,
    status: 200,
    usage: null,
    main_thread: null,
    user_text_sha256: [],
    chunk_t_ns: [],
    body_file: null,
    ...partial,
  };
}

const PRICES: PriceFile = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "prices", "2026-10.json"), "utf8"),
);

describe("splitUsage", () => {
  test("only completions spend tokens", () => {
    expect(isCompletion({ path: "/v1/messages?beta=true" })).toBe(true);
    expect(isCompletion({ path: "/v1/messages/count_tokens?beta=true" })).toBe(false);
    expect(isCompletion({ path: "/backend-api/codex/responses" })).toBe(true);
    expect(isCompletion({ path: "/backend-api/codex/models" })).toBe(false);
    expect(lacksUsage({ usage: null, status: 200 })).toBe(true);
    expect(lacksUsage({ usage: null, status: 401 })).toBe(false);
  });

  const shape = (over: Partial<ThreadShape>): ThreadShape => ({
    taskHashes: [],
    taskText: "",
    startsTurn: false,
    userTurn: false,
    tools: 0,
    continuation: false,
    previousMessage: null,
    previousRequest: null,
    ...over,
  });
  const classifyWith = (prompt: string, entries: [string, ThreadShape, Partial<CaptureRow>?][]): CaptureRow[] => {
    const shapes = new Map(entries.map(([id, value]) => [id, value]));
    const rows = entries.map(([id, , over], index) => row({ t_ns: index + 1, request_id: id, ...over }));
    return classifyMainThread(rows, prompt, (entry) => shapes.get(entry.request_id!) ?? null);
  };
  const mainOf = (rows: CaptureRow[]): (boolean | null)[] => rows.map((entry) => entry.main_thread);

  test("finds a prompt the app wrapped, and leaves a title call with the same text out", () => {
    const prompt = "explain the code";
    const wrapped = `<system_instruction>be kind</system_instruction> ${prompt}`;
    const rows = classifyWith(prompt, [
      ["title", shape({ taskText: `<session> ${wrapped}` })],
      ["sdk-title", shape({ taskText: `Write a title: ${wrapped}`, userTurn: true, tools: 3 })],
      ["main", shape({ taskText: wrapped, userTurn: true, tools: 14 })],
      ["next", shape({ continuation: true, previousRequest: "main" })],
    ]);
    expect(mainOf(rows)).toEqual([false, false, true, true]);
  });

  test("every tool answer of a wrapped task stays on the main thread", () => {
    const prompt = "explain the code";
    const wrapped = `<rules>be kind</rules> ${prompt}`;
    const rows = classifyWith(prompt, [
      ["first", shape({ taskText: wrapped, userTurn: true, tools: 9 })],
      ["next", shape({ taskText: wrapped, userTurn: true, tools: 9 })],
      ["title", shape({ taskText: wrapped, userTurn: true, tools: 0 })],
    ]);
    expect(mainOf(rows)).toEqual([true, true, false]);
  });

  test("a call that only quotes the prompt stays out when another has it alone", () => {
    const prompt = "explain the code";
    const rows = classifyWith(prompt, [
      ["main", shape({ taskHashes: [sha256(prompt)], taskText: prompt, userTurn: true, tools: 13 })],
      ["title", shape({ taskHashes: [sha256(`Write a title: ${prompt}`)], taskText: `Write a title: ${prompt}`, userTurn: true, tools: 13 })],
    ]);
    expect(mainOf(rows)).toEqual([true, false]);
  });

  test("a prompt that ran twice has two starts, and its tool answers add none", () => {
    const prompt = "explain the code";
    const start = shape({ taskHashes: [sha256(prompt)], startsTurn: true });
    const answer = shape({ taskHashes: [sha256(prompt)] });
    const starts = (rows: CaptureRow[]): number => rows.filter((entry) => entry.starts_turn === true).length;
    expect(starts(classifyWith(prompt, [["a", start], ["b", answer]]))).toBe(1);
    expect(starts(classifyWith(prompt, [["a", start], ["b", start]]))).toBe(2);
    expect(starts(classifyWith(prompt, [["a", start, { status: 529 }], ["b", start]]))).toBe(1);
  });

  test("a new prompt on a continued thread is the main thread", () => {
    const prompt = "explain the code";
    const rows = classifyWith(prompt, [["a", shape({ taskHashes: [sha256(prompt)], continuation: true, previousRequest: "old" })]]);
    expect(mainOf(rows)).toEqual([true]);
    expect(rows[0]!.thread_unresolved).toBeUndefined();
  });

  test("a chain follows the answer id first, so a subagent's continuation stays out", () => {
    const prompt = "explain the code";
    const rows = classifyWith(prompt, [
      ["first", shape({ taskHashes: [sha256(prompt)] }), { message_id: "msg_main" }],
      ["agent", shape({ taskHashes: [sha256("find files")] }), { message_id: "msg_agent" }],
      ["agent-next", shape({ continuation: true, previousMessage: "msg_agent", previousRequest: "first" }), { message_id: "msg_agent2" }],
      ["next", shape({ continuation: true, previousMessage: "msg_main" }), { message_id: "msg_main2" }],
    ]);
    expect(mainOf(rows)).toEqual([true, false, false, true]);
  });

  test("a continuation with no known parent is unresolved, never guessed", () => {
    const prompt = "explain the code";
    const rows = classifyWith(prompt, [
      ["first", shape({ taskHashes: [sha256(prompt)] })],
      ["lost", shape({ continuation: true, previousMessage: "msg_gone" })],
    ]);
    expect(mainOf(rows)).toEqual([true, false]);
    expect(rows[1]!.thread_unresolved).toBe(true);
  });

  test("a fork with the prompt in its history and a task of its own is a side call", () => {
    const prompt = "explain the code";
    const task = threadShape({
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "ok" },
        { role: "user", content: "find every file" },
        { role: "user", content: [{ type: "tool_result", content: "a.ts" }] },
      ],
    })!;
    expect(mainOf(classifyWith(prompt, [["fork", task, { user_text_sha256: [sha256(prompt)] }]]))).toEqual([false]);
    const own = threadShape({
      messages: [{ role: "user", content: prompt }, { role: "user", content: [{ type: "tool_result", content: "a.ts" }] }],
    })!;
    expect(mainOf(classifyWith(prompt, [["main", own]]))).toEqual([true]);
  });

  test("reads the shape of a request body", () => {
    const body = threadShape({
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_prev_req=req_01abc; cc_turn_origin=sdk" }],
      thread: { type: "continue", previous_message_id: "msg_1" },
      messages: [{ role: "user", content: [{ type: "tool_result", content: "ok" }] }],
    });
    expect(body).toEqual({ taskHashes: [], taskText: "", startsTurn: false, userTurn: true, tools: 0, continuation: true, previousMessage: "msg_1", previousRequest: "req_01abc" });
    const openai = threadShape({ input: [{ role: "user", content: "hi" }, { type: "function_call_output", output: "ok" }] });
    expect(openai?.taskHashes).toEqual([sha256("hi")]);
  });

  test("a cache write is priced by its TTL, and an unknown TTL has no price", () => {
    const models = { m: { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 } };
    const file: PriceFile = { date: "d", currency: "USD", unit: "per_million_tokens", models };
    expect(priceUsd(usage({ cache_write: 10_000, cache_write_1h: 10_000 }), "m", file)).toBeCloseTo(0.08);
    expect(priceUsd(usage({ cache_write: 10_000, cache_write_1h: 0 }), "m", file)).toBeCloseTo(0.05);
    expect(priceUsd(usage({ cache_write: 10_000 }), "m", file)).toBeNull();
  });

  test("the long-context rate applies per request above its threshold", () => {
    const rates = { input: 0.5, output: 2.5, cache_read: 0.05, cache_write_5m: 0.625, cache_write_1h: 1 };
    const models = { m: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2, long_context: { above: 100_000, ...rates } } };
    const file: PriceFile = { date: "d", currency: "USD", unit: "per_million_tokens", models };
    expect(priceUsd(usage({ input: 100_001, output: 100 }), "m", file)).toBeCloseTo(0.0502505, 6);
    expect(priceUsd(usage({ input: 100_000, output: 100 }), "m", file)).toBeCloseTo(0.01005, 6);
  });

  test("separates the main thread from side calls", () => {
    const rows = [
      row({ main_thread: true, usage: usage({ input: 100, cache_write: 10, cache_read: 20, output: 30 }) }),
      row({ main_thread: false, usage: usage({ input: 1, output: 2 }) }),
      row({ main_thread: null, usage: usage({ input: 3, output: 4 }) }),
      row({ main_thread: false, usage: null }),
    ];
    const split = splitUsage(rows);
    expect(split.main).toEqual({ input: 100, cache_write: 10, cache_read: 20, output: 30, calls: 1 });
    expect(split.side).toEqual({ input: 4, cache_write: 0, cache_read: 0, output: 6, calls: 3 });
  });

  test("empty input is zero", () => {
    expect(splitUsage([])).toEqual({
      main: { input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0 },
      side: { input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0 },
    });
  });
});

describe("classifyMainThread", () => {
  test("matches the prompt hash from the candidate list", () => {
    const rows = [
      row({ main_thread: null, user_text_sha256: [sha256("other"), sha256("fix the bug")] }),
      row({ main_thread: null, user_text_sha256: [sha256("name this thread")] }),
      row({ main_thread: true, user_text_sha256: [] }),
      row({ main_thread: false, user_text_sha256: [] }),
    ];
    const classified = classifyMainThread(rows, "  fix the bug  ");
    expect(classified.map((entry) => entry.main_thread)).toEqual([true, false, true, false]);
  });

  test("a Claude Code body with a reminder block before the prompt", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>\nCodebase instructions\n</system-reminder>" },
            { type: "text", text: "fix the bug" },
          ],
        },
      ],
    };
    const hashes = userTextCandidates(body).map(sha256);
    const classified = classifyMainThread([row({ main_thread: null, user_text_sha256: hashes })], "fix the bug");
    expect(classified[0].main_thread).toBe(true);
  });

  test("a null row without the prompt hash stays a side call", () => {
    const classified = classifyMainThread([row({ main_thread: null, user_text_sha256: [sha256("other")] })], "fix the bug");
    expect(classified[0].main_thread).toBe(false);
  });
});

describe("priceUsd", () => {
  test("prices a known model", () => {
    expect(priceUsd(usage({ input: 1000, output: 500 }), "claude-opus-5-5", PRICES)).toBeCloseTo(0.014, 10);
    expect(priceUsd(usage({ cache_read: 1000 }), "claude-opus-5-5", PRICES)).toBeCloseTo(0.0002, 10);
  });

  test("returns null when a needed price is null", () => {
    expect(priceUsd(usage({ input: 100 }), "gpt-6.1-sol", PRICES)).toBeNull();
    expect(priceUsd(usage({ cache_write: 100 }), "gpt-6.1-sol", PRICES)).toBeNull();
    expect(priceUsd(usage({ input: 100 }), "unknown-model", PRICES)).toBeNull();
  });

  test("zero tokens never need a price", () => {
    expect(priceUsd(usage(), "gpt-6.1-sol", PRICES)).toBe(0);
  });
});

describe("fresh input by host", () => {
  test("Anthropic keeps input_tokens and OpenAI subtracts the cached part", () => {
    const tokens = usage({ input: 1000, cache_read: 400 });
    expect(freshInput(tokens, "api.anthropic.com")).toBe(1000);
    expect(freshInput(tokens, "api.openai.com")).toBe(600);
    expect(freshInput(tokens, "chatgpt.com")).toBe(600);
    expect(freshInput(usage({ input: 10, cache_read: 99 }), "api.openai.com")).toBe(0);
  });
});

describe("splitComponents", () => {
  test("applies the fresh split to each row", () => {
    const rows = [
      row({ host: "api.anthropic.com", main_thread: true, usage: usage({ input: 100, cache_read: 20 }) }),
      row({ host: "api.openai.com", main_thread: true, usage: usage({ input: 100, cache_read: 40, output: 5 }) }),
      row({ host: "chatgpt.com", main_thread: false, usage: usage({ input: 10, cache_read: 4, output: 1 }) }),
    ];
    expect(splitComponents(rows)).toEqual({
      main: { input: 160, cache_write: 0, cache_read: 60, output: 5, calls: 2 },
      side: { input: 6, cache_write: 0, cache_read: 4, output: 1, calls: 1 },
    });
  });
});

describe("priceRows", () => {
  test("prices each request with its own model", () => {
    const rows = [
      row({ model: "claude-opus-5-5", main_thread: true, usage: usage({ input: 1000, output: 500 }) }),
      row({ model: "claude-opus-5-5", main_thread: false, usage: usage({ input: 1000, output: 500 }) }),
    ];
    const priced = priceRows(rows, PRICES);
    expect(priced.usd).toBeCloseTo(0.028, 10);
    expect(priced.missingModel).toBeNull();
  });

  test("a null price makes the total null and names the model", () => {
    const priced = priceRows([row({ model: "gpt-6.1-sol", usage: usage({ input: 100 }) })], PRICES);
    expect(priced).toEqual({ usd: null, missingModel: "gpt-6.1-sol" });
  });

  test("a row without usage is not priced", () => {
    expect(priceRows([row({ model: "gpt-6.1-sol", usage: null })], PRICES)).toEqual({ usd: 0, missingModel: null });
  });
});

describe("nettop", () => {
  const inline = [
    ",bytes_in,bytes_out,",
    "apsd.139,5843204,1850078,",
    "T3 Code (Beta) .699,133501486,72379897,",
    "broken,1,",
    "node.95352,3906,268611,",
  ].join("\n");

  test("parses process.pid rows and skips the header", () => {
    const rows = parseNettopCsv(inline);
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ process: "apsd", pid: 139, bytes_in: 5843204, bytes_out: 1850078 });
    expect(rows[1].process).toBe("T3 Code (Beta) ");
    expect(rows[1].pid).toBe(699);
  });

  test("parses the real fixture", () => {
    const rows = parseNettopCsv(readFileSync(join(import.meta.dir, "fixtures", "nettop.csv"), "utf8"));
    expect(rows.length).toBeGreaterThan(10);
    for (const entry of rows) {
      expect(Number.isInteger(entry.pid)).toBe(true);
      expect(entry.bytes_in).toBeGreaterThanOrEqual(0);
      expect(entry.bytes_out).toBeGreaterThanOrEqual(0);
    }
  });

  test("diffSnapshots subtracts the first snapshot", () => {
    const before = [
      { process: "claude", pid: 1, bytes_in: 100, bytes_out: 200 },
      { process: "node", pid: 2, bytes_in: 10, bytes_out: 20 },
    ];
    const after = [
      { process: "claude", pid: 1, bytes_in: 150, bytes_out: 260 },
      { process: "node", pid: 3, bytes_in: 5, bytes_out: 6 },
    ];
    expect(diffSnapshots(before, after)).toEqual([
      { process: "claude", pid: 1, bytes_in: 50, bytes_out: 60 },
      { process: "node", pid: 3, bytes_in: 5, bytes_out: 6 },
    ]);
  });

  test("reconcile uses a 5% band", () => {
    expect(reconcile(1000, 1000)).toEqual({ ratio: 1, within5pct: true });
    expect(reconcile(1000, 1049).within5pct).toBe(true);
    expect(reconcile(1000, 1060).within5pct).toBe(false);
    expect(reconcile(0, 0)).toEqual({ ratio: 1, within5pct: true });
    expect(reconcile(0, 10).within5pct).toBe(false);
  });
});
