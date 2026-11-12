import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENT_EXECUTABLES,
  agentsInWorktree,
  assertApplyAllowed,
  executableBasename,
  killAgent,
  parseLsofCwd,
  parseLsofCwds,
  parsePs,
  samePath,
  type AgentProcess,
} from "../fault/kill-agent.ts";

const processes: AgentProcess[] = [
  { pid: 100, cwd: "/tmp/ademark-task-1", name: "claude" },
  { pid: 101, cwd: "/private/tmp/ademark-task-1/sub", name: "node" },
  { pid: 102, cwd: "/tmp/other", name: "claude" },
  { pid: 103, cwd: "/tmp/ademark-task-1", name: "codex" },
  { pid: 104, cwd: "/tmp/ademark-task-1", name: "zsh" },
  { pid: 105, cwd: "/tmp/ademark-task-1", name: "git" },
  { pid: 106, cwd: "/tmp/ademark-task-1", name: "/usr/local/bin/claude" },
];

describe("lsof parsing", () => {
  test("takes the path line from an -Fn record", () => {
    expect(parseLsofCwd("p2496\nfcwd\nn/private/tmp\n")).toBe("/private/tmp");
  });

  test("returns null when there is no path", () => {
    expect(parseLsofCwd("p2496\n")).toBeNull();
  });

  test("parses one bulk lsof record per process", () => {
    const cwds = parseLsofCwds("p100\nfcwd\nn/tmp/a\np101\nfcwd\nn/private/tmp/b\np102\nfcwd\nn/\n");
    expect(cwds.get(100)).toBe("/tmp/a");
    expect(cwds.get(101)).toBe("/private/tmp/b");
    expect(cwds.get(102)).toBe("/");
  });

  test("parses ps output into pid and command", () => {
    const names = parsePs("  100 /usr/local/bin/claude\n  101 node\n");
    expect(names.get(100)).toBe("/usr/local/bin/claude");
    expect(names.get(101)).toBe("node");
  });

  test("treats /private/tmp and /tmp as the same path", () => {
    expect(samePath("/private/tmp/x", "/tmp/x")).toBe(true);
    expect(samePath("/tmp/x", "/tmp/y")).toBe(false);
  });
});

describe("executable basenames", () => {
  test("takes the last path segment", () => {
    expect(executableBasename("/usr/local/bin/claude")).toBe("claude");
    expect(executableBasename("codex")).toBe("codex");
    expect(executableBasename("  /Applications/T3 Code.app/claude  ")).toBe("claude");
  });
});

describe("agentsInWorktree", () => {
  test("selects only claude and codex in the worktree, not the shell, node or git", () => {
    const matches = agentsInWorktree(processes, "/tmp/ademark-task-1");
    expect(matches.map((proc) => proc.pid)).toEqual([100, 103, 106]);
  });

  test("matches a /private-prefixed worktree", () => {
    expect(agentsInWorktree(processes, "/private/tmp/ademark-task-1").map((proc) => proc.pid)).toEqual([100, 103, 106]);
  });

  test("matches nothing for an unrelated folder", () => {
    expect(agentsInWorktree(processes, "/tmp/elsewhere")).toEqual([]);
  });

  test("a custom executable list replaces the default", () => {
    expect(agentsInWorktree(processes, "/tmp/ademark-task-1", ["zsh", "git"]).map((proc) => proc.pid)).toEqual([104, 105]);
  });

  test("the default list is claude and codex", () => {
    expect(DEFAULT_AGENT_EXECUTABLES).toEqual(["claude", "codex"]);
  });
});

describe("killAgent dry run", () => {
  test("prints the kill commands for the agents only", () => {
    const result = killAgent({ worktree: "/tmp/ademark-task-1", processes });
    expect(result.applied).toBe(false);
    expect(result.pids).toEqual([100, 103, 106]);
    expect(result.commands).toEqual(["kill -9 100", "kill -9 103", "kill -9 106"]);
  });

  test("accepts a repeated --agent-exe list", () => {
    const result = killAgent({ worktree: "/tmp/ademark-task-1", processes, agentExecutables: ["zsh"] });
    expect(result.pids).toEqual([104]);
  });

  test("returns no commands when nothing matches", () => {
    const result = killAgent({ worktree: "/tmp/none", processes });
    expect(result.pids).toEqual([]);
    expect(result.commands).toEqual([]);
  });
});

// As the "ademark" user these guards let --apply through, so a refusal test would run the real fault
// (pilot 2026-10-20: the cut-network one cut the network). They only run in other accounts.
const AS_APPLY_USER = userInfo().username === "ademark";

describe("apply permission", () => {
  test.skipIf(AS_APPLY_USER)("refuses --apply for a process this run did not start", () => {
    expect(() => assertApplyAllowed({ apply: true }, "fault kill-agent", [999999])).toThrow(
      /only allowed as the dedicated "ademark" user/,
    );
  });
});

// A sleep the test starts itself in a temp folder: the only --apply target the ticket allows.
describe("killAgent --apply on a self-started sleep", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ademark-kill-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("kills only the sleep started in the temp worktree", async () => {
    const child = Bun.spawn(["sleep", "120"], { cwd: dir });
    const pid = child.pid;
    // Give lsof a moment to see the child's cwd.
    await Bun.sleep(300);

    const result = killAgent({ worktree: dir, apply: true, agentExecutables: ["sleep"] });
    expect(result.pids).toContain(pid);
    expect(result.commands).toContain(`kill -9 ${pid}`);

    const exited = await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")]);
    expect(exited).not.toBe("timeout");
    if (exited === "timeout") child.kill();
  });
});
