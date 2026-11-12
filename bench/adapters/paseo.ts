// EL-SDK: Claude Agent SDK over the official `claude` CLI, `codex app-server` (ADES.md 3.3).
import { mainPid, waitForText } from "./macos.ts";
import { profileAdapter } from "./profile.ts";

const APP = { bundlePaths: ["/Applications/Paseo.app"] };

// The session log ends the long turn while the thread is still painting it: gate 2026-11-06, the end of turn came with
// the screen on step 628 of 1000, and the thread paints about 9 steps a second, and only while its tab is open. A11
// switched away at once, so its first open timed out on step 923 and its second waited 4.6 s for the same paint. The turn
// counts as done when its last line is on screen, with the tab still open. The wait is setup, so nothing times it.
const LONG_PROMPT = "replay:long-2000";
const LONG_END = "THREAD-END";
const LONG_PAINT_TIMEOUT_S = 240;

export const paseo = profileAdapter({
  id: "paseo",
  name: "Paseo",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  // ADES.md 3.3: "open -a with the app name read at install (not installed yet)".
  appName: "Paseo",
  // ADES.md 3.3: "bundle id unknown, read at install".
  bundleId: null,
  // ADES.md 3.3: drive is the `paseo` CLI, TypeScript SDK, WebSocket API, MCP server and CDP.
  drive: "cli",
  // ADES.md 3.3: "Data to move aside | ~/.paseo (config.json, daemon.log, worktrees in ~/.paseo/worktrees)".
  dataDirs: ["~/.paseo"],
  // ADES.md 3.3: the local daemon stops on quit (`keepRunningAfterQuit: false`).
  launchAgents: [],
  // ADES.md 3.3: Electron set plus the local daemon.
  vendorDirs: ["~/.paseo"],
});

let lastPrompt = "";

const sendPrompt = paseo.send;
paseo.send = async (ctx, text) => {
  lastPrompt = text;
  await sendPrompt(ctx, text);
};

const waitForTurn = paseo.waitDone;
paseo.waitDone = async (ctx, timeoutMs) => {
  const turn = await waitForTurn(ctx, timeoutMs);
  const region = paseo.calibration.threadRect;
  if (!turn.done || lastPrompt !== LONG_PROMPT || region === null) return turn;
  try {
    await waitForText(ctx, (await mainPid(ctx, APP)) ?? 0, region, LONG_END, LONG_PAINT_TIMEOUT_S);
    return turn;
  } catch (error) {
    return { done: false, reason: error instanceof Error ? error.message : String(error) };
  }
};
