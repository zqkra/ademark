// NATIVE: Agent SDK with a bundled Claude Code 2.1.300; deep links plus Accessibility (ADES.md 3.14).
import { profileAdapter } from "./profile.ts";

export const conductor = profileAdapter({
  id: "conductor",
  name: "Conductor",
  family: "NATIVE",
  agents: ["claude", "codex"],
  // ADES.md 3.14: "open -a with the app name read at install (not installed yet)".
  appName: "Conductor",
  // ADES.md 3.14: bundle id not stated; the data folder is com.conductor.app.
  bundleId: null,
  // ADES.md 3.14: "Locally: deep links plus Accessibility".
  drive: "ax",
  // ADES.md 3.14: "Data to move aside | ~/Library/Application Support/com.conductor.app and ~/conductor".
  dataDirs: ["~/Library/Application Support/com.conductor.app", "~/conductor"],
  launchAgents: [],
  // ADES.md 3.14: "Processes | unknown, find in pilot".
  vendorDirs: ["~/Library/Application Support/com.conductor.app", "~/conductor"],
  // ADES.md 3.14: "Orchestration (C1) | not supported (the Conductor MCP is opt-in)".
  orchestrationTrigger: null,
});
