// EL-SDK: Claude Agent SDK and `codex app-server` (ADES.md 3.6).
import type { AdapterContext } from "../core/contracts.ts";
import { bootout, procsFor, runTool } from "./macos.ts";
import { profileAdapter } from "./profile.ts";

const APP_PATH = "/Applications/Cloudroom.app";
const APP_BINARY = `${APP_PATH}/Contents/MacOS/Cloudroom`;

export const cloudroom = profileAdapter({
  id: "cloudroom",
  name: "Cloudroom",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  appName: "Cloudroom",
  // ADES.md 3.6 does not print the bundle id; it is read from the installed bundle.
  bundleId: "dev.cloudroom.gui",
  // ADES.md 3.6: drive is `room-cli`, the cloudroom:// scheme, CDP and webhooks.
  drive: "cli",
  // ADES.md 3.6: "Data to move aside | ~/.cloudroom/skills; thread database path unknown, find in pilot".
  dataDirs: ["~/.cloudroom"],
  // ADES.md 3.6: KeepAlive LaunchAgent seen on this Mac; boot it out while other ADEs run.
  launchAgents: ["dev.cloudroom.preview.86e6d7d7b43e198e"],
  // ADES.md 3.6: Electron set plus the KeepAlive LaunchAgent.
  vendorDirs: ["~/.cloudroom"],
});

// 129: the preview LaunchAgent runs the app's own binary under launchd, so after a quit the profile adapter takes it for
// the app, waits, and presses Return on a process with no window. That stops the block at "not_frontmost". reset boots
// the agent out anyway, so it does that first. quit leaves the agent alone, because A9 measures what it keeps alive.
const { reset, quit } = cloudroom;

function launchAgentPids(ctx: AdapterContext): Set<number> {
  const labels = cloudroom.calibration.launchAgents;
  const lines = runTool(ctx, ["launchctl", "list"]).split("\n").map((line) => line.split("\t"));
  return new Set(lines.filter(([, , label]) => labels.includes(label ?? "")).map(([pid]) => Number(pid)));
}

async function appStillOpen(ctx: AdapterContext): Promise<boolean> {
  const agents = launchAgentPids(ctx);
  const procs = await procsFor(ctx, { bundlePaths: [APP_PATH] });
  return procs.some((proc) => proc.path === APP_BINARY && proc.ppid === 1 && !agents.has(proc.pid));
}

cloudroom.reset = async (ctx) => {
  for (const label of cloudroom.calibration.launchAgents) bootout(ctx, label);
  await reset(ctx);
};

cloudroom.quit = async (ctx) => {
  try {
    await quit(ctx);
  } catch (error) {
    if (await appStillOpen(ctx)) throw error;
    ctx.log("quit: the app is gone, only its LaunchAgent is alive");
  }
};
