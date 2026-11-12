// A2 Relaunch: launch after a normal quit, no kill and no purge (TESTS.md A2).
import { basename } from "node:path";
import type { NativeProc, ResultRow } from "../../core/contracts.ts";
import { readBundleInfo } from "../../adapters/support.ts";
import { QUIET_LIMIT_CORES } from "../../core/gates.ts";
import { missingCalibration, receipt, type CalibrationKey } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import type { TestContext } from "../../run/context.ts";
import { bootout, killPids, mainAppPids, procsFor, waitGone } from "../../adapters/macos.ts";
import { adePidHints, beforeQuitNote, launchRow, receiptFields, runBeforeQuit, timingInvalid } from "./shared.ts";

// 2026-11-08: Zeron was still exiting about 20 s after its quit, Synara about 30 s with live sessions. The poll returns as
// soon as the app is gone, so a long grace costs a fast app nothing.
const QUIT_GRACE_MS = 45_000;
const QUIT_POLL_MS = 500;
const QUIET_CAP_S = 60;

const ID = "A2";
const ENDED_KEY = "A2.ended";
const CALIBRATION: readonly CalibrationKey[] = ["composerRect", "launch"];

async function runRep(ctx: TestContext, rep: number): Promise<ResultRow[]> {
  const frames = receipt(ctx, ID, rep, "frames.json");
  const video = receipt(ctx, ID, rep, "video.mov");
  const log = receipt(ctx, ID, rep, "notes.md");
  const fields = {
    testId: ID,
    variant: "relaunch",
    rep,
    unit: "s",
    durationMs: 0,
    receipts: receiptFields(frames, video, log),
    notesPath: log.abs,
  };
  const reason = missingCalibration(ctx.adapter, CALIBRATION);
  if (reason !== null) return [timingInvalid(ctx, fields, reason)];
  const ended = ctx.state.get(ENDED_KEY);
  if (typeof ended === "string") return [timingInvalid(ctx, fields, `A2 ended for this app: ${ended}`)];
  // Untimed: the profile may close what the earlier tests opened, so the relaunch restores the state a user leaves
  // after a normal session (steps.beforeRelaunchQuit). A failed step is a note, not a reason (runBeforeQuit).
  const beforeQuit = await runBeforeQuit(ctx, "relaunch");
  const stepNote = beforeQuitNote(beforeQuit);
  await ctx.adapter.quit(ctx.adapterCtx);
  // An app that survived the quit would come back warm, and the row would report an unfair fast relaunch. The control's
  // host, Ghostty, stays open on purpose: its quit ends the CLI inside it.
  const survivors = await stillRunning(ctx);
  if (survivors.length > 0) return [timingInvalid(ctx, fields, quitFailedReason(survivors), stepNote)];
  // TESTS.md A2: wait for the quiet machine, not a fixed 5 s (the old sleep could start the launch in a busy tail).
  // 2026-11-09: a 5 s cap failed MonoCode and Claude desktop at 0.00 cores with nothing of the app running, because a 1 s
  // quiet window did not fit before the cap. 60 s gives a normal quit tail room to settle.
  const idle = await ctx.instruments.idle({ cpuCores: QUIET_LIMIT_CORES, quietMs: 1_000, capS: QUIET_CAP_S });
  let idleNote: string | undefined;
  let cpuTopNote: string[] | string | undefined;
  // 2026-11-08: Diri, Orca and Traycer quit, but their agent CLIs kept working at about 1.7 cores each, so the CPU gate in
  // launchRow waited 5 min and failed every repetition. A2 keeps what the app leaves running (TESTS.md), so a busy Mac
  // makes this repetition invalid with the reason, and the app's own leftovers are swept for the next one.
  if (!idle.quiet) {
    // 2026-11-09: Orca's A2 row said 1.58 cores, and nothing recorded which process used them. One gate sample, before
    // the sweep, names the busiest ones.
    const cpuTop = await busiestProcesses(ctx);
    const swept = await sweepLeftovers(ctx);
    if (swept > 0) {
      // A2 ends here for this app: any later repetition would relaunch from the swept state, not after a normal quit
      // (council, 2026-11-08). The app is opened again, untimed, for the tests that follow.
      const reason = leftoverReason(idle.cores_last, swept);
      ctx.state.set(ENDED_KEY, reason);
      try {
        const { pid } = await ctx.adapter.launch(ctx.adapterCtx);
        ctx.state.set("launch_pid", pid);
      } catch (error) {
        ctx.log(`A2: reopening after the sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return [timingInvalid(ctx, fields, reason, { ...stepNote, cpu_top: cpuTop })];
    }
    // Nothing of the app was running, so nothing was swept and the state is still the one after a normal quit. The busy
    // Mac is not the app's doing: launchRow's own quiet gate decides, and the row says that the wait reached its cap.
    idleNote = notQuietNote(idle.cores_last);
    cpuTopNote = cpuTop;
  }
  return [
    await launchRow(ctx, ID, rep, "relaunch", ctx.adapter.timed.launch, {
      notesExtra: {
        ...stepNote,
        idle_ms: idle.waited_ms,
        idle_quiet: idle.quiet,
        ...(idleNote === undefined ? {} : { idle_note: idleNote, cpu_top: cpuTopNote }),
      },
    }),
  ];
}

async function busiestProcesses(ctx: TestContext): Promise<string[] | string> {
  try {
    return (await ctx.instruments.gates({ quietWaitMs: 0 })).cpu_top ?? [];
  } catch (error) {
    return `cpu_top not read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function leftoverReason(cores: number, swept: number): string {
  // `swept` counts what was still running, not what was busy (on Orca, 9 Nov: its terminal host). notes.md names the
  // busy ones in cpu_top.
  return `${swept} processes of the app were still running after the quit (Mac at ${cores.toFixed(2)} cores after ${QUIET_CAP_S} s, busiest in cpu_top of notes.md), so A2 ends for this app`;
}

export function notQuietNote(cores: number): string {
  return `the Mac was not quiet ${QUIET_CAP_S} s after the quit (${cores.toFixed(2)} cores), but no process of the app was running`;
}

// What the quit left running of this app only: its processes and launch agents. Orphans of unknown origin are left
// alone (they may belong to another app), and a host that stays open on purpose (the control's Ghostty) is never swept.
async function sweepLeftovers(ctx: TestContext): Promise<number> {
  if (ctx.instruments.dryRun || ctx.adapter.hostStaysOpen === true) return 0;
  const pids = new Set<number>();
  for (const proc of await procsFor(ctx.adapterCtx, adePidHints(ctx.adapter, ctx.adapterCtx.home))) pids.add(proc.pid);
  for (const label of ctx.adapter.calibration.launchAgents) bootout(ctx.adapterCtx, label);
  const list = [...pids];
  killPids(ctx.adapterCtx, list);
  if (list.length > 0) await waitGone(ctx.adapterCtx, list, 10_000);
  return list.length;
}

export const QUIT_FAILED = "quit failed: the app is still running";

/** The reason names what stayed, so a real pass tells a quit that was never delivered from one that is slow. */
export function quitFailedReason(survivors: readonly NativeProc[]): string {
  const names = [...new Set(survivors.map((proc) => basename(proc.path)))].sort();
  return `${QUIT_FAILED} (${survivors.length} processes after ${QUIT_GRACE_MS / 1000} s: ${names.join(", ")})`;
}

// The bundle's own executable (CFBundleExecutable): the process that is the app. 2026-11-10, Zeron 0.2.136: the quit
// ended `zeron`, but `Zeron Engine`, a second executable in Contents/MacOS, stayed as a launchd child (ppid 1) with its
// Claude sessions (A9 samples-no-sessions.csv of control-2026-11-10T08-31-19Z-zeron-1, 60 s after the quit). It is a
// background process the app keeps, which A2 leaves alive (TESTS.md), so it must not fail the quit check. Without a
// readable Info.plist every Contents/MacOS executable still counts, as before.
export function appExecutables(bundlePaths: readonly string[]): string[] | null {
  const executables: string[] = [];
  for (const bundle of bundlePaths) {
    const executable = readBundleInfo(bundle)?.executable ?? null;
    if (executable === null) return null;
    executables.push(executable);
  }
  return executables;
}

// Zeron answers the quit and needs a few more seconds to go, so one look right after it fails an app that did quit.
async function stillRunning(ctx: TestContext): Promise<NativeProc[]> {
  if (ctx.instruments.dryRun || ctx.adapter.hostStaysOpen === true) return [];
  const bundlePaths = ctx.adapter.processes().bundlePaths;
  const executables = appExecutables(bundlePaths);
  const running = async (): Promise<NativeProc[]> => {
    const pids = new Set(mainAppPids(bundlePaths, ctx.adapter.calibration.launchAgents));
    if (pids.size === 0) return [];
    const procs = (await procsFor(ctx.adapterCtx, { bundlePaths })).filter((proc) => pids.has(proc.pid));
    return executables === null ? procs : procs.filter((proc) => executables.includes(proc.path));
  };
  for (let waited = 0; waited < QUIT_GRACE_MS && (await running()).length > 0; waited += QUIT_POLL_MS) {
    await ctx.instruments.sleep(QUIT_POLL_MS);
  }
  return running();
}

export const a2Relaunch: TestRunner = {
  id: ID,
  track: "A",
  repeats: () => 10,
  maxExtraRuns: 3,
  adaptive: { variant: "relaunch", min: 6, absTol: 1 / 60 },
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep,
};
