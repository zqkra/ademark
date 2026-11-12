import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anthropicMessage,
  chunkText,
  expandAnthropicSteps,
  planAnthropicStream,
  streamAnthropic,
  type SseEvent,
} from "./anthropic";
import { bodySha256, normalizeBody } from "./normalize";
import { openAiResponse, planOpenAiStream, streamOpenAi } from "./openai";
import { parseAnthropicResponse, startRecorder } from "./record";
import { startReplayServer, type ReplayServerHandle } from "./server";
import {
  applyRootRewrite,
  assistantCount,
  currentWorktreePath,
  findSession,
  firstUserText,
  loadSessions,
  matchSession,
  selectTurn,
  userTextCandidates,
  type ReplaySession,
} from "./session";

const SESSIONS_DIR = join(import.meta.dir, "sessions");
const USER_TEXTS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "capture", "fixtures", "user-texts.json"), "utf8"),
) as { name: string; body: unknown; candidates: string[] }[];

const tempDirs: string[] = [];
const servers: { stop: () => void }[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSessionFile(dir: string, file: string, rows: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function track(handle: ReplayServerHandle | { stop: () => void }): void {
  servers.push(handle);
}

afterAll(() => {
  for (const server of servers) server.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface ParsedSse {
  event: string;
  data: any;
}

function parseSse(text: string): ParsedSse[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = (lines.find((line) => line.startsWith("event:")) ?? "event:").slice(6).trim();
      const dataLine = (lines.find((line) => line.startsWith("data:")) ?? "data:null").slice(5).trim();
      return { event, data: JSON.parse(dataLine) };
    });
}

function messagesBody(text: string, stream: boolean, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "claude-opus-5-5",
    max_tokens: 200,
    stream,
    messages: [{ role: "user", content: text }],
    ...extra,
  });
}

async function postAnthropic(port: number, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "ademark-replay" },
    body,
  });
}

async function readLog(path: string): Promise<any[]> {
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

function replaceText(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) return value.map((entry) => replaceText(entry, from, to));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, replaceText(entry, from, to)]),
    );
  }
  return value;
}

