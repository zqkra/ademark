// EL-SDK: Claude Agent SDK and `codex app-server` (ADES.md 3.1).
import { basename, join } from "node:path";
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
  runTool,
  setJsonKeys,
  setenv,
  waitForPid,
  waitGone,
  writeTextFile,
  type PidHints,
} from "./macos.ts";
import { waitForEndOfTurn, type SessionAgent } from "./session-log.ts";
import { checkApp, cleanSnapshotDir, missingValue, planMessage, processHints } from "./support.ts";
import { AGENT_EXECUTABLES } from "../core/agents.ts";

const APP_NAME = "T3 Code (Beta)";
const APP_PATH = `/Applications/${APP_NAME}.app`;
const BUNDLE_ID = "com.t3tools.t3code";
const VENDOR_DIR = "~/.t3";
const TELEMETRY_ENV = "T3CODE_TELEMETRY_ENABLED";
const APP_LAUNCH_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 10_000;
const WINDOW = { w: 1600, h: 1000 };
const NEW_THREAD_WORDING = 'ADES.md 3.1: "New thread (A3) | unknown, find in pilot"';
const T3_CLI = "~/.t3/bin/t3";
const PROJECT_SETTLE_MS = 3_000;
// `t3 app` right after launch reports success and selects nothing: the app stays on "Choose a project", Cmd+N opens no thread
// and every key is lost. Checked 2026-11-07 from a clean seed: lost at 0 s, working at 8 s.
const APP_BOOT_MS = 8_000;
// Server settings the app reads at start (ServerSettings in app.asar, T3 Code 0.1.0). Pilot 2026-10-20: written here,
// a new thread showed Claude Opus 5.5, High, Full access and New worktree, and the reply came from a fresh worktree.
const SETTINGS_PATH = "~/.t3/userdata/settings.json";
const SEED_PATHS = [".t3/userdata"];
const CLIENT_SETTINGS = "~/.t3/userdata/client-settings.json";
// Pilot 2026-10-20: the factory `sidebarThreadSortOrder: updated_at` moves a thread when it is opened or answered, so
// `thread.jump.N` (cmd+1 ... cmd+9) would open a different thread each A11 rep. `created_at` keeps the order fixed.
const CLIENT_SETTINGS_FIXED = { sidebarThreadSortOrder: "created_at" };

const APP_HINTS: PidHints = { bundlePaths: [APP_PATH], names: [APP_NAME] };
// The `t3` server is a child of the app; `t3 service install` would keep it alive after quit.
const SERVER_HINTS: PidHints = { names: ["t3"] };

export interface T3CodeCalibration {
  newThreadShortcut: string | null;
}

// ADES.md 3.1 marks the new-thread shortcut as unknown. Pilot 2026-10-20: `mod+n` is bound to `chat.new` in
// ~/.t3/userdata/keybindings.json, and Cmd+N from ademark-native opened a new thread with the composer focused.
export const calibration: T3CodeCalibration = { newThreadShortcut: "cmd+n" };

