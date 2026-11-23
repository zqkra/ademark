// EL-SDK: Electron renderer, Go daemon, Claude Code through claude-agent-acp (ADES.md 3.18).
import { setenv } from "./macos.ts";
import { profileAdapter } from "./profile.ts";

export const agentOrchestrator = profileAdapter({
  id: "agent-orchestrator",
  name: "Agent Orchestrator",
  family: "EL-SDK",
  agents: ["claude"],
  appName: "Agent Orchestrator",
  appPath: "/Applications/Agent Orchestrator.app",
  bundleId: "dev.agent-orchestrator.desktop",
  drive: "cli",
  // ADES.md 3.18: daemon data, Electron userData and worktrees all live under ~/.ao.
  dataDirs: ["~/.ao"],
  launchAgents: [],
  vendorDirs: ["~/.ao"],
  teamId: "X9LNSP8MC2",
});

// ADES.md 3.18 and section 1: telemetry off. A packaged build sends PostHog events from the renderer and the daemon,
// and Sentry reports, unless the environment says otherwise; an explicit value always wins (frontend/src/main.ts
// telemetryOverrides, shared/telemetry.ts rendererTelemetryEnabled, main/sentry-main.ts). The app reads launchd's
// environment, so these are set before every launch.
export const TELEMETRY_ENV: Readonly<Record<string, string>> = {
  AO_TELEMETRY_EVENTS: "off",
  AO_TELEMETRY_METRICS: "off",
  AO_TELEMETRY_REMOTE: "off",
  AO_TELEMETRY_RENDERER: "off",
  AO_SENTRY_DSN: "",
  AO_ELECTRON_SENTRY_DSN: "",
};

const launchProfile = agentOrchestrator.launch;
agentOrchestrator.launch = async (ctx) => {
  for (const [name, value] of Object.entries(TELEMETRY_ENV)) setenv(ctx, name, value);
  return launchProfile(ctx);
};
