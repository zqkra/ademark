// EL-SDK: a new session runs Claude in Chat through the bundled claude-agent-acp; a session can switch to the
// Claude TUI in a PTY (ADES.md 3.18).
import { profileAdapter } from "./profile.ts";

export const orchestratorInc = profileAdapter({
  id: "orchestrator-inc",
  name: "Orchestrator",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  // ADES.md 3.18: the bundle is "Agent Orchestrator.app".
  appName: "Agent Orchestrator",
  bundleId: "dev.agent-orchestrator.desktop",
  // ADES.md 3.18: setup through the `ao` CLI in the bundle (Contents/Resources/daemon/ao).
  drive: "cli",
  // ADES.md 3.18: "Data to move aside | ~/.ao". It holds the Electron userData (~/.ao/electron), the daemon data
  // (~/.ao/data: ao.db, worktrees, telemetry marker) and app-state.json.
  dataDirs: ["~/.ao"],
  launchAgents: [],
  vendorDirs: ["~/.ao"],
  teamId: "X9LNSP8MC2",
});
