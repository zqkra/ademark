// EL-PTY: official CLI in a PTY with `--dangerously-skip-permissions` (ADES.md 3.8).
import { profileAdapter } from "./profile.ts";

export const orca = profileAdapter({
  id: "orca",
  name: "Orca",
  family: "EL-PTY",
  agents: ["claude", "codex"],
  // ADES.md 3.8: "open -a with the app name read at install (not installed yet)".
  appName: "Orca",
  // ADES.md 3.8: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.8: drive is the `orca` CLI, the orca:// scheme and CDP (unverified).
  drive: "cli",
  // ADES.md 3.8: "Data to move aside | Electron userData folder (path unknown, find in pilot)".
  dataDirs: [],
  launchAgents: [],
  // ADES.md 3.8: Electron set plus PTY agent processes.
  vendorDirs: [],
});
