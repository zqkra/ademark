// NATIVE: Rust, GPUI; official TUI in a PTY, engine daemon `dirijord-rs` (ADES.md 3.11).
import { profileAdapter } from "./profile.ts";

export const diri = profileAdapter({
  id: "diri",
  name: "Diri",
  family: "NATIVE",
  agents: ["claude", "codex"],
  // ADES.md 3.11: "open -a with the app name read at install (not installed yet)".
  appName: "Diri",
  // ADES.md 3.11: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.11: drive is the `dirijor` CLI and a Unix socket. No CDP, no URL scheme.
  drive: "cli",
  // ADES.md 3.11: "Data to move aside | ~/Library/Application Support/Dirijor/ (state.json, logs/dirijord.log)".
  dataDirs: ["~/Library/Application Support/Dirijor"],
  // ADES.md 3.11: a launchd wake helper needs admin approval; label: find in pilot.
  launchAgents: [],
  // ADES.md 3.11: the app, dirijord-rs, holders, the wake helper.
  vendorDirs: ["~/Library/Application Support/Dirijor"],
});
