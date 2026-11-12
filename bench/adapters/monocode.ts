// NATIVE: Tauri 2 plus a Node host process (ADES.md 3.12).
import { profileAdapter } from "./profile.ts";

export const monocode = profileAdapter({
  id: "monocode",
  name: "MonoCode",
  family: "NATIVE",
  agents: ["claude", "codex"],
  // ADES.md 3.12: "open -a with the app name read at install (not installed yet)".
  appName: "MonoCode",
  // ADES.md 3.12: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.12: drive is the `MonoCode control` CLI (orchestration lead only), Accessibility and keystrokes. No CDP.
  drive: "ax",
  // ADES.md 3.12: "monocode.db in Tauri's app data folder (path unknown, find in pilot)".
  dataDirs: [],
  launchAgents: [],
  // ADES.md 3.12: the app, WebKit processes by responsible PID, the Node host.
  vendorDirs: [],
});