function waitForLines(path: string, count: number, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
        if (lines.length >= count) {
          resolve(lines);
          return;
        }
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${count} lines in ${path}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("normalize", () => {
  test("paths, uuids and timestamps are volatile", () => {
    const a = JSON.stringify({
      path: "/Users/alice/arena/src/paginate.ts",
      id: "550e8400-e29b-41d4-a716-446655440000",
      at: "2026-10-19T03:13:00.000Z",
      word: "keep",
    });
    const b = JSON.stringify({
      path: "/Users/bob/other/place.ts",
      id: "123e4567-e89b-12d3-a456-426614174000",
      at: "2025-01-02T04:05:06+02:00",
      word: "keep",
    });
    expect(bodySha256(a)).toBe(bodySha256(b));
    expect(bodySha256(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a changed word hashes different", () => {
    const a = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
    const b = JSON.stringify({ messages: [{ role: "user", content: "hey" }] });
    expect(bodySha256(a)).not.toBe(bodySha256(b));
  });

  test("dropped keys and sorted keys", () => {
    const noisy = JSON.stringify({
      metadata: { user_id: "u" },
      request_id: "r",
      session_id: "s",
      b: 2,
      a: 1,
      messages: [{ user_id: "u2", role: "user", content: "hi" }],
    });
    const clean = JSON.stringify({ a: 1, b: 2, messages: [{ role: "user", content: "hi" }] });
    expect(normalizeBody(noisy)).toBe(normalizeBody(clean));
  });

  test("private and tmp paths are volatile too", () => {
    expect(bodySha256(JSON.stringify({ p: "/private/var/folders/x.txt" }))).toBe(
      bodySha256(JSON.stringify({ p: "/tmp/y.txt" })),
    );
  });
});

describe("sessions", () => {
  const sessions = loadSessions(SESSIONS_DIR);

  test("loading and matching", () => {
    expect(sessions.map((session) => session.name).sort()).toEqual([
      "hi",
      "long-2000",
      "seed",
      "stream-1",
      "stream-2",
      "stream-3",
      "stream-4",
      "stream-5",
    ]);
    expect(findSession(sessions, " replay:hi \n")?.name).toBe("hi");
    expect(findSession(sessions, " replay:stream-1 ")?.name).toBe("stream-1");
    expect(findSession(sessions, "goodbye")).toBeNull();
  });

  test("first user message from string and block content", () => {
    expect(firstUserText({ messages: [{ role: "user", content: " hello " }] })).toBe("hello");
    expect(
      firstUserText({
        messages: [
          { role: "user", content: [{ type: "text", text: "ade" }, { type: "text", text: "mark" }] },
        ],
      }),
    ).toBe("ademark");
    expect(
      firstUserText({
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "oa demo" }],
          },
        ],
      }),
    ).toBe("oa demo");
  });

  test("turn selection 0, 1 and past the end", () => {
    const hi = sessions.find((session) => session.name === "hi") as ReplaySession;
    const stream = sessions.find((session) => session.name === "stream-1") as ReplaySession;

    const first = selectTurn(hi, 0);
    expect(first?.synthetic).toBe(false);
    expect(first?.turn.blocks[0]).toEqual({
      type: "text",
      text: "LEDGERMARK. Hi! How can I help you with Ledger?",
    });

    const streamFirst = selectTurn(stream, 0);
    expect(streamFirst?.turn.blocks.some((block) => block.type === "tool_use")).toBe(true);
    expect(streamFirst?.turn.stop_reason).toBe("tool_use");

    const streamSecond = selectTurn(stream, 1);
    expect(streamSecond?.turn.blocks.length).toBe(1);
    expect(streamSecond?.turn.blocks[0].type).toBe("text");

    const past = selectTurn(stream, 7);
    expect(past?.synthetic).toBe(true);
    expect(past?.turn.stop_reason).toBe("end_turn");
    expect(past?.turn.blocks.every((block) => block.type === "text")).toBe(true);
  });

  test("assistant count drives the turn index", () => {
    expect(assistantCount({ messages: [{ role: "user" }, { role: "assistant" }] })).toBe(1);
    expect(
      assistantCount({
        messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
      }),
    ).toBe(1);
    expect(
      assistantCount({
        input: [
          { type: "message", role: "user" },
          { type: "function_call" },
          { type: "function_call_output" },
        ],
      }),
    ).toBe(1);
    expect(
      assistantCount({
        input: [
          { type: "message", role: "user" },
          { type: "reasoning" },
          { type: "message", role: "assistant" },
          { type: "message", role: "user" },
        ],
      }),
    ).toBe(1);
    expect(
      assistantCount({
        input: [
          { type: "message", role: "user" },
          { type: "function_call" },
          { type: "function_call_output" },
          { type: "message", role: "assistant" },
          { type: "message", role: "user" },
        ],
      }),
    ).toBe(2);
  });

  test("user text candidates match the shared fixture", () => {
    expect(USER_TEXTS.length).toBe(3);
    for (const entry of USER_TEXTS) {
      expect(userTextCandidates(entry.body)).toEqual(entry.candidates);
    }
    // The fixture was written before the session keys moved to replay:hi.
    const openai = replaceText(USER_TEXTS[2].body, "hi", "replay:hi");
    expect(matchSession(sessions, openai)?.name).toBe("hi");
    expect(matchSession(sessions, { messages: [{ role: "user", content: "nothing" }] })).toBeNull();
  });
});

