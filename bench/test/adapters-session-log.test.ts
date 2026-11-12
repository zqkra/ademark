import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSessionLogs,
  parseCodexLog,
  parseCpuTime,
  parseLsofCwds,
  parsePsCpu,
  parseClaudeLog,
  sameRealPath,
  waitForEndOfTurn,
} from "../adapters/session-log.ts";
import type { SessionSummary } from "../adapters/session-log.ts";
import { captureContext } from "./adapters-fake.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "session-logs");
const FIXTURE_CWD = "/Users/ademark/arena/bare-cli";

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function summaryOf(parsed: SessionSummary): Record<string, unknown> {
  return {
    sessionId: parsed.sessionId,
    model: parsed.model,
    effort: parsed.effort,
    ended: parsed.ended,
    endedAt: parsed.endedAt,
    usage: parsed.usage,
  };
}

describe("parseClaudeLog", () => {
  test("every model that wrote is kept, without Claude Code's own lines", () => {
    const line = (id: string, model: string) => JSON.stringify({ type: "assistant", message: { id, role: "assistant", model, content: [], usage: { input_tokens: 1 } } });
    const parsed = parseClaudeLog([line("a", "claude-sonnet-5"), line("b", "<synthetic>"), line("c", "claude-opus-5-5")].join("\n"));
    expect(parsed.models).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
  });

  test("a message split over several lines counts its usage once", () => {
    const line = (block: unknown) =>
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_1", role: "assistant", content: [block], usage: { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 50 } },
      });
    const parsed = parseClaudeLog([line({ type: "text", text: "Reading." }), line({ type: "tool_use", name: "Read" })].join("\n"));
    expect(parsed.usage).toEqual({ input: 2, cache_write: 0, cache_read: 100, output: 50 });
    expect(parsed.toolCalls).toBe(1);
  });

  test("a tool-use turn followed by end_turn is the end of the turn", () => {
    const parsed = parseClaudeLog(fixture("claude-tool-use-then-end.jsonl"));
    expect(summaryOf(parsed)).toEqual({
      sessionId: "claude-session-1",
      model: "claude-opus-5-5",
      effort: "high",
      ended: true,
      endedAt: "2026-10-19T10:00:03.000Z",
      usage: { input: 15, cache_write: 21, cache_read: 130, output: 47 },
    });
    expect(parsed.cwd).toBe(FIXTURE_CWD);
    expect(parsed.version).toBe("2.1.303");
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.lastText).toBe("All done.\nledger-ok");
  });

  test("a session that is mid-turn has not ended", () => {
    const parsed = parseClaudeLog(fixture("claude-mid-turn.jsonl"));
    expect(parsed.ended).toBe(false);
    expect(parsed.endedAt).toBeNull();
    expect(parsed.usage).toEqual({ input: 10, cache_write: 20, cache_read: 30, output: 40 });
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.lastText).toBeNull();
  });

  test("a sidechain line after the main end is ignored", () => {
    const parsed = parseClaudeLog(fixture("claude-sidechain-after-end.jsonl"));
    expect(parsed.ended).toBe(true);
    expect(parsed.endedAt).toBe("2026-10-19T10:10:03.000Z");
    expect(parsed.usage).toEqual({ input: 1, cache_write: 2, cache_read: 3, output: 4 });
    expect(parsed.toolCalls).toBe(0);
    expect(parsed.lastText).toBe("Done.\nledger-ok");
  });

  test("a half-written last line does not break the parse", () => {
    const parsed = parseClaudeLog(`${fixture("claude-tool-use-then-end.jsonl")}{"type":"assistant","mess`);
    expect(parsed.ended).toBe(true);
  });
});

