// EL-PTY: official CLI in node-pty, TUI mode (ADES.md 3.9).
import { statSync } from "node:fs";
import type { AdapterContext, Point } from "../core/contracts.ts";
import { click, mainPid, pause, press, waitGone } from "./macos.ts";
import { profileAdapter } from "./profile.ts";
import { findSessionLogs, type SessionAgent } from "./session-log.ts";

const APP = { bundlePaths: ["/Applications/Emdash.app"] };

// Create Task starts on "Create new worktree" and no setting changes that, so a task would run in
// ~/emdash/worktrees/<project>/<task>, where Track B finds no session log and Track C finds no files. These window points
// open Workspace Settings, pick "Use the repository directory", and return to the prompt box of the Initial Conversation
// tab. They live here and not in timed.newThread, because A3 times those triggers.
const REPOSITORY_DIRECTORY: readonly Point[] = [
  { x: 754, y: 469 },
  { x: 800, y: 517 },
  { x: 682, y: 630 },
  { x: 623, y: 487 },
  { x: 770, y: 573 },
];
const MODAL_SETTLE_MS = 400;

// The sidebar project row, the project page. cmd+n opens the modal over the view behind it, and over the last task the
// thread rect still shows that task's answer: A4 reads the previous rep's LEDGERMARK in the first frame after t0 and ends
// before the request comes. The project page lists task names only. Clicking the row never collapses the project. It is
// clicked twice because A3 leaves its modal open, and with a modal open the first click only closes it.
const PROJECT_PAGE: readonly Point[] = [
  { x: 75, y: 100 },
  { x: 75, y: 100 },
];
const PROJECT_PAGE_SETTLE_MS = 800;

// Sidebar Settings, the Privacy & Telemetry switch, Go back (ADES.md 3.9 pin). It is a toggle stored in emdash4.db, so it
// is clicked once per reset: a9 launches again on the same data, and a second click would turn telemetry back on.
const TELEMETRY_OFF: readonly Point[] = [
  { x: 75, y: 932 },
  { x: 1404, y: 470 },
  { x: 231, y: 20 },
];
const SETTINGS_SETTLE_MS = 1200;

// With an agent session alive, quit asks "Quit Emdash?" and Cancel holds the focus, so the Return of the profile adapter's
// quit cancels it. cmd+enter is the dialog's Quit. With no session the app is gone before the dialog wait ends.
const QUIT_DIALOG_MS = 1500;
const QUIT_TIMEOUT_MS = 10_000;

// Every task runs in the repository directory, so the default waitDone also sees the A10 streams still running in their
// own tasks, and the end of one of them ended the wait for the long A11 thread 33 s early. A task's first send starts a
// new session, so that wait counts only a log born after the send. A follow-up in the same task keeps the default wait.
const TURN_POLL_MS = 5000;

async function clickThrough(ctx: AdapterContext, points: readonly Point[], settleMs: number): Promise<void> {
  const pid = (await mainPid(ctx, APP)) ?? 0;
  for (const point of points) {
    await click(ctx, pid, point);
    await pause(ctx, settleMs);
  }
}

async function quitPastDialog(ctx: AdapterContext): Promise<void> {
  const pid = await mainPid(ctx, APP);
  if (pid === null) return;
  await press(ctx, pid, "cmd+q");
  await pause(ctx, QUIT_DIALOG_MS);
  if ((await mainPid(ctx, APP)) === null) return;
  await press(ctx, pid, "cmd+enter");
  await waitGone(ctx, [pid], QUIT_TIMEOUT_MS);
}

async function waitForOwnTurn(
  ctx: AdapterContext,
  agent: SessionAgent,
  sentAt: number,
  timeoutMs: number,
): Promise<{ done: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const logs = findSessionLogs({ home: ctx.home, agent, cwd: ctx.worktree, since: sentAt });
    const own = logs.find((log) => log.summary.ended && statSync(log.path).birthtimeMs >= sentAt);
    if (own !== undefined) {
      ctx.log(`waitDone: end of turn in ${own.path}`);
      return { done: true, reason: "end_turn" };
    }
    if (Date.now() >= deadline) return { done: false, reason: "timeout" };
    await pause(ctx, TURN_POLL_MS);
  }
}

export const emdash = profileAdapter({
  id: "emdash",
  name: "Emdash",
  family: "EL-PTY",
  agents: ["claude", "codex"],
  // ADES.md 3.9: "open -a with the app name read at install (not installed yet)".
  appName: "Emdash",
  // ADES.md 3.9: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.9: "no CLI, deep link or API found: CDP for setup, Accessibility and keystrokes otherwise".
  drive: "cdp",
  // ADES.md 3.9: "local SQLite (path unknown, find in pilot); worktrees in ~/emdash/worktrees".
  dataDirs: ["~/emdash/worktrees"],
  launchAgents: [],
  // ADES.md 3.9: Electron set plus node-pty agent processes.
  vendorDirs: ["~/emdash/worktrees"],
  // ADES.md 3.9: "Orchestration (C1) | not supported".
  orchestrationTrigger: null,
});

let freshData = false;
let agent: SessionAgent = "claude";
let taskOpened = false;
let taskSentAt: number | null = null;

const configureApp = emdash.configure;
emdash.configure = async (ctx, options) => {
  agent = options.agent === "codex" ? "codex" : "claude";
  await configureApp(ctx, options);
};

const resetData = emdash.reset;
emdash.reset = async (ctx) => {
  await quitPastDialog(ctx);
  await resetData(ctx);
  freshData = true;
};

const launchApp = emdash.launch;
emdash.launch = async (ctx) => {
  const launched = await launchApp(ctx);
  if (freshData) await clickThrough(ctx, TELEMETRY_OFF, SETTINGS_SETTLE_MS);
  freshData = false;
  return launched;
};

const openThread = emdash.newThread;
emdash.newThread = async (ctx) => {
  await clickThrough(ctx, PROJECT_PAGE, PROJECT_PAGE_SETTLE_MS);
  await openThread(ctx);
  await clickThrough(ctx, REPOSITORY_DIRECTORY, MODAL_SETTLE_MS);
  taskOpened = true;
};

const sendText = emdash.send;
emdash.send = async (ctx, text) => {
  taskSentAt = taskOpened ? Date.now() : null;
  taskOpened = false;
  await sendText(ctx, text);
};

const waitTurn = emdash.waitDone;
emdash.waitDone = async (ctx, timeoutMs) => {
  if (taskSentAt === null || ctx.dryRun) return waitTurn(ctx, timeoutMs);
  return waitForOwnTurn(ctx, agent, taskSentAt, timeoutMs);
};

const quitApp = emdash.quit;
emdash.quit = async (ctx) => {
  await quitPastDialog(ctx);
  await quitApp(ctx);
};
