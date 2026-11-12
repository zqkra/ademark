import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cutTurns,
  DEFAULT_UPSTREAM,
  planRecordings,
  postProcess,
  parseRecordAllArgs,
  realApiRefusal,
  recordStream,
  streamedChars,
  type AgentRunner,
} from "./record-all";
import { STREAM_CHARS } from "./build-sessions";
import { recordingPrompt } from "./recordings";
import { loadSessionFile, type SessionTurn } from "./session";

const tempDirs: string[] = [];
const servers: { stop: () => void }[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const server of servers) server.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function turn(index: number, blocks: SessionTurn["blocks"], stopReason = "end_turn"): SessionTurn {
  return { index, blocks, stop_reason: stopReason, usage: { input_tokens: 3, output_tokens: 4 } };
}

function rawSession(turns: SessionTurn[]): string {
  const header = {
    type: "session",
    name: "stream-1",
    api: "anthropic",
    match: "a long recording prompt",
    root: "/tmp/recorded-arena",
  };
  const lines = [header].concat(
    turns.map((entry) => ({
      type: "turn",
      index: entry.index,
      blocks: entry.blocks,
      stop_reason: entry.stop_reason,
      usage: entry.usage,
    })),
  );
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function anthropicSse(text: string): string {
  const frames: string[] = [];
  const push = (event: string, data: unknown): void => {
    frames.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  push("message_start", {
    type: "message_start",
    message: {
      id: "msg_up",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 41, output_tokens: 0 },
    },
  });
  push("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (let offset = 0; offset < text.length; offset += 1_000) {
    push("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(offset, offset + 1_000) },
    });
  }
  push("content_block_stop", { type: "content_block_stop", index: 0 });
  push("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 750 },
  });
  push("message_stop", { type: "message_stop" });
  return frames.join("");
}

describe("cutTurns", () => {
  test("keeps whole turns and cuts inside the text block that crosses the limit", () => {
    const turns = [
      turn(0, [
        { type: "text", text: "a".repeat(10) },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x/y.ts" } },
      ], "tool_use"),
      turn(1, [
        { type: "text", text: "b".repeat(30) },
        { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x/z.ts" } },
      ]),
      turn(2, [{ type: "text", text: "c".repeat(30) }]),
    ];
    const toolChars = JSON.stringify({ file_path: "/x/y.ts" }).length;
    const limit = 10 + toolChars + 15;
    const kept = cutTurns(turns, limit);
    expect(kept.length).toBe(2);
    expect(kept[0]?.blocks.length).toBe(2);
    expect(kept[1]?.blocks).toEqual([{ type: "text", text: "b".repeat(15) }]);
    expect(kept[1]?.stop_reason).toBe("end_turn");
    expect(kept[1]?.index).toBe(1);
    expect(kept.reduce((sum, entry) => sum + streamedChars(entry.blocks), 0)).toBe(limit);
  });

  test("a turn that fits exactly is kept whole and later turns are dropped", () => {
    const kept = cutTurns([turn(0, [{ type: "text", text: "abc" }]), turn(1, [{ type: "text", text: "de" }])], 3);
    expect(kept.length).toBe(1);
    expect(kept[0]?.blocks).toEqual([{ type: "text", text: "abc" }]);
  });

  test("a tool input that crosses the limit is dropped, not cut", () => {
    const input = JSON.stringify({ file_path: "/a/very/long/path/that/does/not/fit.ts" });
    const kept = cutTurns(
      [turn(0, [{ type: "text", text: "abc" }]), turn(1, [{ type: "tool_use", id: "t", name: "Read", input }])],
      10,
    );
    expect(kept.length).toBe(1);
    expect(kept[0]?.stop_reason).toBe("end_turn");
  });
});

describe("postProcess", () => {
  test("writes the stream header and exactly the limit in streamed characters", () => {
    const raw = rawSession([
      turn(0, [{ type: "text", text: "a".repeat(1_000) }]),
      turn(1, [{ type: "text", text: "b".repeat(1_000) }, { type: "text", text: "c".repeat(1_000) }]),
      turn(2, [{ type: "text", text: "d".repeat(1_000) }]),
    ]);
    const result = postProcess(raw, { stream: 2, root: "/tmp/live-arena", limit: 1_500 });
    expect(result.chars).toBe(1_500);
    expect(result.turns).toBe(2);
    const lines = result.content.trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({
      type: "session",
      name: "stream-2",
      api: "anthropic",
      match: "replay:stream-2",
      root: "/tmp/live-arena",
    });
    const second = JSON.parse(lines[2] as string);
    expect(second.index).toBe(1);
    expect(second.blocks).toEqual([{ type: "text", text: "b".repeat(500) }]);
    expect(second.stop_reason).toBe("end_turn");
    expect(result.content).not.toContain("stand_in");
  });

  test("refuses a recording with no turns", () => {
    expect(() => postProcess(rawSession([]), { stream: 1, root: "/tmp/x" })).toThrow(/no turns/);
  });
});

describe("recordStream against a fake Anthropic upstream", () => {
  test("copies the arena, records the turns and cuts to 57,600 characters", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        await request.text();
        return new Response(anthropicSse("u".repeat(30_000)), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    servers.push({ stop: () => upstream.stop(true) });

    const arena = tempDir("ademark-record-arena-");
    writeFileSync(join(arena, "paginate.ts"), "export const x = 1;\n");
    const workDir = tempDir("ademark-record-work-");
    const outDir = tempDir("ademark-record-out-");

    const match = recordingPrompt(1);
    const agent: AgentRunner = async ({ prompt, baseUrl }) => {
      expect(prompt).toBe(match);
      const messages: unknown[] = [{ role: "user", content: prompt }];
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1_000, stream: true, messages }),
        });
        expect(response.ok).toBe(true);
        await response.text();
        messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "done" }] });
      }
    };

    // An old recording sits in the target slot: only --force may replace it.
    const old = `${JSON.stringify({ type: "session", name: "stream-1", api: "anthropic", match: "replay:stream-1", root: "/tmp/old" })}\n`;
    writeFileSync(join(outDir, "stream-1.jsonl"), old);

    const result = await recordStream({
      stream: 1,
      upstream: `http://127.0.0.1:${upstream.port}`,
      outDir,
      arenaDir: arena,
      workDir,
      agent,
      force: true,
    });

    expect(result.chars).toBe(STREAM_CHARS);
    expect(result.turns).toBe(2);
    expect(result.root).toBe(join(workDir, "arena"));
    expect(readFileSync(join(result.root, "paginate.ts"), "utf8")).toBe("export const x = 1;\n");

    const written = loadSessionFile(join(outDir, "stream-1.jsonl"));
    expect(written.name).toBe("stream-1");
    expect(written.match).toBe("replay:stream-1");
    expect(written.root).toBe(join(workDir, "arena"));
    expect(written.api).toBe("anthropic");
    expect(written.pacing).toBe("fixed");
    expect(written.standIn).toBe(false);
    expect(written.turns.length).toBe(2);
    const streamed = written.turns.reduce((sum, entry) => sum + streamedChars(entry.blocks), 0);
    expect(streamed).toBe(STREAM_CHARS);
    expect(written.turns[1]?.blocks).toEqual([{ type: "text", text: "u".repeat(STREAM_CHARS - 30_000) }]);
    expect(written.turns[1]?.stop_reason).toBe("end_turn");
  }, 20_000);

  test("refuses to overwrite a recording without --force", async () => {
    const outDir = tempDir("ademark-record-guard-");
    writeFileSync(
      join(outDir, "stream-1.jsonl"),
      `${JSON.stringify({ type: "session", name: "stream-1", api: "anthropic", match: "replay:stream-1", root: "/tmp/old" })}\n`,
    );
    await expect(
      recordStream({ stream: 1, upstream: "http://127.0.0.1:1", outDir }),
    ).rejects.toThrow(/refusing to overwrite the recording/);
  });
});