describe("parseCodexLog", () => {
  test("task_complete after the last task_started ends the turn", () => {
    const parsed = parseCodexLog(fixture("codex-complete.jsonl"));
    expect(summaryOf(parsed)).toEqual({
      sessionId: "codex-session-1",
      model: "gpt-6.1-sol",
      effort: "high",
      ended: true,
      endedAt: "2026-10-19T10:20:04.000Z",
      usage: { input: 100, cache_write: 0, cache_read: 40, output: 9 },
    });
    expect(parsed.cwd).toBe(FIXTURE_CWD);
    expect(parsed.version).toBe("0.163.0");
    expect(parsed.toolCalls).toBe(2);
    expect(parsed.lastText).toBe("Done.\nledger-ok");
  });

  test("a rollout without task_complete has not ended", () => {
    const parsed = parseCodexLog(fixture("codex-incomplete.jsonl"));
    expect(parsed.ended).toBe(false);
    expect(parsed.endedAt).toBeNull();
    expect(parsed.usage).toEqual({ input: 20, cache_write: 0, cache_read: 0, output: 5 });
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.lastText).toBeNull();
  });

  test("a new task_started after the completion reopens the turn", () => {
    const text = `${fixture("codex-complete.jsonl")}{"timestamp":"2026-10-19T10:20:10.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}\n`;
    expect(parseCodexLog(text).ended).toBe(false);
  });

  test("only the last cumulative token_count event counts", () => {
    const parsed = parseCodexLog(fixture("codex-multi-token-count.jsonl"));
    expect(parsed.usage).toEqual({ input: 400, cache_write: 0, cache_read: 40, output: 20 });
    expect(parsed.ended).toBe(true);
  });

  test("last_token_usage events are summed when no event has a total", () => {
    const head = [
      '{"timestamp":"2026-10-19T11:10:00.000Z","type":"session_meta","payload":{"id":"codex-session-4","cwd":"/Users/ademark/arena/bare-cli","cli_version":"0.163.0"}}',
      '{"timestamp":"2026-10-19T11:10:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
    ];
    const events = [
      '{"timestamp":"2026-10-19T11:10:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":30,"cached_input_tokens":0,"output_tokens":4}}}}',
      '{"timestamp":"2026-10-19T11:10:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":70,"cached_input_tokens":0,"output_tokens":6}}}}',
    ];
    const parsed = parseCodexLog([...head, ...events].join("\n"));
    expect(parsed.usage).toEqual({ input: 100, cache_write: 0, cache_read: 0, output: 10 });
  });
});

function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "ademark-session-home-"));
}

function writeClaudeLog(home: string, name: string, cwd: string, body: string): string {
  const dir = join(home, ".claude", "projects", "-Users-ademark-arena-bare-cli");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body.replaceAll(FIXTURE_CWD, cwd));
  return path;
}