// The thread mode, model and effort of new threads (TESTS.md A3 default-mode; METHODOLOGY.md 4 pins).
// `newWorktreesStartFromOrigin` is off because the arena copy has no remote: from origin/main a worktree cannot start.
export function serverSettings(agent: SessionAgent, model: string | null, effort: string | null): string {
  const instanceId = agent === "codex" ? "codex" : "claudeAgent";
  // Claude's option id is `effort` (~/.t3/caches/claudeAgent.json); Codex's is `reasoningEffort`, as in
  // textGenerationModelSelection's factory default.
  const effortId = agent === "codex" ? "reasoningEffort" : "effort";
  const selection: Record<string, unknown> = { instanceId, model };
  if (effort !== null) selection.options = [{ id: effortId, value: effort }];
  const settings = {
    defaultModelSelection: model === null ? null : selection,
    // 2026-11-08: titles and branch names ran on T3 Code's factory default, Codex, which has no account here. Each job
    // waited about 75 s, only 3 ran at once, and the A7 turns behind them started 72 s late. They now use the pinned
    // agent and model, like every other call of the run.
    ...(model === null ? {} : { textGenerationModelSelection: selection }),
    defaultRuntimeMode: "full-access",
    defaultThreadEnvMode: "worktree",
    newWorktreesStartFromOrigin: false,
    enableProviderUpdateChecks: false,
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export interface T3CodeState {
  agent: SessionAgent;
  model: string | null;
  effort: string | null;
  pid: number | null;
  since: number;
}

export const state: T3CodeState = { agent: "claude", model: null, effort: null, pid: null, since: 0 };

function pidOrZero(): number {
  return state.pid ?? 0;
}

function setTelemetry(ctx: AdapterContext): void {
  setenv(ctx, TELEMETRY_ENV, "false");
}

export const t3code: Adapter = {
  id: "t3code",
  name: "T3 Code",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  calibration: {
    // ADES.md 3.1: "On bench Mac | yes, 0.1.0 (`T3 Code (Beta).app`)".
    appName: APP_NAME,
    bundleId: BUNDLE_ID,
    // An empty thread centres the composer; its first line is here. A1, A2 and A3 all open on this view (New thread).
    // Measured 2026-11-10 on T3 Code 0.1.8, window 1600 x 1000 points, on the night's videos
    // (control-2026-11-10T08-31-19Z-t3code-1/t3code/A3/rep-02/video.mov at 0.2 s and 4 s, A1 and A2 rep-02 at the end):
    // the box is x 541 to 1275, y 446 to 556 with one line, whose text sits at y 472; with three lines the box grows up
    // and the first line sits at y 461. "or start without a project" ends at y 423 and the model row starts at y 524.
    // y 448 to 496 holds both first lines with about 10 points of margin. The pilot's y 440 to 476 (0.1.0) cut the line at
    // y 472 in half, so the probe was read only at 88 characters (ADEMARK-55).
    composerRect: { x: 548, y: 448, w: 720, h: 48 },
    // Once the thread has a message the composer docks at the bottom.
    // 2026-11-08 (A8 "no probes"): the docked composer's first line sits at y about 897; y 848 caught only its border.
    activeComposerRect: { x: 545, y: 880, w: 720, h: 36 },
    // Messages column, left of the floating project panel at the top right.
    threadRect: { x: 270, y: 60, w: 1020, h: 760 },
    // The new composer has focus after Cmd+N and at launch, so no click.
    focusClick: null,
    // The floating project panel (host, branch, changes counter) updates on its own.
    masks: [{ x: 1300, y: 60, w: 300, h: 240 }],
    // ADES.md 3.1: drive is the `t3` CLI, WebSocket server and CDP; TESTS.md 0.1 shows `cdp` for this ADE.
    drive: "cdp",
    // ADES.md 3.1: "Data to move aside | ~/.t3/userdata (`state.sqlite`)".
    dataDirs: ["~/.t3/userdata"],
    // ADES.md 3.1: the `t3` server is a child of the app unless `t3 service install` is used.
    launchAgents: [],
  },
  login: { kind: "agent-cli", files: [], signIn: null },
  get timed(): Adapter["timed"] {
    // A3 needs the app's own shortcut; uncalibrated means no honest trigger to post (missing-value rule).
    const newThread: Trigger[] =
      calibration.newThreadShortcut === null ? [] : [{ kind: "keys", combo: calibration.newThreadShortcut }];
    return {
      launch: [{ kind: "open", bundleId: BUNDLE_ID }],
      newThread,
      send: [{ kind: "enter" }],
      // A11: `thread.jump.N` in ~/.t3/userdata/keybindings.json follows the sidebar, newest created first
      // (CLIENT_SETTINGS_FIXED). The long thread is built last, so it is first; the next is an A10 "Seeded" thread.
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
    const servers = await pidsFor(ctx, SERVER_HINTS);
    if (!ctx.dryRun && servers.length > 0) {
      throw new Error(`t3 server survived reset: ${servers.join(", ")}`);
    }
    moveAside(ctx, "t3code", ["~/.t3/userdata"]);
    restoreSeed(ctx, "t3code", SEED_PATHS);
    setJsonKeys(ctx, CLIENT_SETTINGS, CLIENT_SETTINGS_FIXED);
    const dir = cleanSnapshotDir();
    if (ctx.dryRun) ctx.log(planMessage("restoreSnapshot", [dir, "(apply)"]));
    else restore(dir, ctx.home, { apply: true });
  },
  async configure(ctx: AdapterContext, options: RunOptions): Promise<void> {
    isRealRun(ctx);
    if (options.agent === "own") throw new Error("T3 Code runs Claude and Codex only (ADES.md 3.1)");
    state.agent = options.agent;
    state.model = options.model;
    state.effort = options.effort;
    setTelemetry(ctx);
    writeTextFile(ctx, SETTINGS_PATH, serverSettings(options.agent, options.model, options.effort));
    // RUNBOOK.md 7.1 step 8: the arena copy is a project in the ADE before the block starts. Pilot 2026-10-20:
    // `t3 project add` works with the app closed (0.4 s).
    runTool(ctx, [T3_CLI, "project", "add", "--title", "arena", ctx.worktree]);
    // Track C configures a fresh arena while the app is open; Cmd+N opens a thread in the selected project, so select it.
    if ((await pidsFor(ctx, APP_HINTS)).length > 0) runTool(ctx, [T3_CLI, "app", ctx.worktree]);
  },
  async launch(ctx: AdapterContext): Promise<{ pid: number }> {
    isRealRun(ctx);
    for (const name of Object.keys(ctx.env).sort()) setenv(ctx, name, ctx.env[name]!);
    setTelemetry(ctx);
    openBundle(ctx, BUNDLE_ID);
    const pid = await waitForPid(ctx, APP_HINTS, APP_LAUNCH_TIMEOUT_MS);
    if (!ctx.dryRun && pid === null) throw new Error(`${APP_NAME} did not start within 30 s`);
    state.pid = pid;
    await resizeWindow(ctx, pidOrZero(), WINDOW);
    // Pilot 2026-10-20: a project added with the app closed is listed but not selected ("Choose a project to start"),
    // and Cmd+N then opens no thread. `t3 app <path>` selects it in the running app.
    await pause(ctx, APP_BOOT_MS);
    runTool(ctx, [T3_CLI, "app", ctx.worktree]);
    await pause(ctx, PROJECT_SETTLE_MS);
    return { pid: pidOrZero() };
  },
  async newThread(ctx: AdapterContext): Promise<void> {
    isRealRun(ctx);
    const shortcut =
      calibration.newThreadShortcut ??
      missingValue(ctx, "newThreadShortcut", NEW_THREAD_WORDING, "<newThreadShortcut>");
    await press(ctx, pidOrZero(), shortcut);
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
    return waitForEndOfTurn({
      ctx,
      agent: state.agent,
      cwd: ctx.worktree,
      since: state.since || Date.now(),
      timeoutMs,
      pollMs: 2000,
      // Pilot 2026-10-20: each thread runs in its own worktree, ~/.t3/worktrees/<project folder name>/<branch>, and the
      // Claude session log carries that cwd, not the arena's.
      cwdPrefix: join(ctx.home, ".t3", "worktrees", basename(ctx.worktree)),
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
  // ADES.md 3.1: Electron set plus the `t3` server.
  processes: () =>
    processHints({ bundlePaths: [APP_PATH], vendorDirs: [VENDOR_DIR], agentExecutables: [...AGENT_EXECUTABLES] }),
};
