// EL-SDK: Electron app; Claude through the Claude Agent SDK, Codex through `codex app-server`, other providers through
// their own SDKs (ADES.md 3.18). The chats run in a separate local process (the ADE runtime, `cli.cjs serve`), which
// launchd keeps alive as `com.ade.runtime`.
import { profileAdapter } from "./profile.ts";

export const ade = profileAdapter({
  id: "ade",
  name: "ADE",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  // ADES.md 3.18: CFBundleIdentifier com.ade.desktop, executable ADE.
  appName: "ADE",
  bundleId: "com.ade.desktop",
  // ADES.md 3.18: the `ade` CLI in the bundle (Contents/Resources/ade-cli/bin/ade) and the ade:// scheme.
  drive: "cli",
  // ADES.md 3.18: machine home ~/.ade, Electron userData ~/Library/Application Support/ade-desktop (the package name;
  // checked on 1.2.130-beta.39, 2026-11-16).
  dataDirs: ["~/.ade", "~/Library/Application Support/ade-desktop"],
  // ADES.md 3.18: the runtime and its watchdog are launch agents; ShipIt is the updater.
  launchAgents: ["com.ade.runtime", "com.ade.watchdog", "com.ade.desktop.ShipIt"],
  vendorDirs: ["~/.ade"],
});