describe("findSessionLogs", () => {
  test("matches the worktree cwd after realpath on both sides", () => {
    const home = temporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "ademark-cwd-"));
    try {
      const resolved = realpathSync(cwd);
      // The log records the resolved path; the run loop asks with the symlinked one (and the reverse below).
      const path = writeClaudeLog(home, "session.jsonl", resolved, fixture("claude-tool-use-then-end.jsonl"));

      const found = findSessionLogs({ home, agent: "claude", cwd, since: 0 });
      expect(found.map((log) => log.path)).toEqual([path]);
      expect(found[0]!.summary.ended).toBe(true);
      expect(findSessionLogs({ home, agent: "claude", cwd: resolved, since: 0 })).toHaveLength(1);
      expect(sameRealPath(cwd, resolved)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("skips logs of another worktree and logs older than since", () => {
    const home = temporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "ademark-cwd-"));
    try {
      const other = join(tmpdir(), "ademark-other-worktree");
      writeClaudeLog(home, "mine.jsonl", cwd, fixture("claude-tool-use-then-end.jsonl"));
      writeClaudeLog(home, "other.jsonl", other, fixture("claude-tool-use-then-end.jsonl"));
      expect(findSessionLogs({ home, agent: "claude", cwd, since: 0 })).toHaveLength(1);

      const old = new Date("2026-01-01T00:00:00.000Z");
      for (const name of ["mine.jsonl", "other.jsonl"]) {
        utimesSync(join(home, ".claude", "projects", "-Users-ademark-arena-bare-cli", name), old, old);
      }
      expect(findSessionLogs({ home, agent: "claude", cwd, since: old.getTime() + 1 })).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("finds Codex rollouts under sessions/YYYY/MM/DD", () => {
    const home = temporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "ademark-cwd-"));
    try {
      const dir = join(home, ".codex", "sessions", "2026", "10", "19");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "rollout-2026-10-19T10-20-00-codex.jsonl"), fixture("codex-complete.jsonl").replaceAll(FIXTURE_CWD, cwd));

      const found = findSessionLogs({ home, agent: "codex", cwd, since: 0 });
      expect(found).toHaveLength(1);
      expect(found[0]!.summary.ended).toBe(true);
      expect(found[0]!.summary.model).toBe("gpt-6.1-sol");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("waitForEndOfTurn", () => {
  test("returns end_turn as soon as a matching log ends", async () => {
    const home = temporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "ademark-cwd-"));
    try {
      writeClaudeLog(home, "session.jsonl", cwd, fixture("claude-tool-use-then-end.jsonl"));
      const { ctx, lines } = captureContext({ home, worktree: cwd, dryRun: false });
      const result = await waitForEndOfTurn({ ctx, agent: "claude", cwd, since: 0, timeoutMs: 2000, pollMs: 10 });
      expect(result).toEqual({ done: true, reason: "end_turn" });
      expect(lines).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("returns idle when the worktree is quiet and no agent spends CPU", async () => {
    const home = temporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "ademark-cwd-"));
    try {
      const { ctx } = captureContext({ home, worktree: cwd, dryRun: false });
      let now = 0;
      const result = await waitForEndOfTurn({
        ctx,
        agent: "claude",
        cwd,
        since: 0,
        timeoutMs: 600_000,
        pollMs: 1000,
        deps: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          probe: () => ({ newestChangeMs: 0, agentCpuMs: 0, agentPids: [] }),
        },
      });
      expect(result).toEqual({ done: true, reason: "idle" });
      expect(now).toBeGreaterThanOrEqual(60_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // 2026-11-11: Capy's own agent writes no session log, and its block ended at the first seed thread with
  // 'no session log for agent "own"', although its profile sets the idle fallback.
  test("an ADE's own agent is waited for by the idle fallback alone; without it the wait refuses to start", async () => {
    const home = temporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "ademark-cwd-"));
    try {
      const { ctx } = captureContext({ home, worktree: cwd, dryRun: false });
      let now = 0;
      const deps = {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
        probe: () => ({ newestChangeMs: 0, agentCpuMs: 0, agentPids: [] as number[] }),
      };
      const result = await waitForEndOfTurn({ ctx, agent: "own", cwd, since: 0, timeoutMs: 600_000, pollMs: 1000, idleFallback: true, deps });
      expect(result).toEqual({ done: true, reason: "idle" });
      // While the project's files still change, it is not over.
      now = 0;
      const busy = await waitForEndOfTurn({ ctx, agent: "own", cwd, since: 0, timeoutMs: 3000, pollMs: 1000, deps: { ...deps, probe: () => ({ newestChangeMs: now, agentCpuMs: 0, agentPids: [] }) } });
      expect(busy).toEqual({ done: false, reason: "timeout" });
      await expect(waitForEndOfTurn({ ctx, agent: "own", cwd, since: 0, timeoutMs: 1000, pollMs: 10, idleFallback: false })).rejects.toThrow('no session log for agent "own"');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("returns timeout when the worktree keeps changing", async () => {
    const home = temporaryHome();
    const cwd = mkdtempSync(join(tmpdir(), "ademark-cwd-"));
    try {
      const { ctx } = captureContext({ home, worktree: cwd, dryRun: false });
      let now = 0;
      const result = await waitForEndOfTurn({
        ctx,
        agent: "codex",
        cwd,
        since: 0,
        timeoutMs: 3000,
        pollMs: 1000,
        deps: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          probe: () => ({ newestChangeMs: now, agentCpuMs: 0, agentPids: [] }),
        },
      });
      expect(result).toEqual({ done: false, reason: "timeout" });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("process parsers", () => {
  test("parseCpuTime reads ps cputime formats", () => {
    expect(parseCpuTime("0:00.12")).toBe(120);
    expect(parseCpuTime("1:02.34")).toBe(62_340);
    expect(parseCpuTime("1:02:03")).toBe(3_723_000);
    expect(parseCpuTime("garbage")).toBe(0);
  });

  test("parsePsCpu keeps pid, cpu and executable", () => {
    expect(parsePsCpu("  123   0:01.50 /Users/ademark/.local/bin/claude\n  9 0:00.00 /usr/bin/zsh\n")).toEqual([
      { pid: 123, cpuMs: 1500, name: "claude" },
      { pid: 9, cpuMs: 0, name: "zsh" },
    ]);
  });

  test("parseLsofCwds groups the cwd record by pid", () => {
    const text = "p123\nfcwd\nn/Users/ademark/arena/bare-cli\np456\nfcwd\nn/private/tmp/x\n";
    const cwds = parseLsofCwds(text);
    expect(cwds.get(123)).toBe("/Users/ademark/arena/bare-cli");
    expect(cwds.get(456)).toBe("/private/tmp/x");
  });

  test("sameRealPath treats /tmp/x and /private/tmp/x as one folder", () => {
    expect(sameRealPath("/tmp", "/private/tmp")).toBe(true);
  });
});