describe("path rewrite", () => {
  const sessions = loadSessions(SESSIONS_DIR);
  const stream = sessions.find((session) => session.name === "stream-1") as ReplaySession;

  test("current worktree path from every client shape", () => {
    expect(
      currentWorktreePath(
        {
          system: [
            { type: "text", text: "\n - Primary working directory: /private/tmp/wt\n - Is a git repository: false" },
          ],
        },
        "",
      ),
    ).toBe("/private/tmp/wt");
    expect(
      currentWorktreePath({ system: [{ type: "text", text: "CWD: /private/tmp/wt\nDate: 2026-10-19" }] }, ""),
    ).toBe("/private/tmp/wt");
    expect(
      currentWorktreePath(
        {
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "<environment_context>\n  <cwd>/Users/x/wt</cwd>\n</environment_context>" },
              ],
            },
          ],
        },
        "",
      ),
    ).toBe("/Users/x/wt");
    expect(currentWorktreePath({ cwd: "/tmp/cwd" }, "")).toBe("/tmp/cwd");
    expect(
      currentWorktreePath(
        { cwd: "/tmp/cwd", messages: [{ role: "user", content: "Working directory: /from-pattern" }] },
        "",
      ),
    ).toBe("/from-pattern");
    expect(currentWorktreePath({ messages: [] }, "/tmp/env")).toBe("/tmp/env");
    expect(currentWorktreePath({ messages: [] }, "")).toBeNull();
  });

  test("hit rewrites tool inputs deeply", () => {
    const blocks = selectTurn(stream, 0)?.turn.blocks ?? [];
    const body = { messages: [{ role: "user", content: "replay:stream-1" }], cwd: "/tmp/current" };
    const result = applyRootRewrite(stream, blocks, body, "");
    expect(result.miss).toBe(false);
    const tool = result.blocks.find((block) => block.type === "tool_use");
    expect(tool).toBeDefined();
    if (tool?.type === "tool_use") {
      expect(tool.input.file_path).toBe("/tmp/current/src/paginate.ts");
    }
  });

  test("miss leaves the input unchanged and is counted", () => {
    const blocks = selectTurn(stream, 0)?.turn.blocks ?? [];
    const result = applyRootRewrite(stream, blocks, { messages: [] }, "");
    expect(result.miss).toBe(true);
    expect(result.attempted).toBe(true);
    const tool = result.blocks.find((block) => block.type === "tool_use");
    if (tool?.type === "tool_use") {
      expect(tool.input.file_path).toBe("/private/tmp/ademark-recording/arena/src/paginate.ts");
    }
  });

  test("a turn without the root is never a miss", () => {
    const hi = sessions.find((session) => session.name === "hi") as ReplaySession;
    const blocks = selectTurn(hi, 0)?.turn.blocks ?? [];
    const result = applyRootRewrite(hi, blocks, {}, "");
    expect(result.attempted).toBe(false);
    expect(result.miss).toBe(false);
  });
});

describe("anthropic stream", () => {
  const sessions = loadSessions(SESSIONS_DIR);
  const hi = sessions.find((session) => session.name === "hi") as ReplaySession;
  const stream = sessions.find((session) => session.name === "stream-1") as ReplaySession;
  const hiTurn = selectTurn(hi, 0)!.turn;
  const context = { model: "claude-opus-5-5", inputTokens: 12 };

  test("16-character chunks", () => {
    expect(chunkText("abcdefghijklmnopq")).toEqual(["abcdefghijklmnop", "q"]);
    expect(chunkText("")).toEqual([]);
  });

  test("event order and field names", () => {
    const events = expandAnthropicSteps(planAnthropicStream(hiTurn, context));
    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const start = events[0].data as any;
    expect(start.type).toBe("message_start");
    expect(start.message.role).toBe("assistant");
    expect(start.message.model).toBe("claude-opus-5-5");
    expect(start.message.usage.input_tokens).toBe(12);
    const delta = events[2].data as any;
    expect(delta.delta.type).toBe("text_delta");
    expect(delta.delta.text.length).toBeLessThanOrEqual(16);
    const end = events[6].data as any;
    expect(end.delta.stop_reason).toBe("end_turn");
    expect(end.usage.output_tokens).toBe(14);

    const toolEvents = expandAnthropicSteps(planAnthropicStream(selectTurn(stream, 0)!.turn, context));
    const toolStart = toolEvents.find((event) => {
      const block = (event.data as any).content_block;
      return block?.type === "tool_use";
    });
    expect(toolStart?.event).toBe("content_block_start");
    const jsonDelta = toolEvents.find((event) => (event.data as any).delta?.type === "input_json_delta");
    expect(jsonDelta?.event).toBe("content_block_delta");
    const stops = toolEvents.filter((event) => event.event === "content_block_stop");
    expect(stops.map((event) => (event.data as any).index)).toEqual([0, 1]);
    expect((toolEvents.at(-2)?.data as any).delta.stop_reason).toBe("tool_use");
  });

  test("pacing: first chunk immediate, then at least 45 ms apart", async () => {
    const writes: { at: number; event: string; data: any }[] = [];
    const started = performance.now();
    await streamAnthropic(hiTurn, context, (payload) => {
      const [frame] = parseSse(payload);
      writes.push({ at: performance.now() - started, event: frame.event, data: frame.data });
    });
    const deltas = writes.filter((write) => write.event === "content_block_delta");
    expect(deltas.length).toBe(3);
    for (const delta of deltas) {
      expect((delta.data.delta.text as string).length).toBeGreaterThan(0);
      expect((delta.data.delta.text as string).length).toBeLessThanOrEqual(16);
    }
    expect(deltas[0].at).toBeLessThan(20);
    for (let index = 1; index < deltas.length; index += 1) {
      expect(deltas[index].at - deltas[index - 1].at).toBeGreaterThanOrEqual(45);
    }
    const fullText = deltas.map((delta) => delta.data.delta.text).join("");
    expect(fullText).toBe("LEDGERMARK. Hi! How can I help you with Ledger?");
  });

  test("non-streaming message shape", () => {
    const message = anthropicMessage(hiTurn, context) as any;
    expect(message.type).toBe("message");
    expect(message.role).toBe("assistant");
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content[0].text).toBe("LEDGERMARK. Hi! How can I help you with Ledger?");
    expect(message.usage.input_tokens).toBe(12);
    expect(message.usage.output_tokens).toBe(14);
  });
});

