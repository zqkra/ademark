// The agents of a C1 run, read from its capture (bench/tracks/c/agents.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureRow } from "../core/contracts.ts";
import { AgentWatch, requestMeta } from "../tracks/c/agents.ts";

interface Saved {
  t_ns: number;
  status: number;
  path: string;
  model: string | null;
  body: unknown;
}
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "c-agents-2026-11.json"), "utf8")) as { captures: Record<string, Saved[]> };

function rowsOf(saved: readonly Saved[]): { rows: CaptureRow[]; watch: AgentWatch } {
  const rows = saved.map((entry, index): CaptureRow => ({
    t_ns: entry.t_ns,
    host: "api.anthropic.com",
    path: entry.path,
    pid: null,
    process: null,
    model: entry.model,
    user_agent: null,
    req_bytes: 0,
    status: entry.status,
    usage: null,
    main_thread: null,
    user_text_sha256: [],
    chunk_t_ns: [],
    body_file: String(index),
  }));
  return { rows, watch: new AgentWatch((row) => JSON.stringify(saved[Number(row.body_file)]!.body)) };
}

const body = (o: { session?: string; tools?: string[]; text: string; answer?: boolean; thread?: string }): unknown => ({
  metadata: o.session === undefined ? undefined : { user_id: JSON.stringify({ session_id: o.session }) },
  tools: (o.tools ?? ["Bash", "Edit"]).map((name) => ({ name })),
  ...(o.thread === undefined ? {} : { thread: { type: o.thread } }),
  messages: o.answer === true
    ? [{ role: "user", content: o.text }, { role: "assistant", content: "..." }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }]
    : [{ role: "user", content: o.text }],
});

describe("the agents of a run, from real requests", () => {
  // Each block of 6 and 7 Nov is one agent at work, with titles, quota calls and the threads of other prompts around it.
  for (const [name, saved] of Object.entries(FIXTURE.captures)) {
    test(`${name}: one agent`, () => {
      const { rows, watch } = rowsOf(saved);
      const seen = watch.read(rows, 0);
      expect(seen.agents).toBe(1);
      expect(seen.sessions).toBe(1);
      expect(seen.toolAnswers).toBeGreaterThan(0);
      expect(seen.lastWorkNs).not.toBeNull();
    });
  }

  test("MonoCode's title call carries the full tool list and is no agent: it never answers a tool", () => {
    const { rows, watch } = rowsOf(FIXTURE.captures["monocode 7 Nov"]!);
    const starts = rows.map((row) => watch.metaOf(row)).filter((meta) => meta?.root != null);
    // Eight threads start with coding tools (four prompts, four titles), and one session answers tools.
    expect(starts.length).toBe(8);
    expect(watch.read(rows, 0).agents).toBe(1);
  });

  test("the window limits what is read", () => {
    const { rows, watch } = rowsOf(FIXTURE.captures["bare-cli 7 Nov"]!);
    const last = watch.read(rows, 0).lastWorkNs!;
    expect(watch.read(rows, last + 1).toolAnswers).toBe(0);
    expect(watch.read(rows, 0, rows[0]!.t_ns).agents).toBe(0);
  });
});

describe("request meta", () => {
  test("a session id as JSON and in the older form", () => {
    expect(requestMeta(body({ session: "abc", text: "go" }))!.session).toBe("abc");
    const old = { ...(body({ text: "go" }) as object), metadata: { user_id: "user_1_account_2_session_01234567-89ab-cdef-0123-456789abcdef" } };
    expect(requestMeta(old)!.session).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(requestMeta(body({ text: "go" }))!.session).toBeNull();
    expect(requestMeta("not a body")).toBeNull();
  });

  test("a thread start with coding tools is a root; a continuation, a title, a suggestion and a summary are not", () => {
    expect(requestMeta(body({ text: "build it" }))!.root).not.toBeNull();
    expect(requestMeta(body({ text: "build it", thread: "continue" }))!.root).toBeNull();
    expect(requestMeta(body({ text: "build it", answer: true }))!.root).toBeNull();
    expect(requestMeta(body({ text: "Write a title", tools: ["StructuredOutput"] }))!.root).toBeNull();
    expect(requestMeta(body({ text: "[SUGGESTION MODE: next prompt]" }))!.root).toBeNull();
    expect(requestMeta(body({ text: "This session is being continued from a previous conversation that ran out of context." }))!.root).toBeNull();
    // The same first message is the same root; another one is another agent.
    expect(requestMeta(body({ text: "build it" }))!.root).toBe(requestMeta(body({ text: "build it" }))!.root);
    expect(requestMeta(body({ text: "build it" }))!.root).not.toBe(requestMeta(body({ text: "build the dates" }))!.root);
  });

  test("an answer to a tool is work, with or without a tool list", () => {
    expect(requestMeta(body({ text: "x", answer: true }))!.answersTool).toBe(true);
    expect(requestMeta(body({ text: "x", answer: true, tools: [] }))!.answersTool).toBe(true);
    expect(requestMeta(body({ text: "x" }))!.answersTool).toBe(false);
  });
});

describe("a capture read while it is written", () => {
  test("a last line with no newline yet is left for the next read; any other bad line is an error", async () => {
    const { parseCaptureRows } = await import("../run/real.ts");
    const row = JSON.stringify({ t_ns: 1, path: "/v1/messages", status: 200 });
    expect(parseCaptureRows(`${row}\n${row}\n`).length).toBe(2);
    expect(parseCaptureRows(`${row}\n${row.slice(0, 20)}`).length).toBe(1);
    expect(parseCaptureRows("").length).toBe(0);
    expect(() => parseCaptureRows(`${row.slice(0, 20)}\n${row}\n`)).toThrow();
  });
});
