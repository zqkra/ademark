import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessions,
  SESSIONS_DIR,
  SESSION_ROOT,
  staleSessions,
  STREAM_CHARS,
  STREAM_FILES,
  writeSessions,
} from "./build-sessions";
import { firstParagraph, recordings, workItem, withoutHandoff } from "./recordings";
import { loadSessions, type ReplaySession, type SessionTurn, type TextBlock } from "./session";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function textOf(session: ReplaySession, turnIndex: number): string {
  const turn = session.turns[turnIndex];
  if (!turn) return "";
  return turn.blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

describe("build-sessions", () => {
  const sessions = loadSessions(SESSIONS_DIR);
  const byName = new Map(sessions.map((session) => [session.name, session]));

  test("the build is deterministic and the files on disk are current", () => {
    const first = buildSessions();
    const second = buildSessions();
    expect(first.map((file) => file.file)).toEqual([
      "hi.jsonl",
      "seed.jsonl",
      "long-2000.jsonl",
      "stream-1.jsonl",
      "stream-2.jsonl",
      "stream-3.jsonl",
      "stream-4.jsonl",
      "stream-5.jsonl",
    ]);
    for (let index = 0; index < first.length; index += 1) {
      expect((second[index] as { content: string }).content).toBe((first[index] as { content: string }).content);
    }
    expect(staleSessions(SESSIONS_DIR)).toEqual([]);
    const written = Bun.spawnSync([process.execPath, join(import.meta.dir, "build-sessions.ts"), "--check"], {
      cwd: join(import.meta.dir, "..", ".."),
    });
    expect(written.exitCode).toBe(0);
  });

  test("--check names the file that differs", () => {
    const dir = tempDir("ademark-sessions-");
    writeSessions(dir);
    expect(staleSessions(dir)).toEqual([]);
    writeFileSync(join(dir, "hi.jsonl"), `${readFileSync(join(dir, "hi.jsonl"), "utf8")} `);
    expect(staleSessions(dir)).toEqual(["hi.jsonl"]);
  });

  test("a recording in a stream slot survives a rebuild and is left out of --check", () => {
    const dir = tempDir("ademark-sessions-recording-");
    writeSessions(dir);
    const recorded = `${JSON.stringify({ type: "session", name: "stream-2", api: "anthropic", match: "replay:stream-2", root: "/private/tmp/ademark-recording/arena" })}\n${JSON.stringify({ type: "turn", index: 0, blocks: [{ type: "text", text: "REAL RECORDING" }], stop_reason: "end_turn", usage: {} })}\n`;
    writeFileSync(join(dir, "stream-2.jsonl"), recorded);

    const result = writeSessions(dir);
    expect(result.kept).toEqual(["stream-2.jsonl"]);
    expect(readFileSync(join(dir, "stream-2.jsonl"), "utf8")).toBe(recorded);
    expect(staleSessions(dir)).toEqual([]);
  });

  test("an edited stand-in in a stream slot is still reported stale", () => {
    const dir = tempDir("ademark-sessions-standin-");
    writeSessions(dir);
    writeFileSync(join(dir, "stream-2.jsonl"), `${readFileSync(join(dir, "stream-2.jsonl"), "utf8")} `);
    expect(staleSessions(dir)).toEqual(["stream-2.jsonl"]);
  });

  test("the fixed files are always managed, stand-in header or not", () => {
    const dir = tempDir("ademark-sessions-fixed-");
    writeSessions(dir);
    writeFileSync(join(dir, "hi.jsonl"), `${JSON.stringify({ type: "session", name: "hi" })}\n`);
    expect(staleSessions(dir)).toEqual(["hi.jsonl"]);
  });

  test("hi is the A4 first-word session", () => {
    const hi = byName.get("hi") as ReplaySession;
    expect(hi.match).toBe("replay:hi");
    expect(hi.root).toBe(SESSION_ROOT);
    expect(hi.turns.length).toBe(1);
    expect(textOf(hi, 0)).toBe("LEDGERMARK. Hi! How can I help you with Ledger?");
    expect(hi.pacing).toBe("fixed");
    expect(hi.standIn).toBe(false);
  });

  test("seed is one short answer with no tool call", () => {
    const seed = byName.get("seed") as ReplaySession;
    expect(seed.match).toBe("replay:seed");
    expect(seed.turns.length).toBe(1);
    expect(seed.turns[0]?.blocks.some((block) => block.type === "tool_use")).toBe(false);
    expect(textOf(seed, 0).length).toBeLessThan(120);
  });

  test("long-2000 is 1,001 turns of visible steps, 200 of them with code, and ends with LONGTHREAD-END", () => {
    const long = byName.get("long-2000") as ReplaySession;
    expect(long.match).toBe("replay:long-2000");
    expect(long.pacing).toBe("none");
    expect(long.turns.length).toBe(1_001);

    const steps: string[] = [];
    let fenced = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const current = long.turns[index] as SessionTurn;
      expect(current.blocks.length).toBe(2);
      const text = current.blocks[0] as TextBlock;
      expect(text.type).toBe("text");
      expect(text.text.startsWith(`Step ${index + 1} of 1000. `)).toBe(true);
      expect(current.blocks[1]).toEqual({
        type: "tool_use",
        id: `toolu_long_${String(index + 1).padStart(4, "0")}`,
        name: "Read",
        input: { file_path: `${SESSION_ROOT}/src/invoices.ts` },
      });
      expect(current.stop_reason).toBe("tool_use");
      expect(current.usage.input_tokens).toBe(1_800 + index * 12);
      expect(current.usage.output_tokens).toBe(Math.ceil(text.text.length / 4));
      steps.push(text.text);
      if (text.text.includes("```ts")) {
        fenced += 1;
        const body = text.text.split("```ts\n")[1]?.split("\n```")[0] ?? "";
        const lines = body.split("\n").length;
        expect(lines).toBeGreaterThanOrEqual(6);
        expect(lines).toBeLessThanOrEqual(10);
      }
    }
    expect(fenced).toBe(200);

    // A11 watches for the LONGTHREAD-END tail and for the Seeded marker "unchanged": the steps
    // must hold neither, or a scroll or a thread switch would settle on the wrong text.
    const visible = steps.join("\n");
    expect(visible).not.toContain("THREAD-END");
    expect(visible).not.toContain("unchanged");

    expect(long.turns[1000]?.stop_reason).toBe("end_turn");
    expect(textOf(long, 1000)).toContain("LONGTHREAD-END");
  });

  test("each stream stand-in is a read plus a long diffed answer", () => {
    const answers = new Set<string>();
    for (const stream of [1, 2, 3, 4, 5]) {
      const session = byName.get(`stream-${stream}`) as ReplaySession;
      const file = STREAM_FILES[stream] as string;
      expect(session.match).toBe(`replay:stream-${stream}`);
      expect(session.standIn).toBe(true);
      expect(session.turns.length).toBe(2);
      expect(session.turns[0]?.stop_reason).toBe("tool_use");
      expect(session.turns[0]?.blocks).toEqual([
        {
          type: "text",
          text: `I will start with ${file} so the change matches the code that is already there.`,
        },
        {
          type: "tool_use",
          id: `toolu_stream_${stream}_0001`,
          name: "Read",
          input: { file_path: `${SESSION_ROOT}/${file}` },
        },
      ]);

      const answer = textOf(session, 1);
      expect(answer.length).toBeGreaterThanOrEqual(STREAM_CHARS);
      expect(answer).toContain("```diff");
      expect(answer).toContain("```ts");
      expect(answers.has(answer)).toBe(false);
      answers.add(answer);
    }
  });
});