describe("openai stream", () => {
  const sessions = loadSessions(SESSIONS_DIR);
  const hi = sessions.find((session) => session.name === "hi") as ReplaySession;
  const hiTurn = selectTurn(hi, 0)!.turn;
  const context = { model: "gpt-6.1-sol", inputTokens: 5 };

  function names(steps: ReturnType<typeof planOpenAiStream>): string[] {
    const out: string[] = [];
    for (const step of steps) {
      if (step.kind === "event") out.push(step.sse.event);
      else for (let index = 0; index < step.chunks.length; index += 1) out.push(step.makeSse(step.chunks[index]).event);
    }
    return out;
  }

  test("event order", () => {
    const listed = names(planOpenAiStream(hiTurn, context));
    expect(listed).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const steps = planOpenAiStream(hiTurn, context);
    const completed = steps[steps.length - 1];
    if (completed.kind === "event") {
      const response = (completed.sse.data as any).response;
      expect(response.status).toBe("completed");
      expect(response.usage.input_tokens).toBe(5);
      expect(response.usage.output_tokens).toBe(14);
      expect(response.output[0].content[0].text).toBe("LEDGERMARK. Hi! How can I help you with Ledger?");
    }
  });

  test("tool_use becomes a function_call item", () => {
    const sessions2 = loadSessions(SESSIONS_DIR);
    const stream = sessions2.find((session) => session.name === "stream-1") as ReplaySession;
    const events: SseEvent[] = [];
    for (const step of planOpenAiStream(selectTurn(stream, 0)!.turn, context)) {
      if (step.kind === "event") events.push(step.sse);
      else for (const chunk of step.chunks) events.push(step.makeSse(chunk));
    }
    const added = events.find(
      (event) => event.event === "response.output_item.added" && (event.data as any).item.type === "function_call",
    );
    expect((added?.data as any).item.type).toBe("function_call");
    expect((added?.data as any).item.name).toBe("Read");
    const argDelta = events.find((event) => event.event === "response.function_call_arguments.delta");
    expect(argDelta).toBeDefined();
  });

  test("non-streaming response shape", () => {
    const response = openAiResponse(hiTurn, context) as any;
    expect(response.object).toBe("response");
    expect(response.status).toBe("completed");
    expect(response.output[0].type).toBe("message");
    expect(response.output[0].content[0].type).toBe("output_text");
    expect(response.output[0].content[0].text).toContain("LEDGERMARK");
    expect(response.usage.input_tokens).toBe(5);
  });

  test("pacing matches the anthropic pump", async () => {
    const writes: number[] = [];
    const started = performance.now();
    await streamOpenAi(hiTurn, context, (payload) => {
      const [frame] = parseSse(payload);
      if (frame.event === "response.output_text.delta") writes.push(performance.now() - started);
    });
    expect(writes.length).toBe(3);
    for (let index = 1; index < writes.length; index += 1) {
      expect(writes[index] - writes[index - 1]).toBeGreaterThanOrEqual(45);
    }
  });
});

