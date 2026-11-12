// OWN: Capy's own harness, local "This Mac" threads only (ADES.md 3.15).
import { profileAdapter } from "./profile.ts";

const adapter = profileAdapter({
  id: "capy",
  name: "Capy",
  family: "OWN",
  // ADES.md 3.15: "Capy runs its own model-agnostic agent".
  agents: ["own"],
  appName: "Capy",
  bundleId: "ai.capy.desktop",
  // ADES.md 3.15: drive is the HTTP API and CDP.
  drive: "api",
  // ADES.md 3.15: "Data to move aside | ~/.capy/worktrees (local threads). Messages live in Capy's cloud".
  dataDirs: ["~/.capy/worktrees"],
  launchAgents: [],
  // ADES.md 3.15: Electron set plus local agent processes for "This Mac" threads (find in pilot).
  vendorDirs: ["~/.capy"],
  agentExecutables: [],
});

// ADES.md 2.5 and 3.15: Capy runs its own agent, and its requests go to Capy's backend, so the replay server never
// sees it. On 2026-11-11 its first real block ended at the first seed thread: the wait looked for a Claude session
// log that this agent does not write. Track A now runs only the tests that need no replay (as for Claude desktop), and
// the wait for a turn ends by the idle fallback of its profile. Object.assign keeps the profile adapter itself.
export const capy = Object.assign(adapter, { liveModel: true });
