// NATIVE: Rust, GPUI; `claude -p` stream-json and `codex app-server` (ADES.md 3.10).
import { relative, sep } from "node:path";
import type { Adapter, AdapterContext, RunOptions, Trigger } from "../core/contracts.ts";
import { restore } from "../core/snapshot.ts";
import {
  isRealRun,
  killPids,
  moveAside,
  openBundle,
  paste,
  pause,
  pidsFor,
  press,
  quitApp,
  resizeWindow,
  restoreSeed,
  setJsonKeys,
  setenv,
  typeText,
  waitForPid,
  waitGone,
  type PidHints,
} from "./macos.ts";
import { waitForEndOfTurn, type SessionAgent } from "./session-log.ts";
import { checkApp, cleanSnapshotDir, missingValue, planMessage, processHints } from "./support.ts";
import { AGENT_EXECUTABLES } from "../core/agents.ts";

const APP_NAME = "Zeron";
const APP_PATH = "/Applications/Zeron.app";
// Read from the installed bundle in the pilot (2026-10-20); ADES.md 3.10 did not state it.
const BUNDLE_ID = "sh.zeron.app";
const APP_LAUNCH_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 10_000;
const WINDOW = { w: 1600, h: 1000 };
// ADES.md 3.10: data in ~/.zeron/profiles/local, worktrees in ~/.zeron/worktrees. The device id and UI settings next to
// them stay, so the device does not change between blocks.
const DATA_DIRS = ["~/.zeron/profiles/local", "~/.zeron/worktrees"];
const SEED_PATHS = [".zeron/profiles/local"];
const CODEX_WORDING = "ADES.md 3.10: Codex model and effort in the model picker; Codex is not signed in yet";
const STEP_MS = 700;
const UI_SETTINGS = "~/.zeron/ui-settings.json";
// Pilot 2026-10-20: with the factory `sidebarSort: lastUpdated`, viewing a session bumps it up a moment later, so
// `jumpSession` (cmd+1, cmd+2) opened a different session in each A11 rep. `created` keeps the order fixed.
const UI_SETTINGS_FIXED = { sidebarSort: "created" };

const APP_HINTS: PidHints = { bundlePaths: [APP_PATH], names: ["zeron"] };

// Pilot 2026-10-20 (results/pilot/findings.md), Zeron 0.2.114 at 1600 x 1000 points.
export const calibration = {
  // `newSession: mod-n` in ~/.zeron/ui-settings.json.
  newThreadShortcut: "cmd+n",
  // `newProject: mod-shift-n` opens a device picker, then a locations list (Home first, then the drives), then a folder
  // browser: typing filters the current folder, Enter opens the highlighted folder, Cmd+Enter adds the folder being
  // browsed (not the highlighted one) as the project. A full path typed in the search finds nothing.
  newProjectShortcut: "cmd+shift+n",
  addProjectKeys: "cmd+enter",
};

export interface ZeronState {
  agent: SessionAgent;
  model: string | null;
  effort: string | null;
  pid: number | null;
  since: number;
  // The project folder added in this app session, so a relaunch in the same block does not add it again.
  project: string | null;
}

export const state: ZeronState = { agent: "claude", model: null, effort: null, pid: null, since: 0, project: null };

function pidOrZero(): number {
  return state.pid ?? 0;
}

// The folder browser lists one level at a time and filters by name, so the path is walked from Home.
export function projectSteps(home: string, folder: string): string[] {
  const rel = relative(home, folder);
  if (rel === "" || rel.startsWith("..")) throw new Error(`Zeron projects are added from Home; ${folder} is outside it`);
  return rel.split(sep);
}

async function addProject(ctx: AdapterContext, folder: string): Promise<void> {
  const pid = pidOrZero();
  await press(ctx, pid, calibration.newProjectShortcut);
  await pause(ctx, STEP_MS);
  // The only device, this Mac (ADES.md 3.10 "Local only").
  await press(ctx, pid, "enter");
  await pause(ctx, STEP_MS);
  // The locations list starts on Home (then the drives).
  await press(ctx, pid, "enter");
  await pause(ctx, STEP_MS);
  for (const name of projectSteps(ctx.home, folder)) {
    await typeText(ctx, pid, name);
    await pause(ctx, STEP_MS);
    await press(ctx, pid, "enter");
    await pause(ctx, STEP_MS);
  }
  await press(ctx, pid, calibration.addProjectKeys);
  await pause(ctx, STEP_MS);
  state.project = folder;
}

