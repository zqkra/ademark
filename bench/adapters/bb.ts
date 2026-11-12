// EL-SDK: Claude Agent SDK and `codex app-server` (ADES.md 3.2).
import { profileAdapter } from "./profile.ts";

export const bb = profileAdapter({
  id: "bb",
  name: "bb",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  appName: "bb",
  // ADES.md 3.2: "Bundle id | dev.bb.desktop; updater job dev.bb.desktop.ShipIt".
  bundleId: "dev.bb.desktop",
  // ADES.md 3.2: drive is the `bb` CLI, loopback HTTP/WebSocket API and CDP.
  drive: "cdp",
  // ADES.md 3.2: "Data to move aside | ~/.bb/ (SQLite, logs, thread storage, plugins, ~/.bb/AGENTS.md)".
  dataDirs: ["~/.bb"],
  // ADES.md 3.2: "Bundle id | dev.bb.desktop; updater job dev.bb.desktop.ShipIt".
  launchAgents: ["dev.bb.desktop.ShipIt"],
  // ADES.md 3.2: Electron set, local server, host daemons.
  vendorDirs: ["~/.bb"],
});
