// A1 Cold Start: cold process state to typing accepted, plus the once-per-block first-launch tier (TESTS.md A1).
import type { NativeIdle, ResultRow, Trigger } from "../../core/contracts.ts";
import { QUIET_LIMIT_CORES } from "../../core/gates.ts";
import { cleanupFirstLaunch, copyQuarantined } from "../../adapters/macos.ts";
import { appPathFor } from "../../adapters/support.ts";
import { missingCalibration, receipt, type CalibrationKey } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import type { TestContext } from "../../run/context.ts";
import { beforeQuitNote, killAdeProcesses, launchRow, receiptFields, runBeforeQuit, timingInvalid } from "./shared.ts";

const ID = "A1";
const FIRST_LAUNCH_KEY = "A1.first_launch";
const CALIBRATION: readonly CalibrationKey[] = ["composerRect", "launch"];

function invalidLaunchRow(ctx: TestContext, rep: number, variant: string, filePrefix: string, reason: string): ResultRow {
  const frames = receipt(ctx, ID, rep, `${filePrefix}frames.json`);
  const video = receipt(ctx, ID, rep, `${filePrefix}video.mov`);
  const log = receipt(ctx, ID, rep, `${filePrefix}notes.md`);
  return timingInvalid(
    ctx,
    {
      testId: ID,
      variant,
      rep,
      unit: "s",
      durationMs: 0,
      receipts: receiptFields(frames, video, log),
      notesPath: log.abs,
    },
    reason,
  );
}

// A1 steps 1-3: quit, kill every attributed process, boot out the launch agents, purge and wait for a quiet machine.
// The idle wait replaces the fixed 10 s sleep (TESTS.md A1 step 3): it returns early when the machine is already quiet.
// Before the quit the profile may leave a known state to restore (steps.beforeColdQuit). Its failure is a note, not a
// reason (runBeforeQuit): the cold start kills everything anyway.
interface ColdPrep {
  idle: NativeIdle;
  beforeQuit: string | null;
}

async function coldPrep(ctx: TestContext): Promise<ColdPrep | string> {
  const beforeQuit = await runBeforeQuit(ctx, "cold");
  await ctx.adapter.quit(ctx.adapterCtx);
  const survived = await killAdeProcesses(ctx);
  if (survived.length > 0) return beforeQuit === null ? "processes survived" : `processes survived (${beforeQuit})`;
  await ctx.instruments.purge();
  return { idle: await ctx.instruments.idle({ cpuCores: QUIET_LIMIT_CORES, quietMs: 2_000, capS: 10 }), beforeQuit };
}

function idleNotes(prep: ColdPrep): Record<string, unknown> {
  return { idle_ms: prep.idle.waited_ms, idle_quiet: prep.idle.quiet, ...beforeQuitNote(prep.beforeQuit) };
}

async function firstLaunchRow(ctx: TestContext, rep: number): Promise<ResultRow> {
  const idle = await coldPrep(ctx);
  if (typeof idle === "string") return invalidLaunchRow(ctx, rep, "first-launch", "first-launch-", idle);
  const copy = copyQuarantined(ctx.adapterCtx, appPathFor(ctx.adapter.calibration.appName));
  const triggers: Trigger[] = [{ kind: "open", appPath: copy }];
  const row = await launchRow(ctx, ID, rep, "first-launch", triggers, {
    filePrefix: "first-launch-",
    notesPrefix: "not ranked ",
    notesExtra: { ...idleNotes(idle), pilot: "a Gatekeeper dialog can appear" },
  });
  // TESTS.md A1 validity: a system dialog makes the run invalid.
  if (await cleanupFirstLaunch(ctx.adapterCtx, copy)) {
    return invalidLaunchRow(ctx, rep, "first-launch", "first-launch-", "system dialog: Gatekeeper");
  }
  return row;
}

async function coldRow(ctx: TestContext, rep: number): Promise<ResultRow> {
  const idle = await coldPrep(ctx);
  if (typeof idle === "string") return invalidLaunchRow(ctx, rep, "cold", "", idle);
  return launchRow(ctx, ID, rep, "cold", ctx.adapter.timed.launch, { notesExtra: idleNotes(idle), readWindowOnTimeout: true });
}

async function runRep(ctx: TestContext, rep: number): Promise<ResultRow[]> {
  const reason = missingCalibration(ctx.adapter, CALIBRATION);
  // ADES.md 3.0: Ghostty stays open for the control, so there is no fresh app copy to launch.
  // The first-launch tier is unranked, and its Gatekeeper dialog stole focus from the next blocks on 2026-10-24, so it
  // runs only when ADEMARK_FIRST_LAUNCH=1.
  const firstLaunchDue =
    process.env.ADEMARK_FIRST_LAUNCH === "1" &&
    rep === 1 &&
    ctx.state.get(FIRST_LAUNCH_KEY) !== true &&
    ctx.adapter.hostStaysOpen !== true;
  if (reason !== null) {
    const rows = [invalidLaunchRow(ctx, rep, "cold", "", reason)];
    if (firstLaunchDue) rows.unshift(invalidLaunchRow(ctx, rep, "first-launch", "first-launch-", reason));
    return rows;
  }
  const rows: ResultRow[] = [];
  if (firstLaunchDue) {
    ctx.state.set(FIRST_LAUNCH_KEY, true);
    rows.push(await firstLaunchRow(ctx, rep));
  }
  rows.push(await coldRow(ctx, rep));
  return rows;
}

export const a1ColdStart: TestRunner = {
  id: ID,
  track: "A",
  repeats: () => 10,
  maxExtraRuns: 3,
  // The first-launch tier runs at rep 1, and the adaptive stop needs 6 valid `cold` rows, so it always runs first.
  adaptive: { variant: "cold", min: 6, absTol: 1 / 60 },
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep,
};