describe("record-all plan", () => {
  const base = { only: null, dryRun: true, upstream: DEFAULT_UPSTREAM, outDir: "/tmp/out" };

  test("five plans by default, one with --only", () => {
    expect(planRecordings(base).map((plan) => plan.stream)).toEqual([1, 2, 3, 4, 5]);
    expect(planRecordings({ ...base, only: 3 }).map((plan) => plan.stream)).toEqual([3]);
    expect(planRecordings({ ...base, only: 3 })[0]?.prompt).toBe(recordingPrompt(3));
  });

  test("arguments", () => {
    expect(parseRecordAllArgs([])).toEqual({
      only: null,
      dryRun: false,
      upstream: DEFAULT_UPSTREAM,
      outDir: expect.stringContaining("sessions"),
      force: false,
    });
    expect(
      parseRecordAllArgs(["--only", "stream-4", "--dry-run", "--force", "--upstream", "http://127.0.0.1:1", "--out", "/tmp/x"]),
    ).toEqual({
      only: 4,
      dryRun: true,
      upstream: "http://127.0.0.1:1",
      outDir: "/tmp/x",
      force: true,
    });
    expect(() => parseRecordAllArgs(["--only", "stream-9"])).toThrow(/stream-1 to stream-5/);
    expect(() => parseRecordAllArgs(["--nope"])).toThrow(/unknown argument/);
  });

  test("the real API needs the ademark user and no dry run", () => {
    expect(realApiRefusal(base, "someone")).toBeNull();
    expect(realApiRefusal({ ...base, dryRun: false }, "ademark")).toBeNull();
    expect(realApiRefusal({ ...base, dryRun: false, upstream: "http://127.0.0.1:9" }, "someone")).toBeNull();
    expect(realApiRefusal({ ...base, dryRun: false }, "someone")).toContain("refusing");
  });
});
