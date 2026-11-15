// EL-SDK: a new session runs Claude in Chat through the bundled claude-agent-acp; a session can switch to the
// Claude TUI in a PTY (ADES.md 3.18).
import { basename } from "node:path";
import type { AdapterContext, RunOptions } from "../core/contracts.ts";
import { mainPid, pause, press, runTool } from "./macos.ts";
import { runSteps } from "./profile-steps.ts";
import { profileAdapter } from "./profile.ts";

export const orchestratorInc = profileAdapter({
  id: "orchestrator-inc",
  name: "Orchestrator",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  // ADES.md 3.18: the bundle is "Agent Orchestrator.app".
  appName: "Agent Orchestrator",
  bundleId: "dev.agent-orchestrator.desktop",
  // ADES.md 3.18: setup through the `ao` CLI in the bundle.
  drive: "cli",
  // ADES.md 3.18: "Data to move aside | ~/.ao". It holds the Electron userData (~/.ao/electron), the daemon data
  // (~/.ao/data: ao.db, worktrees, telemetry marker) and app-state.json.
  dataDirs: ["~/.ao"],
  launchAgents: [],
  vendorDirs: ["~/.ao"],
  teamId: "X9LNSP8MC2",
});

const APP = { bundlePaths: ["/Applications/Agent Orchestrator.app"] };
const AO = "/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao";
const HARNESS = { claude: "claude-code", codex: "codex" } as const;
// Cmd+Shift+O opens the project's orchestrator session and creates it on first use (frontend/src/shared/shortcuts.ts).
const ORCHESTRATOR_KEYS = "cmd+shift+o";
// The orchestrator session starts in its own worktree before its composer shows. Untimed for A and B: only C1 uses it.
const ORCHESTRATOR_SETTLE_MS = 8000;
const PROJECT_SETTLE_MS = 1000;

// One Orchestrator project per arena folder. Track C makes a new arena per task (orchestrator-inc-C1-1 and so on) in
// the same ~/.ao, and an explicit id that is registered for another path is refused (ID_ALREADY_REGISTERED), so the id
// comes from the folder name.
export function projectIdFor(worktree: string): string {
  const id = basename(worktree).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return id.length > 0 ? id : "arena";
}

// What every new session in the project starts with (METHODOLOGY.md §4): the role agents, the pinned model and effort,
// and full access. Without a saved permission a new Chat session starts in Claude Code's auto mode
// (backend/internal/session_manager/manager.go). Workers the orchestrator spawns inherit its permissions.
export function projectConfigFor(options: Pick<RunOptions, "agent" | "model" | "effort">): Record<string, unknown> {
  const agent = options.agent === "codex" ? HARNESS.codex : HARNESS.claude;
  return {
    agentConfig: { model: options.model, effort: options.effort, permissions: "bypass-permissions" },
    worker: { agent },
    orchestrator: { agent },
  };
}

let options: Pick<RunOptions, "agent" | "model" | "effort"> | null = null;
let project: string | null = null;

// Untimed setup, once per arena: register the folder, write its config, and open it in the window so Cmd+N
// (New Task) and Cmd+Shift+O (orchestrator) act on it.
async function openArena(ctx: AdapterContext): Promise<void> {
  if (project === ctx.worktree) return;
  if (options === null) throw new Error("orchestrator-inc: configure must run before the arena is opened");
  const id = projectIdFor(ctx.worktree);
  let registered = false;
  try {
    runTool(ctx, [AO, "project", "get", id]);
    registered = !ctx.dryRun;
  } catch {
    // Exit 1 when the project does not exist yet.
  }
  if (!registered) runTool(ctx, [AO, "project", "add", "--path", ctx.worktree, "--id", id, "--name", id]);
  runTool(ctx, [AO, "project", "set-config", id, "--config-json", JSON.stringify(projectConfigFor(options))]);
  const pid = ctx.dryRun ? 0 : ((await mainPid(ctx, APP)) ?? 0);
  await runSteps(
    ctx,
    pid,
    [
      {
        kind: "goal",
        maxActions: 6,
        goal: `The window shows Orchestrator's home page or a project. Open the project named '${id}' by clicking it in the sidebar or the project list, so that project is in front. Do not start a session and do not type anything.`,
      },
      { kind: "wait", ms: PROJECT_SETTLE_MS },
    ],
    { worktree: ctx.worktree, home: ctx.home, model: options.model, effort: options.effort, agent: options.agent },
    "orchestrator-inc.openArena",
  );
  project = ctx.worktree;
}

const resetApp = orchestratorInc.reset;
orchestratorInc.reset = async (ctx) => {
  await resetApp(ctx);
  project = null;
};

const configureApp = orchestratorInc.configure;
orchestratorInc.configure = async (ctx, runOptions) => {
  options = { agent: runOptions.agent, model: runOptions.model, effort: runOptions.effort };
  await configureApp(ctx, runOptions);
  // The base configure opens the arena only while the app runs; otherwise launch does it.
  if (ctx.dryRun || (await mainPid(ctx, APP)) !== null) await openArena(ctx);
};

const launchApp = orchestratorInc.launch;
orchestratorInc.launch = async (ctx) => {
  const launched = await launchApp(ctx);
  // A relaunch (A1, A2, C6) keeps ~/.ao, so the project is still registered and only the window needs it again.
  project = null;
  await openArena(ctx);
  return launched;
};

// C1 (TASKS.md §1 rule 4): Orchestrator's orchestration is its orchestrator session, which spawns worker sessions with
// `ao spawn` (backend/internal/session_manager/prompt.go). A New Task session is a worker, and a worker is told not to
// fan out on its own. So the C1 prompt, which starts with the trigger line, goes to the orchestrator session. Every
// other prompt stays in the New Task composer that newThread opened.
const sendText = orchestratorInc.send;
orchestratorInc.send = async (ctx, text) => {
  const trigger = orchestratorInc.orchestrationTrigger;
  if (typeof trigger === "string" && text.startsWith(`${trigger}\n`)) {
    const pid = ctx.dryRun ? 0 : ((await mainPid(ctx, APP)) ?? 0);
    await press(ctx, pid, ORCHESTRATOR_KEYS);
    await pause(ctx, ORCHESTRATOR_SETTLE_MS);
  }
  await sendText(ctx, text);
};
