// EL-PTY: official CLI in a PTY with `--dangerously-skip-permissions` (ADES.md 3.8).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext } from "../core/contracts.ts";
import { linkPath, removePath, runTool, writeTextFile } from "./macos.ts";
import { profileAdapter } from "./profile.ts";

const ORCA_CLI = "/Applications/Orca.app/Contents/Resources/bin/orca";
const SKILL_NAMES = ["orca-cli", "orchestration"];
// Paths the install adds, relative to the bench home. ~/.local/bin is first on the account's PATH; the skills
// land in ~/.agents/skills and are linked into ~/.claude/skills, both inside the clean snapshot's watch list.
const MARKER = ".config/ademark/orca-c1-installed.json";

// What each home got, keyed by home: back-to-back blocks share the process, and the marker alone cannot name
// paths a dry run only planned.
const installed = new Map<string, string[]>();

function skillPaths(home: string, agent: AdapterContext["agent"]): string[] {
  const shared = SKILL_NAMES.map((name) => join(home, ".agents", "skills", name));
  // `orca skills install --agent codex` writes only the shared .agents folder (its own --dry-run shows no
  // agent link); claude also links each skill into ~/.claude/skills. With no agent known, aim at both.
  if (agent === "codex") return shared;
  return [...shared, ...SKILL_NAMES.map((name) => join(home, ".claude", "skills", name))];
}

function markerPath(home: string): string {
  return join(home, MARKER);
}

function shimPath(home: string): string {
  return join(home, ".local", "bin", "orca");
}

function readMarker(home: string): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(markerPath(home), "utf8"));
    return Array.isArray(data) ? data.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

// Track C only: Orca's own orchestration is the bundled `orchestration` skill, which drives the `orca` CLI
// (`orca orchestration worker-start`). v1 sent /orchestration to a bare Claude Code, so Claude Code subagents
// did the build inside one client session and C1 was invalid. `orca skills install` is the vendor's own
// installer and needs no runtime; the shim puts `orca` on the agent's PATH for the block. The marker records
// exactly what was added so a crashed block is cleaned by the next reset or prepare.
async function installOrcaSkills(ctx: AdapterContext): Promise<void> {
  const targets = [...skillPaths(ctx.home, ctx.agent), shimPath(ctx.home)];
  const stale = new Set(readMarker(ctx.home));
  const fresh = targets.filter((path) => !existsSync(path));
  for (const path of stale) removePath(ctx, path);
  const marker = markerPath(ctx.home);
  if (existsSync(marker)) removePath(ctx, marker);

  const agent = ctx.agent === "claude" || ctx.agent === "codex" ? ctx.agent : "claude,codex";
  runTool(ctx, [ORCA_CLI, "skills", "install", "--skill", "orca-cli", "--skill", "orchestration", "--agent", agent]);
  if (!existsSync(shimPath(ctx.home)) || stale.has(shimPath(ctx.home))) {
    linkPath(ctx, shimPath(ctx.home), ORCA_CLI);
  }

  const ours = [...fresh, ...[...stale].filter((path) => targets.includes(path))];
  installed.set(ctx.home, ours);
  writeTextFile(ctx, marker, `${JSON.stringify(ours)}\n`);
}

// Removes exactly the paths the block added: the two skills in both homes, the PATH shim and the marker.
// A path that existed before the install is never touched.
function removeOrcaSkills(ctx: AdapterContext): void {
  const ours = new Set([...(installed.get(ctx.home) ?? []), ...readMarker(ctx.home)]);
  installed.delete(ctx.home);
  for (const path of ours) removePath(ctx, path);
  const marker = markerPath(ctx.home);
  if (existsSync(marker) || ours.size > 0) removePath(ctx, marker);
}

const base = profileAdapter({
  id: "orca",
  name: "Orca",
  family: "EL-PTY",
  agents: ["claude", "codex"],
  // ADES.md 3.8: "open -a with the app name read at install (not installed yet)".
  appName: "Orca",
  // ADES.md 3.8: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.8: drive is the `orca` CLI, the orca:// scheme and CDP (unverified).
  drive: "cli",
  // ADES.md 3.8: "Data to move aside | Electron userData folder (path unknown, find in pilot)".
  dataDirs: [],
  launchAgents: [],
  // ADES.md 3.8: Electron set plus PTY agent processes.
  vendorDirs: [],
});

const profilePrepare = base.prepareOrchestration;
Object.defineProperty(base, "prepareOrchestration", {
  value: async (ctx: AdapterContext): Promise<void> => {
    await profilePrepare?.(ctx);
    await installOrcaSkills(ctx);
  },
});

const profileReset = base.reset;
base.reset = async (ctx: AdapterContext): Promise<void> => {
  await removeOrcaSkills(ctx);
  await profileReset(ctx);
};

const profileQuit = base.quit;
base.quit = async (ctx: AdapterContext): Promise<void> => {
  try {
    await profileQuit(ctx);
  } finally {
    await removeOrcaSkills(ctx);
  }
};

export const orca = base;