export const zeron: Adapter = {
  id: "zeron",
  name: "Zeron",
  family: "NATIVE",
  agents: ["claude", "codex"],
  calibration: {
    appName: APP_NAME,
    bundleId: BUNDLE_ID,
    // A new session centres the composer; its first line is here.
    composerRect: { x: 575, y: 440, w: 700, h: 36 },
    // With messages the composer is one line at the bottom, left of the model label.
    activeComposerRect: { x: 595, y: 920, w: 520, h: 30 },
    // It reopens the last session, so at launch the composer is the bottom one.
    launchComposerRect: { x: 595, y: 920, w: 520, h: 30 },
    // Messages column, left of the chat panel at the top right.
    threadRect: { x: 270, y: 50, w: 1030, h: 840 },
    // The composer has focus in a new session.
    focusClick: null,
    // The chat panel (device, project, actions) and the usage rings under the composer update on their own.
    masks: [
      { x: 1310, y: 45, w: 290, h: 270 },
      { x: 1170, y: 960, w: 130, h: 36 },
    ],
    // ADES.md 3.10: drive is the `zeron` CLI, `zeron mcp`, WebSocket RPC and the zeron:// scheme. No CDP. Setup here
    // drives the UI with keys, because none of those adds a project.
    drive: "keys",
    dataDirs: DATA_DIRS,
    launchAgents: [],
  },
  login: { kind: "agent-cli", files: [], signIn: null },
  get timed(): Adapter["timed"] {
    return {
      launch: [{ kind: "open", bundleId: BUNDLE_ID }],
      newThread: [{ kind: "keys", combo: calibration.newThreadShortcut }],
      send: [{ kind: "enter" }],
      // A11: `jumpSession: mod-1 ... mod-9` follows the sidebar, newest created first (UI_SETTINGS_FIXED). The long
      // thread is built last, so it is first; the next one is an A10 thread that holds the seed answer.
      longThread: [{ kind: "keys", combo: "cmd+1" }],
      shortThread: [{ kind: "keys", combo: "cmd+2" }],
    };
  },
  installCheck: () => checkApp(APP_NAME, APP_PATH),
  async reset(ctx: AdapterContext): Promise<void> {
    isRealRun(ctx);
    const appPids = await pidsFor(ctx, APP_HINTS);
    quitApp(ctx, APP_NAME);
    const alive = await waitGone(ctx, appPids, QUIT_TIMEOUT_MS);
    killPids(ctx, alive);
    setJsonKeys(ctx, UI_SETTINGS, UI_SETTINGS_FIXED);
    moveAside(ctx, "zeron", DATA_DIRS);
    restoreSeed(ctx, "zeron", SEED_PATHS);
    state.project = null;
    const dir = cleanSnapshotDir();
    if (ctx.dryRun) ctx.log(planMessage("restoreSnapshot", [dir, "(apply)"]));
    else restore(dir, ctx.home, { apply: true });
  },
  async configure(ctx: AdapterContext, options: RunOptions): Promise<void> {
    isRealRun(ctx);
    if (options.agent === "own") throw new Error("Zeron runs Claude and Codex only (ADES.md 3.10)");
    state.agent = options.agent;
    state.model = options.model;
    state.effort = options.effort;
    // Pilot: a new Claude session already starts `claude --model claude-opus-5-5 --effort high` (the pinned pair), and
    // permissions are factory. Codex needs the model picker, which is not calibrated yet.
    if (options.agent === "codex") missingValue(ctx, "codexModel", CODEX_WORDING);
    // Track C configures a fresh arena while the app is open; at block start the project is added after launch.
    if ((await pidsFor(ctx, APP_HINTS)).length > 0 && state.project !== ctx.worktree) {
      await addProject(ctx, ctx.worktree);
    }
  },
  async launch(ctx: AdapterContext): Promise<{ pid: number }> {
    isRealRun(ctx);
    for (const name of Object.keys(ctx.env).sort()) setenv(ctx, name, ctx.env[name]!);
    openBundle(ctx, BUNDLE_ID);
    const pid = await waitForPid(ctx, APP_HINTS, APP_LAUNCH_TIMEOUT_MS);
    if (!ctx.dryRun && pid === null) throw new Error(`${APP_NAME} did not start within 30 s`);
    state.pid = pid;
    await resizeWindow(ctx, pidOrZero(), WINDOW);
    if (state.project !== ctx.worktree) await addProject(ctx, ctx.worktree);
    return { pid: pidOrZero() };
  },
  async newThread(ctx: AdapterContext): Promise<void> {
    isRealRun(ctx);
    await press(ctx, pidOrZero(), calibration.newThreadShortcut);
    state.since = Date.now();
  },
  async send(ctx: AdapterContext, text: string): Promise<void> {
    isRealRun(ctx);
    state.since = Date.now();
    await paste(ctx, pidOrZero(), text);
    await press(ctx, pidOrZero(), "enter");
  },
  async waitDone(ctx: AdapterContext, timeoutMs: number): Promise<{ done: boolean; reason: string }> {
    isRealRun(ctx);
    if (ctx.dryRun) {
      ctx.log(
        planMessage("waitForEndOfTurn", [`agent=${state.agent}`, `cwd=${ctx.worktree}`, `timeoutMs=${timeoutMs}`]),
      );
      return { done: true, reason: "dry run" };
    }
    // Pilot: Claude runs in the project folder itself, so its session log is under that cwd.
    return waitForEndOfTurn({
      ctx,
      agent: state.agent,
      cwd: ctx.worktree,
      since: state.since || Date.now(),
      timeoutMs,
      pollMs: 2000,
      idleFallback: false,
    });
  },
  async quit(ctx: AdapterContext): Promise<void> {
    isRealRun(ctx);
    const appPids = await pidsFor(ctx, APP_HINTS);
    quitApp(ctx, APP_NAME);
    const alive = await waitGone(ctx, appPids, QUIT_TIMEOUT_MS);
    if (!ctx.dryRun) {
      const list = alive.length === 0 ? "none" : alive.join(",");
      ctx.log(`quit: attributed processes still alive after ${QUIT_TIMEOUT_MS / 1000} s: ${list}`);
    }
  },
  // ADES.md 3.10: the app (engine in-process) plus claude and codex children. Pilot: a second `claude --model
  // claude-haiku-...` titles each chat.
  processes: () =>
    processHints({ bundlePaths: [APP_PATH], vendorDirs: ["~/.zeron"], agentExecutables: [...AGENT_EXECUTABLES] }),
};
