// EL-SDK: Claude Agent SDK 0.3.296 and `codex app-server` (ADES.md 3.4).
import type { AdapterContext } from "../core/contracts.ts";
import { mainPid, pidsFor, runTool, waitGone } from "./macos.ts";
import { profileAdapter } from "./profile.ts";

const APP = { bundlePaths: ["/Applications/Synara.app"] };
const TERM_TIMEOUT_MS = 30_000;

export const synara = profileAdapter({
  id: "synara",
  name: "Synara",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  // ADES.md 3.4: "open -a with the app name read at install (not installed yet)".
  appName: "Synara",
  // ADES.md 3.4: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.4: drive is the headless server HTTP/WebSocket API, External MCP and CDP.
  drive: "api",
  // ADES.md 3.4: "Data to move aside | ~/.synara/ (...); SYNARA_HOME overrides it".
  dataDirs: ["~/.synara"],
  launchAgents: [],
  // ADES.md 3.4: Electron set plus a Node server.
  vendorDirs: ["~/.synara"],
});

// 2026-11-10: A2 failed 6 of 6 with "the app is still running", and A9 no-sessions reps 2 and 3 of
// control-2026-11-10T08-31-19Z-synara-1 found the whole app alive 60 s after its quit (main Synara with ppid 1, its
// Synara server child, the renderer and a helper). The quit event goes through before-quit, which always opens the in-app
// "Quit Synara? Are you sure you want to quit?" modal (runningChatsQuitGuard, profile notes of 2026-10-24), and the
// Enter of the profile quit does not confirm it. Synara 1.1.0 installs its own SIGINT/SIGTERM handler once it is ready
// (src/shutdownSignals.ts in app.asar: "a signal from a terminal or a script ... shuts the app down without asking"),
// which runs requestGracefulAppQuit: the same runtime shutdown and app.quit() as the modal's Quit button. So the quit
// is a TERM to the main process. What is left after it goes through the profile quit, as before.
export async function terminateMain(ctx: AdapterContext): Promise<void> {
  const pid = await mainPid(ctx, APP);
  if (pid === null) return;
  const pids = await pidsFor(ctx, APP);
  try {
    runTool(ctx, ["kill", "-TERM", String(pid)]);
  } catch (error) {
    // Gone between the listing and the signal: that is what the quit wanted.
    if (!/no such process/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return;
  }
  const alive = await waitGone(ctx, pids, TERM_TIMEOUT_MS);
  if (!ctx.dryRun) ctx.log(`quit: Synara after TERM to ${pid}, still alive after ${TERM_TIMEOUT_MS / 1000} s: ${alive.length === 0 ? "none" : alive.join(",")}`);
}

const quitProfile = synara.quit;
synara.quit = async (ctx) => {
  await terminateMain(ctx);
  await quitProfile(ctx);
};
