// A3 Thread Open: the new-thread action to typing accepted in the new thread (TESTS.md A3).
import { NOT_SUPPORTED } from "../../calibrate/pass.ts";
import type { NativeEcho, NativeWatch, Rect, ResultRow, Trigger } from "../../core/contracts.ts";
import { SEED_PROMPT, SEED_TIMEOUT_MS } from "../../run/loop.ts";
import { missingCalibration, receipt, type CalibrationKey } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import type { TestContext } from "../../run/context.ts";
import {
  attempt,
  composerRectOf,
  elapsedMs,
  firstReadCheck,
  launchPid,
  NEW_THREAD_TIMEOUT_S,
  probeOf,
  PROBE_INTERVAL_MS,
  READY_BOUND_MS,
  receiptFields,
  SEED_LINE,
  SEED_MARKER,
  threadRectOf,
  timingInvalid,
  timingRow,
  withoutTrailingWaits,
} from "./shared.ts";

const ID = "A3";
const VARIANT = "default-mode";
// threadRect and shortThread: the old thread is a seeded thread whose marker shows in the transcript (ADEMARK-40).
const CALIBRATION: readonly CalibrationKey[] = ["composerRect", "newThread", "threadRect", "shortThread"];
// The seeded thread is opened untimed; its marker must be read this soon, or the repetition is invalid before any time.
const OLD_THREAD_READ_S = 5;
// The look for the marker already on screen (the thread the last repetition seeded), before any trigger.
const ON_SCREEN_READ_S = 2;
// A fresh composer dropped the first typed character on Synara and Diri (2026-11-08); the seed prompt waits this long.
const SEED_SETTLE_MS = 1_500;

export const MARKER_NOT_READ = "the old thread's marker was not read before the action";
export const MARKER_NOT_CHECKED = "the old thread's marker was not checked on the Ready frame, so the new thread is not proven";
export const NO_NEW_THREAD = "new thread did not appear in 30 s";
// ADEMARK-55, Emdash A3 on 10 Nov: the marker stayed on screen behind a modal, the Ready frame's check saw it in about
// 950 reads and missed it once (OCR "gpen the reposltory I5 ynrh4nged"), and that one frame gave a 17.9 s time. The
// Ready frame's check lives in the native helper, so this second read is independent of it: after Ready, the old
// thread's marker must not be read again.
export const OLD_THREAD_AFTER_READY = "the old thread was still on screen after Ready";
const AFTER_READY_READ_S = 1;
export const NEW_THREAD_REGION_OVERLAPS =
  "newThreadComposerRect overlaps the old thread's composer (activeComposerRect), so an echo there does not prove a new thread";
export const NEW_THREAD_REGION_UNPROVEN =
  "newThreadComposerRect is set without activeComposerRect, so it is not proven apart from the old thread's composer";
// ADEMARK-40 review, 2026-11-10: Claude desktop forces its own API host, so its seed reply comes from the real model and
// may not hold "unchanged". Its prompt is no marker either: its new-thread screen lists the other sessions as
// "Replay seed" inside threadRect (OCR of the 9 Nov screenshots), and "ledger-ok" is B4's canary, which the model may
// skip. Without a marker that is certain in the old thread and absent from a new one, there is no proof.
export const NO_REPLAY_MARKER = `${NOT_SUPPORTED} here: without the replay server no seeded thread shows a certain marker`;

function seen(watch: NativeWatch): boolean {
  return !watch.timed_out && watch.ms !== null;
}

