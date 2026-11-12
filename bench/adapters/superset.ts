// EL-PTY: official CLI in node-pty, plus a persistent pty-daemon (ADES.md 3.7).
import { profileAdapter } from "./profile.ts";

export const superset = profileAdapter({
  id: "superset",
  name: "Superset",
  family: "EL-PTY",
  agents: ["claude", "codex"],
  // ADES.md 3.7: "open -a with the app name read at install (not installed yet)".
  appName: "Superset",
  // ADES.md 3.7: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.7: drive is the `superset` CLI, deep links, hosted MCP server, SDK and CDP (unverified).
  drive: "cli",
  // ADES.md 3.7: "Data to move aside | ~/.superset/ (worktrees, sessions, bin); app database path unknown".
  dataDirs: ["~/.superset"],
  // ADES.md 3.7: the pty-daemon may survive quit; its launch-agent label is unknown.
  launchAgents: [],
  // ADES.md 3.7: Electron set, pty-daemon, CLI processes.
  vendorDirs: ["~/.superset"],
  // ADES.md 3.7: "New thread (A3) | ⌘N creates a worktree and branch under ~/.superset/worktrees".
  timed: { launch: [], newThread: [{ kind: "keys", combo: "cmd+n" }], send: [] },
});
