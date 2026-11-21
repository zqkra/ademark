// EL-SDK: a fresh install opens Claude as a chat tab through the bundled claude-agent-acp; terminal tabs run the
// official CLI in a PTY (ADES.md 3.18).
import { runTool } from "./macos.ts";
import { profileAdapter } from "./profile.ts";

export const pane = profileAdapter({
  id: "pane",
  name: "Pane",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  appName: "Pane",
  bundleId: "com.dcouple.pane",
  // ADES.md 3.18: setup through the `runpane` CLI that Pane writes to ~/.pane/bin at startup.
  drive: "cli",
  // ADES.md 3.18: "Data to move aside | ~/.pane and ~/Library/Application Support/Pane".
  dataDirs: ["~/.pane", "~/Library/Application Support/Pane"],
  launchAgents: [],
  vendorDirs: ["~/.pane", "~/Library/Application Support/Pane"],
  teamId: "FBM5YSF467",
});

// Every launch registers a user-scoped `pane` MCP server with `claude mcp add` (main/src/services/paneMcpRegistration.ts).
// It lives in ~/.claude.json, which the clean snapshot does not restore, so without this the next block's bare control
// and every later ADE would load Pane's MCP tools. Pane adds it again at its next launch, so its own rows keep it.
const quitApp = pane.quit;
pane.quit = async (ctx) => {
  await quitApp(ctx);
  try {
    runTool(ctx, ["claude", "mcp", "remove", "pane", "--scope", "user"]);
  } catch (error) {
    // Exit 1 when no entry exists: nothing to remove.
    ctx.log(`quit: pane MCP entry not removed: ${error instanceof Error ? error.message : String(error)}`);
  }
};