describe("no pacing", () => {
  const longText = "x".repeat(3_000);
  const turn = {
    index: 0,
    blocks: [{ type: "text" as const, text: longText }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 750 },
  };

  test("both emitters write every chunk without waiting", async () => {
    const anthropicDeltas: string[] = [];
    const openaiDeltas: string[] = [];
    const started = performance.now();
    await streamAnthropic(turn, { model: "claude-opus-5-5", inputTokens: 5, pacing: "none" }, (payload) => {
      const [frame] = parseSse(payload);
      if (frame.event === "content_block_delta") anthropicDeltas.push(frame.data.delta.text);
    });
    await streamOpenAi(turn, { model: "gpt-6.1-sol", inputTokens: 5, pacing: "none" }, (payload) => {
      const [frame] = parseSse(payload);
      if (frame.event === "response.output_text.delta") openaiDeltas.push(frame.data.delta);
    });
    const elapsed = performance.now() - started;
    expect(anthropicDeltas.join("")).toBe(longText);
    expect(openaiDeltas.join("")).toBe(longText);
    expect(anthropicDeltas.length).toBe(Math.ceil(longText.length / 16));
    expect(elapsed).toBeLessThan(50);
  });

  test("the server honors pacing none over http in under 50 ms", async () => {
    const dir = tempDir("ademark-replay-none-");
    writeSessionFile(dir, "none.jsonl", [
      { type: "session", name: "none", api: "anthropic", match: "replay:none", root: "/rec", pacing: "none" },
      {
        type: "turn",
        index: 0,
        blocks: [{ type: "text", text: longText }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 750 },
      },
    ]);
    const handle = startReplayServer({ port: 0, sessionsDir: dir });
    track(handle);
    await fetch(`http://127.0.0.1:${handle.port}/_ademark/health`);

    const started = performance.now();
    const response = await postAnthropic(handle.port, messagesBody("replay:none", true));
    const text = await response.text();
    const elapsed = performance.now() - started;
    const full = parseSse(text)
      .filter((event) => event.event === "content_block_delta")
      .map((event) => event.data.delta.text)
      .join("");
    expect(full).toBe(longText);
    expect(elapsed).toBeLessThan(50);
    expect(handle.stats().by_session.none).toBe(1);
  });
});