describe("recordings", () => {
  const prompts = recordings();
  const tasks = join(import.meta.dir, "..", "..", "tasks");

  test("one prompt per stream, read from the task files", () => {
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      "stream-1",
      "stream-2",
      "stream-3",
      "stream-4",
      "stream-5",
    ]);
    expect(prompts.map((prompt) => prompt.match)).toEqual([
      "replay:stream-1",
      "replay:stream-2",
      "replay:stream-3",
      "replay:stream-4",
      "replay:stream-5",
    ]);
    const c1 = readFileSync(join(tasks, "C1-orchestrated-build", "prompt.md"), "utf8");
    const paragraph = firstParagraph(c1);
    expect(paragraph).toStartWith("You are working in the Ledger repository");

    for (const prompt of prompts.slice(0, 4)) {
      expect(prompt.prompt).toStartWith(paragraph);
      expect(prompt.prompt).toContain(`W${prompt.stream}.`);
      expect(prompt.prompt).not.toContain("{{");
      expect(prompt.prompt).not.toContain("Handoff code");
      expect(prompt.prompt).not.toContain(`W${prompt.stream + 1}.`);
      const item = withoutHandoff(workItem(c1, prompt.stream), prompt.stream);
      expect(prompt.prompt).toBe(`${paragraph}\n\n${item}`);
      expect(item).toStartWith(`W${prompt.stream}.`);
    }

    const b3 = readFileSync(join(tasks, "B3-real-prompt", "prompt.md"), "utf8").trim();
    expect(prompts[4]?.prompt).toBe(b3);
  });
});