/** The waits that stay inside the timed triggers. */
export function fixedWaitMs(triggers: readonly Trigger[]): number {
  return triggers.reduce((sum, trigger) => sum + (trigger.kind === "wait" ? trigger.ms : 0), 0);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The new thread's own composer region, or the reason it cannot prove a new thread. Null: A3 works as before. */
export function newThreadRegion(calibration: {
  newThreadComposerRect?: Rect | null;
  activeComposerRect?: Rect | null;
}): Rect | { reason: string } | null {
  const region = calibration.newThreadComposerRect ?? null;
  if (region === null) return null;
  const old = calibration.activeComposerRect ?? null;
  if (old === null) return { reason: NEW_THREAD_REGION_UNPROVEN };
  return overlaps(region, old) ? { reason: NEW_THREAD_REGION_OVERLAPS } : region;
}

async function runRep(ctx: TestContext, rep: number): Promise<ResultRow[]> {
  const frames = receipt(ctx, ID, rep, "frames.json");
  const oldFrames = receipt(ctx, ID, rep, "frames-old-thread.json");
  const openedFrames = receipt(ctx, ID, rep, "frames-old-thread-open.json");
  const seededFrames = receipt(ctx, ID, rep, "frames-old-thread-seeded.json");
  const video = receipt(ctx, ID, rep, "video.mov");
  const log = receipt(ctx, ID, rep, "notes.md");
  const fields = {
    testId: ID,
    variant: VARIANT,
    rep,
    unit: "ms",
    durationMs: 0,
    receipts: receiptFields(frames, video, log),
    notesPath: log.abs,
  };
  // A profile without threadRect or shortThread has no old-thread proof. Rule: no proof, no time (no draft fallback).
  const reason = missingCalibration(ctx.adapter, CALIBRATION);
  if (reason !== null) return [timingInvalid(ctx, fields, reason)];
  if (ctx.adapter.liveModel === true) return [timingInvalid(ctx, fields, NO_REPLAY_MARKER)];
  const ownRegion = newThreadRegion(ctx.adapter.calibration);
  if (ownRegion !== null && "reason" in ownRegion) return [timingInvalid(ctx, fields, ownRegion.reason)];

  const calibration = ctx.adapter.calibration;
  const pid = launchPid(ctx);
  const threadRect = threadRectOf(ctx);
  const started = ctx.instruments.now();
  // Before the stopwatch: the open thread must be a seeded thread whose marker shows in the transcript. 2026-11-09: a
  // draft typed in the old composer was misread (HOLLOWPINO), piled up across repetitions and changed Claude desktop's
  // result (224 ms once, about 3,400 ms eight times). The composer now stays empty (TESTS.md). The last repetition
  // seeded the thread it opened, so the marker is usually on screen already; shortThread is the fallback, because many
  // of its triggers are positional (cmd+2, a fixed click) and land elsewhere once A3 has added threads (review R1).
  const watchMarker = (triggers: typeof ctx.adapter.timed.newThread, timeoutS: number, file: string) =>
    attempt(() =>
      // The same texts and the same rule as the Ready frame's check (2026-11-10): what this read sees, that check sees.
      ctx.instruments.watch({ pid, text: [SEED_MARKER, SEED_LINE], nearly: true, region: threadRect, triggers, timeoutS, frames: file }),
    );
  let foundBy = "on screen";
  let before = await watchMarker([], ON_SCREEN_READ_S, oldFrames.abs);
  if (!before.ok || !seen(before.value)) {
    foundBy = "shortThread";
    before = await watchMarker(ctx.adapter.timed.shortThread ?? [], OLD_THREAD_READ_S, openedFrames.abs);
  }
  // 2026-11-11, Emdash's top-up of A7 and A3 (control-2026-11-10T08-31-19Z-emdash-topup-2): after A7 the open thread is
  // one of its five streams, and shortThread's click on the first sidebar row opens another stream, because the newest
  // threads are on top. Neither shows the marker, so all three repetitions were invalid. The proof needs a seeded
  // thread on screen, not that one: a new thread is seeded here, untimed, as after every repetition (seedForNext).
  if (before.ok && !seen(before.value)) {
    foundBy = "seeded now";
    try {
      await ctx.adapter.newThread(ctx.adapterCtx);
      await seedForNext(ctx, pid);
    } catch (error) {
      ctx.log(`A3: no thread could be seeded for the old-thread proof (${error instanceof Error ? error.message : String(error)})`);
    }
    before = await watchMarker([], OLD_THREAD_READ_S, seededFrames.abs);
  }
  if (!before.ok) return [timingInvalid(ctx, { ...fields, durationMs: elapsedMs(ctx, started) }, before.reason)];
  if (!seen(before.value)) {
    return [timingInvalid(ctx, { ...fields, durationMs: elapsedMs(ctx, started) }, MARKER_NOT_READ, { watch: before.value })];
  }

  // A Ready frame must not show the old thread's marker, so a probe that echoes in the old composer never counts and a
  // wait after the committing action is not needed for correctness. 2026-11-08: Orca's trigger ended with a 6 s wait and
  // A3 was not supported there; the waits after the last action are dropped, the ones in the middle stay.
  const triggers = withoutTrailingWaits(ctx.adapter.timed.newThread);
  const timedAt = ctx.instruments.now();
  // With the new thread's own region the old thread stays on screen by design, so the marker is not asked to go.
  const absent = ownRegion === null ? { absent: SEED_MARKER, absentRegion: threadRect, absentAlso: SEED_LINE } : {};
  const result = await attempt(() =>
    ctx.instruments.echo({
      pid,
      triggers,
      ...absent,
      region: ownRegion ?? composerRectOf(ctx),
      focusClick: calibration.focusClick ?? undefined,
      probe: probeOf(ctx),
      intervalMs: PROBE_INTERVAL_MS,
      timeoutS: NEW_THREAD_TIMEOUT_S,
      frames: frames.abs,
      video: video.abs,
      masks: calibration.masks,
      clear: calibration.clearKeys,
    }),
  );
  const durationMs = elapsedMs(ctx, started);
  if (!result.ok) return [timingInvalid(ctx, { ...fields, durationMs }, result.reason)];
  const echo = result.value;
  const notes = {
    old_thread_marker: SEED_MARKER,
    new_thread_region: ownRegion === null ? "composerRect, marker absent on the Ready frame" : "newThreadComposerRect",
    marker_found_by: foundBy,
    marker_read_ms: before.value.ms,
    setup_ms: Number(timedAt - started) / 1_000_000,
    dropped_trailing_waits: ctx.adapter.timed.newThread.length - triggers.length,
    // ADEMARK-55: a fixed wait inside the stopwatch is part of the time, not the app's own (Emdash: 800 ms before the
    // click on the modal's prompt box). The note keeps it visible beside the number.
    fixed_wait_ms: fixedWaitMs(triggers),
    absent_seen: echo.absent_seen ?? null,
    absent_checked: echo.absent_checked ?? null,
    bound_ms: READY_BOUND_MS,
    settled_ms: echo.settled_ms ?? "never settled",
    frames: echo.frames,
  };
  if (echo.timed_out || echo.ready_ms === null) {
    return [timingInvalid(ctx, { ...fields, durationMs }, NO_NEW_THREAD, { echo, marker_found_by: foundBy })];
  }
  const row = await readyRow(ctx, { ...fields, durationMs }, echo, notes, {
    pid,
    threadRect,
    ownRegion,
    framesPath: frames.abs,
    afterReadyFrames: receipt(ctx, ID, rep, "frames-after-ready.json").abs,
    foundBy,
  });
  // The row is final before the seed turn, so a seed that fails never changes it.
  await seedForNext(ctx, pid);
  return [row];
}

interface ReadyProof {
  pid: number;
  threadRect: Rect;
  ownRegion: Rect | null;
  framesPath: string;
  afterReadyFrames: string;
  foundBy: string;
}

// The checks after a Ready echo, all untimed: the time is already fixed. Council rule 3: without the new thread's own
// region, the time is published only when the marker was read before the action and absent on the Ready frame.
async function readyRow(
  ctx: TestContext,
  fields: Parameters<typeof timingInvalid>[1],
  echo: NativeEcho,
  notes: Record<string, unknown>,
  proof: ReadyProof,
): Promise<ResultRow> {
  const context = { echo, marker_found_by: proof.foundBy };
  if (echo.ready_ms === null) return timingInvalid(ctx, fields, NO_NEW_THREAD, context);
  const readyMs = echo.ready_ms;
  if (proof.ownRegion === null && echo.absent_checked !== true) return timingInvalid(ctx, fields, MARKER_NOT_CHECKED, context);
  const firstRead = firstReadCheck(ctx, proof.framesPath, echo);
  if (firstRead.reason !== null) return timingInvalid(ctx, fields, firstRead.reason, { ...context, ...firstRead.note });
  if (proof.ownRegion === null) {
    // The same texts and rule as the read before the stopwatch, with no trigger: the screen as it is right after Ready.
    const after = await attempt(() =>
      ctx.instruments.watch({
        pid: proof.pid,
        text: [SEED_MARKER, SEED_LINE],
        nearly: true,
        region: proof.threadRect,
        triggers: [],
        timeoutS: AFTER_READY_READ_S,
        frames: proof.afterReadyFrames,
      }),
    );
    if (!after.ok) return timingInvalid(ctx, fields, `after Ready: ${after.reason}`, context);
    // The dry watch reports every text as seen; a dry row is never published, so the plan keeps the call only.
    if (seen(after.value) && !ctx.instruments.dryRun) {
      return timingInvalid(ctx, fields, OLD_THREAD_AFTER_READY, { ...context, after_ready: after.value });
    }
  }
  const checked = proof.ownRegion !== null ? {} : { marker_after_ready: ctx.instruments.dryRun ? "not checked in a dry run" : "not read" };
  return timingRow(ctx, { ...fields, notes: JSON.stringify({ ...notes, ...firstRead.note, ...checked }) }, readyMs);
}

// The helper's own clear when a profile names none (bench/native KeyPoster.swift: "Omitted: cmd+a, delete").
export const DEFAULT_CLEAR_KEYS: readonly string[] = ["cmd+a", "delete"];

// Untimed, after the timed part: the new thread becomes a seeded thread, so the next repetition starts in a thread that
// shows the marker, with no positional trigger. A failure is logged; the next repetition falls back to shortThread.
// 2026-11-10, Diri (control-2026-11-10T08-31-19Z-diri-1/diri/A3): the echo's clear left probe letters such as "demadem"
// in the composer, the seed went out as that text plus replay:seed, the replay server answered "ok", and the next
// repetition found no marker. So the composer is cleared with the profile's clear keys right before the seed.
async function seedForNext(ctx: TestContext, pid: number): Promise<void> {
  try {
    await ctx.instruments.sleep(SEED_SETTLE_MS);
    for (const combo of ctx.adapter.calibration.clearKeys ?? DEFAULT_CLEAR_KEYS) await ctx.instruments.keys({ pid, combo });
    await ctx.adapter.send(ctx.adapterCtx, SEED_PROMPT);
    const done = await ctx.adapter.waitDone(ctx.adapterCtx, SEED_TIMEOUT_MS);
    if (!done.done) ctx.log(`A3: the seed turn did not finish (${done.reason}); the next repetition opens shortThread`);
  } catch (error) {
    ctx.log(`A3: the seed turn failed (${error instanceof Error ? error.message : String(error)}); the next repetition opens shortThread`);
  }
}

export const a3ThreadOpen: TestRunner = {
  id: ID,
  track: "A",
  repeats: () => 10,
  maxExtraRuns: 3,
  adaptive: { variant: VARIANT, min: 6, absTol: 1000 / 60 },
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep,
};
