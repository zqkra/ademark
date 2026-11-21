// EL-PTY: official CLI in node-pty, plus a persistent pty-daemon (ADES.md 3.7).
import type { AdapterContext, AdeProfile } from "../core/contracts.ts";
import { CLAUDE_SETTINGS_ENV_KEYS, syncClaudeSettingsEnv, trustClaudeFolder, trustClaudeTree } from "./macos.ts";
import { loadProfile, profileAdapter } from "./profile.ts";

const adapter = profileAdapter({
  id: "superset",
  name: "Superset",
  family: "EL-PTY",
  agents: ["claude", "codex"],
  // ADES.md 3.7: "open -a with the app name read at install (not installed yet)".
  appName: "Superset",
  // ADES.md 3.7: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.7: drive is the `superset` CLI, deep links, hosted MCP server, SDK and CDP (unverified).
  drive: "cli",
  // ADES.md 3.7: "Data to move aside | ~/.superset/ (worktrees, sessions, bin); app database path unknown".
  dataDirs: ["~/.superset"],
  // ADES.md 3.7: the pty-daemon may survive quit; its launch-agent label is unknown.
  launchAgents: [],
  // ADES.md 3.7: Electron set, pty-daemon, CLI processes.
  vendorDirs: ["~/.superset"],
  // ADES.md 3.7: "New thread (A3) | ⌘N creates a worktree and branch under ~/.superset/worktrees".
  timed: { launch: [], newThread: [{ kind: "keys", combo: "cmd+n" }], send: [] },
});

// 2.0.8 filters the terminal environment (ALLOWED_ENV_VARS plus the SUPERSET_ and LC_ prefixes), so the launchd
// ANTHROPIC_BASE_URL of a Track A block never reaches the workspace's claude. Claude Code applies the "env" object of
// ~/.claude/settings.json to every session it starts, so the replay URL goes there instead, and the next block's
// sync removes it for the live tracks.
function syncClaudeEnv(ctx: AdapterContext): void {
  const values: Record<string, string> = {};
  for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
    const value = ctx.env[key];
    if (value !== undefined) values[key] = value;
  }
  syncClaudeSettingsEnv(ctx, CLAUDE_SETTINGS_ENV_KEYS, values);
}

// Every workspace is a new git worktree and Claude Code asks trust for each new repo root, so the worktrees under the
// profile's claudeTrustScanDirs are rescanned while the app runs (profile.ts note, BLOCKER 2).
const TRUST_SCAN_MS = 250;
const TRUST_MAX_DEPTH = 3;
const trustedSeen = new Set<string>();
let trustTimer: ReturnType<typeof setInterval> | null = null;
let scanProfile: AdeProfile | null | undefined;

function scanDirs(): string[] {
  if (scanProfile === undefined) {
    try {
      scanProfile = loadProfile(adapter.id);
    } catch {
      scanProfile = null;
    }
  }
  return scanProfile?.claudeTrustScanDirs ?? [];
}

function scanTrustDirs(ctx: AdapterContext): void {
  try {
    trustClaudeTree(ctx, scanDirs(), trustedSeen, TRUST_MAX_DEPTH);
  } catch (error) {
    ctx.log(`trust scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function startTrustScan(ctx: AdapterContext): void {
  if (ctx.dryRun || scanDirs().length === 0) return;
  stopTrustScan();
  scanTrustDirs(ctx);
  trustTimer = setInterval(() => scanTrustDirs(ctx), TRUST_SCAN_MS);
  trustTimer.unref?.();
}

function stopTrustScan(): void {
  if (trustTimer !== null) {
    clearInterval(trustTimer);
    trustTimer = null;
  }
}

const resetApp = adapter.reset;
adapter.reset = async (ctx) => {
  stopTrustScan();
  await resetApp(ctx);
};

const configureApp = adapter.configure;
adapter.configure = async (ctx, options) => {
  await configureApp(ctx, options);
  trustClaudeFolder(ctx, ctx.worktree);
  scanTrustDirs(ctx);
};

const launchApp = adapter.launch;
adapter.launch = async (ctx) => {
  const launched = await launchApp(ctx);
  syncClaudeEnv(ctx);
  startTrustScan(ctx);
  return launched;
};

const sendText = adapter.send;
adapter.send = async (ctx, text) => {
  syncClaudeEnv(ctx);
  await sendText(ctx, text);
};

const quitApp = adapter.quit;
adapter.quit = async (ctx) => {
  stopTrustScan();
  await quitApp(ctx);
  // ctx.env still holds this block's replay URL on Track A: the cleanup passes an empty map on purpose.
  syncClaudeSettingsEnv(ctx, CLAUDE_SETTINGS_ENV_KEYS, {});
};

export { adapter as superset };
