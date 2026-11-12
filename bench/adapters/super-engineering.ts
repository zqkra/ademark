// NATIVE: Rust, GPUI; `sc` CLI over a local socket plus Accessibility (ADES.md 3.13).
import { profileAdapter } from "./profile.ts";

export const superEngineering = profileAdapter({
  id: "super-engineering",
  name: "super.engineering",
  family: "NATIVE",
  agents: ["claude", "codex"],
  // Build 15aae8f8 renamed its bundle from Superconductor.app to super.engineering.app on first launch (2026-10-24).
  appName: "super.engineering",
  bundleId: "engineering.super.app",
  // ADES.md 3.13: drive is the `sc` CLI over a local socket and Accessibility. No CDP.
  drive: "cli",
  // ADES.md 3.13: "Data to move aside | ~/.super.engineering (older profiles are symlinked)".
  dataDirs: ["~/.super.engineering"],
  launchAgents: [],
  // ADES.md 3.13: "Processes | unknown, find in pilot".
  vendorDirs: ["~/.super.engineering"],
});