describe("replay server", () => {
  test("anthropic non-streaming, count_tokens, unknown and the log", async () => {
    const logPath = join(tempDir("ademark-replay-log-"), "requests.jsonl");
    const handle = startReplayServer({ port: 0, sessionsDir: SESSIONS_DIR, logPath });
    track(handle);

    const known = await postAnthropic(handle.port, messagesBody("replay:hi", false));
    const message = (await known.json()) as any;
    expect(known.headers.get("content-type")).toContain("application/json");
    expect(message.content[0].text).toContain("LEDGERMARK");
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage.input_tokens).toBe(12);

    const countBody = messagesBody("replay:hi", false);
    const count = await fetch(`http://127.0.0.1:${handle.port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: countBody,
    });
    expect(((await count.json()) as any).input_tokens).toBe(Math.ceil(countBody.length / 4));

    const unknown = await postAnthropic(handle.port, messagesBody("goodbye", false));
    expect(((await unknown.json()) as any).content[0].text).toBe("ok");
    expect(handle.stats().unknown).toBe(1);

    const rows = await readLog(logPath);
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].session).toBe("hi");
    expect(rows[1].api).toBe("anthropic");
    expect(rows[2].session).toBeNull();
    expect(rows[0].bytes).toBe(countBody.length);
  });

  test("anthropic streaming with immediate first byte", async () => {
    const handle = startReplayServer({ port: 0, sessionsDir: SESSIONS_DIR });
    track(handle);
    await fetch(`http://127.0.0.1:${handle.port}/_ademark/health`);

    const started = performance.now();
    const response = await postAnthropic(handle.port, messagesBody("replay:hi", true));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstByteMs = performance.now() - started;
    expect(firstByteMs).toBeLessThan(20);

    let text = new TextDecoder().decode(first.value);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    const events = parseSse(text);
    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const full = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => event.data.delta.text)
      .join("");
    expect(full).toContain("LEDGERMARK");
  });

  test("claude code reminder blocks still match hi over http", async () => {
    const handle = startReplayServer({ port: 0, sessionsDir: SESSIONS_DIR });
    track(handle);
    const body = JSON.stringify({
      model: "claude-opus-5-5",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>codebase instructions</system-reminder>" },
            { type: "text", text: "<system-reminder>git status</system-reminder>" },
            { type: "text", text: "replay:hi" },
          ],
        },
      ],
    });
    const response = await postAnthropic(handle.port, body);
    const message = (await response.json()) as any;
    expect(message.content[0].text).toContain("LEDGERMARK");
    expect(handle.stats().by_session.hi).toBe(1);
  });

  test("normal claude code shape rewrites against the recorded root", async () => {
    const handle = startReplayServer({ port: 0, sessionsDir: SESSIONS_DIR });
    track(handle);
    const body = messagesBody("replay:stream-1", false, {
      system: [
        {
          type: "text",
          text: "\n - Primary working directory: /private/tmp/wt\n - Is a git repository: false",
        },
      ],
    });
    const response = await postAnthropic(handle.port, body);
    const message = (await response.json()) as any;
    const tool = message.content.find((block: any) => block.type === "tool_use");
    expect(tool.input.file_path).toBe("/private/tmp/wt/src/paginate.ts");
    expect(handle.stats().rewrite_misses).toBe(0);
  });

  test("openai codex style body matches hi", async () => {
    const handle = startReplayServer({ port: 0, sessionsDir: SESSIONS_DIR });
    track(handle);
    const body = JSON.stringify({
      model: "gpt-6.1-sol",
      stream: false,
      ...(replaceText(USER_TEXTS[2].body, "hi", "replay:hi") as Record<string, unknown>),
    });
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const message = (await response.json()) as any;
    expect(message.output[0].content[0].text).toContain("LEDGERMARK");
    expect(handle.stats().by_session.hi).toBe(1);
  });

  test("stats, reset and rewrite misses", async () => {
    const handle = startReplayServer({ port: 0, sessionsDir: SESSIONS_DIR });
    track(handle);

    await postAnthropic(handle.port, messagesBody("replay:hi", false));
    await postAnthropic(handle.port, messagesBody("replay:stream-1", false));
    await postAnthropic(handle.port, messagesBody("unknown", false));

    const stats = handle.stats();
    expect(stats.requests).toBe(3);
    expect(stats.by_session).toEqual({ hi: 1, "stream-1": 1 });
    expect(stats.unknown).toBe(1);
    expect(stats.rewrite_misses).toBe(1);

    const viaHttp = await fetch(`http://127.0.0.1:${handle.port}/_ademark/stats`);
    expect(await viaHttp.json()).toEqual(stats);

    await fetch(`http://127.0.0.1:${handle.port}/_ademark/reset`, { method: "POST" });
    expect(handle.stats()).toEqual({ requests: 0, by_session: {}, unknown: 0, rewrite_misses: 0 });
  });

  test("hit rewrites the tool input and past-the-end answers text only", async () => {
    const handle = startReplayServer({ port: 0, sessionsDir: SESSIONS_DIR });
    track(handle);

    const rewritten = await postAnthropic(
      handle.port,
      messagesBody("replay:stream-1", false, { cwd: "/tmp/live-worktree" }),
    );
    const message = (await rewritten.json()) as any;
    const tool = message.content.find((block: any) => block.type === "tool_use");
    expect(tool.input.file_path).toBe("/tmp/live-worktree/src/paginate.ts");
    expect(handle.stats().rewrite_misses).toBe(0);

    const past = await postAnthropic(
      handle.port,
      messagesBody("replay:stream-1", false, {
        messages: [
          { role: "user", content: "replay:stream-1" },
          { role: "assistant", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "again" },
        ],
        cwd: "/tmp/live-worktree",
      }),
    );
    const synthetic = (await past.json()) as any;
    expect(synthetic.content.every((block: any) => block.type === "text")).toBe(true);
    expect(synthetic.stop_reason).toBe("end_turn");
  });

  test("openai non-streaming and streaming on both paths", async () => {
    const dir = tempDir("ademark-replay-openai-");
    writeSessionFile(dir, "oa.jsonl", [
      { type: "session", name: "oa", api: "openai", match: "oa demo", root: "/rec" },
      {
        type: "turn",
        index: 0,
        blocks: [{ type: "text", text: "OA-REPLAY-ANSWER" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    ]);
    const handle = startReplayServer({ port: 0, sessionsDir: dir });
    track(handle);

    const body = JSON.stringify({
      model: "gpt-6.1-sol",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "oa demo" }] }],
    });
    const plain = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const response = (await plain.json()) as any;
    expect(response.status).toBe("completed");
    expect(response.output[0].content[0].text).toBe("OA-REPLAY-ANSWER");
    expect(response.usage.output_tokens).toBe(7);

    const streamed = await fetch(`http://127.0.0.1:${handle.port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(body), stream: true }),
    });
    const events = parseSse(await streamed.text());
    expect(events[0].event).toBe("response.created");
    expect(events.at(-1)?.event).toBe("response.completed");
    expect(events.some((event) => event.event === "response.output_text.delta")).toBe(true);
    expect(events.at(-1)?.data.response.output[0].content[0].text).toBe("OA-REPLAY-ANSWER");
  });
});

describe("recorder", () => {
  const canned = [
    "event: message_start",
    `data: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_up",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        usage: { input_tokens: 41, cache_read_input_tokens: 9, output_tokens: 0 },
      },
    })}`,
    "",
    "event: content_block_start",
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "REC" } })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ORD" } })}`,
    "",
    "event: content_block_stop",
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    "",
    "event: message_delta",
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
    "",
    "event: message_stop",
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
    "",
  ].join("\n");

  test("forwards bytes unchanged and assembles matching turns", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        await request.text();
        return new Response(canned, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push({ stop: () => upstream.stop(true) });

    const dir = tempDir("ademark-record-");
    const out = join(dir, "session.jsonl");
    const recorder = startRecorder({
      upstream: `http://127.0.0.1:${upstream.port}`,
      port: 0,
      name: "recorded",
      match: "record test",
      root: "/rec/root",
      out,
    });
    track(recorder);

    const body = JSON.stringify({
      model: "claude-opus-5-5",
      stream: true,
      messages: [{ role: "user", content: "record test" }],
    });
    const first = await fetch(`http://127.0.0.1:${recorder.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body,
    });
    const forwarded = await first.text();
    expect(forwarded).toBe(canned);

    await fetch(`http://127.0.0.1:${recorder.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        stream: true,
        messages: [
          { role: "user", content: "record test" },
          { role: "assistant", content: "RECORD" },
          { role: "user", content: "continue" },
        ],
      }),
    });

    await fetch(`http://127.0.0.1:${recorder.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        stream: true,
        messages: [{ role: "user", content: "not a match" }],
      }),
    });

    const lines = await waitForLines(out, 3);
    const header = JSON.parse(lines[0]);
    expect(header).toEqual({
      type: "session",
      name: "recorded",
      api: "anthropic",
      match: "record test",
      root: "/rec/root",
    });
    const turn0 = JSON.parse(lines[1]);
    expect(turn0).toEqual({
      type: "turn",
      index: 0,
      blocks: [{ type: "text", text: "RECORD" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 41, output_tokens: 2, cache_read_input_tokens: 9 },
    });
    const turn1 = JSON.parse(lines[2]);
    expect(turn1.index).toBe(1);
    expect(turn1.blocks[0].text).toBe("RECORD");
  });

  test("parses non-streaming anthropic json", () => {
    const assembled = parseAnthropicResponse(
      JSON.stringify({
        type: "message",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
      false,
    );
    expect(assembled?.blocks).toEqual([{ type: "text", text: "hello" }]);
    expect(assembled?.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
  });
});
