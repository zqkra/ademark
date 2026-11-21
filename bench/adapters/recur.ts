// NATIVE: Rust, GPUI; `claude -p` stream-json per turn, `recur-cli open` over a local socket (ADES.md 3.18).
import { profileAdapter } from "./profile.ts";

export const recur = profileAdapter({
  id: "recur",
  name: "Recur",
  family: "NATIVE",
  agents: ["claude", "codex"],
  appName: "Recur",
  bundleId: "build.recur.app",
  drive: "cli",
  dataDirs: ["~/Library/Application Support/Recur", "~/.recur"],
  launchAgents: [],
  vendorDirs: ["~/Library/Application Support/Recur", "~/.recur"],
});
