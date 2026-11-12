// FIRST: Anthropic's Code tab in the Claude desktop app (ADES.md 3.16).
import { profileAdapter } from "./profile.ts";

const adapter = profileAdapter({
  id: "claude-desktop",
  name: "Claude desktop (Code tab)",
  family: "FIRST",
  agents: ["claude"],
  // ADES.md 3.16: "open -a with the app name read at install (not installed yet)".
  appName: "Claude",
  // ADES.md 3.16: "bundle id and version: read at install".
  bundleId: null,
  // ADES.md 3.16: "Drive (setup) | Accessibility (no CLI or deep link documented)".
  drive: "ax",
  // ADES.md 3.16: "Data to move aside | unknown, find in pilot".
  dataDirs: [],
  launchAgents: [],
  // ADES.md 3.16: "Processes | unknown, find in pilot".
  vendorDirs: [],
  agentExecutables: ["claude"],
});

// The app forces its own API host, so the replay server never sees its agent. Object.assign keeps the profile
// adapter itself: a spread copy loses its registration (isProfileAdapter) and freezes the profile getters at import.
export const claudeDesktop = Object.assign(adapter, { liveModel: true });
