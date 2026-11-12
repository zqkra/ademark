import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_DIR, agentProcessNames, isAgentExecutable } from "../core/agents.ts";

describe("agent executables", () => {
  test("the native Claude Code binary counts although its name is its version", () => {
    expect(isAgentExecutable(`${CLAUDE_NATIVE_DIR}/2.1.303`)).toBe(true);
    expect(isAgentExecutable("/opt/homebrew/bin/codex")).toBe(true);
    expect(isAgentExecutable("/usr/local/bin/claude")).toBe(true);
  });

  test("other processes, and look-alike folders, do not", () => {
    expect(isAgentExecutable("/bin/zsh")).toBe(false);
    expect(isAgentExecutable(`${CLAUDE_NATIVE_DIR}-old/2.1.303`)).toBe(false);
    expect(isAgentExecutable("/Applications/Ghostty.app/Contents/MacOS/ghostty")).toBe(false);
  });

  test("nettop names list every executable of a folder entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-agents-"));
    try {
      writeFileSync(join(dir, "2.1.303"), "");
      expect(agentProcessNames(["claude", `${dir}/`, "/no/such/folder/"]).sort()).toEqual(["2.1.303", "claude"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
