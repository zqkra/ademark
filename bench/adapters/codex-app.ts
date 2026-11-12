// FIRST: the Codex app, which now ships inside the ChatGPT desktop app (ADES.md 3.17).
import { profileAdapter } from "./profile.ts";

export const codexApp = profileAdapter({
  id: "codex-app",
  name: "Codex app (inside the ChatGPT desktop app)",
  family: "FIRST",
  agents: ["codex"],
  // ADES.md 3.17: "open -a with the app name read at install (not installed yet)".
  appName: "ChatGPT",
  // ADES.md 3.17: "bundle id and version of the ChatGPT desktop app: read at install".
  bundleId: null,
  // ADES.md 3.17: "Drive (setup) | Accessibility (no automation surface documented besides scheduled tasks)".
  drive: "ax",
  // ADES.md 3.17: "Data to move aside | unknown, find in pilot".
  dataDirs: [],
  launchAgents: [],
  // ADES.md 3.17: "Processes | unknown, find in pilot".
  vendorDirs: [],
  agentExecutables: ["codex"],
});
