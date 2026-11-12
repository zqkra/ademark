// Which processes are agent CLIs (TESTS.md 1.2 `agents` group, faults, Track B process names).
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Pilot 2026-10-20: the native Claude Code install runs ~/.local/share/claude/versions/<version>, so its executable is
// named "2.1.303", not "claude"; `ps` shows "claude" only because it starts through the ~/.local/bin/claude link. Matching
// by name alone put every Claude Code process in the `app` group (A7 counted 0 agents) and let reset miss them.
export const CLAUDE_NATIVE_DIR = join(homedir(), ".local", "share", "claude", "versions");

// An entry with a "/" is a folder: any executable inside it matches. Otherwise the executable's file name must match.
export const AGENT_EXECUTABLES: readonly string[] = ["claude", "codex", `${CLAUDE_NATIVE_DIR}/`];

export function isAgentExecutable(path: string, entries: readonly string[] = AGENT_EXECUTABLES): boolean {
  const name = basename(path);
  return entries.some((entry) => {
    const trimmed = entry.trim();
    if (trimmed === "") return false;
    if (!trimmed.includes("/")) return name === trimmed;
    const folder = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    return path === trimmed || path.startsWith(folder);
  });
}

// Process names as `nettop` prints them: the plain entries, plus every executable in a folder entry.
export function agentProcessNames(entries: readonly string[] = AGENT_EXECUTABLES): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.includes("/")) {
      if (entry.trim() !== "") names.add(entry.trim());
      continue;
    }
    try {
      for (const file of readdirSync(entry)) names.add(file);
    } catch {
      // A folder that is not there holds no agent.
    }
  }
  return [...names];
}
