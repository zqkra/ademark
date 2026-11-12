// EL-SDK: Electron app plus a background Host service (ADES.md 3.5).
import { click, pause, waitForText } from "./macos.ts";
import { profileAdapter } from "./profile.ts";

// The Start Page composer takes keys about 300 ms after cmd+n, and A4 types right after newThread(). The wait lives here
// and not in timed.newThread, because A3 times those triggers.
const COMPOSER_READY_MS = 800;

// Checked 2026-11-07 on 1.5.3: when a turn's items arrive faster than the Task view scrolls (long-2000 writes 2,000 at
// once), the view stops following the end, stays near step 60 to 140 and shows a "New Reply" button above the composer.
// A tab keeps that position, so A11's open never saw LONGTHREAD-END. A click on the button jumps to the end, and the tab
// then reopens there. The button shows only when the view is away from the end, so the click is made only when OCR sees
// it: a blind click would take the focus from the composer that send() pastes into.
const NEW_REPLY_REGION = { x: 880, y: 720, w: 240, h: 52 };
const NEW_REPLY_POINT = { x: 988, y: 746 };
const NEW_REPLY_TRIES = 3;
const NEW_REPLY_WATCH_S = 3;
const NEW_REPLY_SETTLE_MS = 1500;

export const traycer = profileAdapter({
  id: "traycer",
  name: "Traycer",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  // ADES.md 3.5: "open -a with the app name read at install (not installed yet)".
  appName: "Traycer",
  // ADES.md 3.5: bundle id not stated; read it from the installed bundle.
  bundleId: null,
  // ADES.md 3.5: drive is the `traycer` CLI and CDP.
  drive: "cli",
  // ADES.md 3.5: "Data to move aside | ~/.traycer/ (chats, credentials, host/host.log, worktrees/, epics/<task-id>)".
  dataDirs: ["~/.traycer"],
  // ADES.md 3.5: the Host service keeps running after quit; its launch-agent label is unknown.
  launchAgents: [],
  // ADES.md 3.5: Electron set plus the Host service, which survives quit.
  vendorDirs: ["~/.traycer"],
});

const openThread = traycer.newThread;
traycer.newThread = async (ctx) => {
  await openThread(ctx);
  await pause(ctx, COMPOSER_READY_MS);
};

let appPid = 0;
const launchApp = traycer.launch;
traycer.launch = async (ctx) => {
  const launched = await launchApp(ctx);
  appPid = launched.pid;
  return launched;
};

const waitTurn = traycer.waitDone;
traycer.waitDone = async (ctx, timeoutMs) => {
  const result = await waitTurn(ctx, timeoutMs);
  if (!result.done || appPid === 0) return result;
  for (let tries = 0; tries < NEW_REPLY_TRIES; tries++) {
    try {
      await waitForText(ctx, appPid, NEW_REPLY_REGION, "New Reply", NEW_REPLY_WATCH_S);
      await click(ctx, appPid, NEW_REPLY_POINT);
    } catch {
      break;
    }
    await pause(ctx, NEW_REPLY_SETTLE_MS);
  }
  return result;
};
