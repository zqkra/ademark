// A11 Long Thread: open, scroll and switch a 2,000-message thread (TESTS.md A11).
import type { ResultRow } from "../../core/contracts.ts";
import { missingCalibration, receipt, type CalibrationKey, type ReceiptPath } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import type { TestContext } from "../../run/context.ts";
import { SEED_PROMPT, SEED_TIMEOUT_MS } from "../../run/loop.ts";
import {
  attempt,
  elapsedMs,
  launchPid,
  receiptFields,
  SEED_FUZZY,
  SEED_MARKER,
  threadRectOf,
  timingInvalid,
  timingRow,
  WATCH_TIMEOUT_S,
  writeNotes,
  type TimingRowFields,
} from "./shared.ts";

const ID = "A11";
const READY_KEY = "A11.ready";
const LOST_KEY = "A11.lost";
const LONG_PROMPT = "replay:long-2000";
// The watch looks for the marker's tail: pilot 2026-10-20, Vision read "LONGTHREAD-END" as "LONfjTHREAD-END" in Ghostty's
// font. "THREAD-END" appears only in the long thread's last turn. Orca's font reads it as "L(NGTHREA&END" (all 1,148 drain
// frames of 9 Nov) or "L(NGTHREAFEND" (8 Nov gates), so both spellings follow, exact and with their "END". A bare
// "NGTHREA" would also match "Loading thread" once spaces are dropped, and stop the open watch early (review, 2026-11-09).
// In the 283 A11 frames files of 8 and 9 Nov, the three texts match every Orca frame that shows the marker line and no
// line that is not the marker. A third spelling on some night gives "long thread not built", which is honest.
export const LONG_MARKERS: readonly string[] = ["THREAD-END", "NGTHREAEND", "NGTHREAFEND"];
const RETURN_TRIES = 3;
const CALIBRATION: readonly CalibrationKey[] = ["threadRect", "longThread", "shortThread"];
// How long the long thread may take to finish drawing after its turn ended.
const DRAIN_TIMEOUT_S = 420;
const OPEN_NOTES = JSON.stringify({
  measured: "time until LONGTHREAD-END is seen",
  visual_settling: "pilot item",
});

// Once per block: build a short "Seeded" thread, then the 2,000-message thread, through the ADE, and remember whether
// both finished. Pilot 2026-10-20: the thread before the long one was an A10 thread still streaming its 3-minute answer,
// so Zeron's cmd+2 showed changing text and never "Seeded". A short thread made here is the next one in the sidebar.
async function longThreadReady(ctx: TestContext): Promise<boolean> {
  const known = ctx.state.get(READY_KEY);
  if (known === true) return true;
  if (known === false) return false;
  await ctx.adapter.newThread(ctx.adapterCtx);
  await ctx.adapter.send(ctx.adapterCtx, SEED_PROMPT);
  const short = await ctx.adapter.waitDone(ctx.adapterCtx, SEED_TIMEOUT_MS);
  if (!short.done) {
    ctx.state.set(READY_KEY, false);
    return false;
  }
  await ctx.adapter.newThread(ctx.adapterCtx);
  await ctx.adapter.send(ctx.adapterCtx, LONG_PROMPT);
  const done = await ctx.adapter.waitDone(ctx.adapterCtx, 30 * 60_000);
  if (!done.done) {
    ctx.state.set(READY_KEY, false);
    return false;
  }
  // 2026-11-08: waitDone returned before the long thread ended on Orca and T3 Code, and super.engineering drew the turn
  // about 5 steps a second long after the server finished, so every open timed out. The thread is on screen right after
  // the send: its end marker must show before any repetition starts.
  const drained = await attempt(() =>
    ctx.instruments.watch({ pid: launchPid(ctx), text: LONG_MARKERS, region: threadRectOf(ctx), triggers: [], timeoutS: DRAIN_TIMEOUT_S, frames: drainFrames(ctx) }),
  );
  const ready = ctx.instruments.dryRun || (drained.ok && !drained.value.timed_out && drained.value.ms !== null);
  ctx.state.set(READY_KEY, ready);
  return ready;
}

function drainFrames(ctx: TestContext): string {
  return receipt(ctx, ID, 1, "frames-drain.json").abs;
}

async function runRep(ctx: TestContext, rep: number): Promise<ResultRow[]> {
  const openFrames = receipt(ctx, ID, rep, "frames-open.json");
  const scrollFrames = receipt(ctx, ID, rep, "frames-scroll.json");
  const switchFrames = receipt(ctx, ID, rep, "frames-switch.json");
  const setupFrames = receipt(ctx, ID, rep, "frames-setup.json");
  const returnFrames = receipt(ctx, ID, rep, "frames-return.json");
  const log = receipt(ctx, ID, rep, "notes.md");
  const framesFor: Record<string, ReceiptPath> = {
    open: openFrames,
    "scroll-gaps": scrollFrames,
    "scroll-max-gap": scrollFrames,
    switch: switchFrames,
  };
  const unitFor: Record<string, string> = { open: "ms", "scroll-gaps": "frames", "scroll-max-gap": "ms", switch: "ms" };
  const invalid = (variant: string, reason: string, durationMs = 0): ResultRow =>
    timingInvalid(
      ctx,
      {
        testId: ID,
        variant,
        rep,
        unit: unitFor[variant]!,
        durationMs,
        receipts: receiptFields(framesFor[variant]!, null, log),
        notesPath: log.abs,
      },
      reason,
    );
  const variants = Object.keys(unitFor);

  const reason = missingCalibration(ctx.adapter, CALIBRATION);
  if (reason !== null) return variants.map((variant) => invalid(variant, reason));
  if (!(await longThreadReady(ctx))) return variants.map((variant) => invalid(variant, "long thread not built"));
  if (ctx.state.get(LOST_KEY) === true) return variants.map((variant) => invalid(variant, "could not return to the thread end"));

  const started = ctx.instruments.now();
  const pid = launchPid(ctx);
  const threadRect = threadRectOf(ctx);
  const longTriggers = ctx.adapter.timed.longThread ?? [];
  const shortTriggers = ctx.adapter.timed.shortThread ?? [];

  // Every repetition starts in a short thread; the setup watch is not a row.
  const setup = await attempt(() =>
    ctx.instruments.watch({
      pid,
      text: SEED_MARKER,
      fuzzy: SEED_FUZZY,
      region: threadRect,
      triggers: shortTriggers,
      timeoutS: WATCH_TIMEOUT_S,
      frames: setupFrames.abs,
    }),
  );
  const setupSeen = setup.ok && !setup.value.timed_out && setup.value.ms !== null;
  const opened = await attempt(() =>
    ctx.instruments.watch({
      pid,
      text: LONG_MARKERS,
      region: threadRect,
      triggers: longTriggers,
      timeoutS: WATCH_TIMEOUT_S,
      frames: openFrames.abs,
    }),
  );
  const scrolled = await attempt(() =>
    ctx.instruments.scroll({ pid, region: threadRect, count: 20, hz: 60, lines: 5, frames: scrollFrames.abs }),
  );
  // The scroll above went up. An app that remembers the position would reopen the thread away from LONGTHREAD-END, and
  // every later repetition would time out, so the thread goes back to its end. This scroll is not a row.
  let returned = false;
  for (let tries = 0; tries < RETURN_TRIES && !returned; tries++) {
    await attempt(() =>
      ctx.instruments.scroll({ pid, region: threadRect, count: 40, hz: 60, lines: -5, frames: returnFrames.abs }),
    );
    const back = await attempt(() =>
      ctx.instruments.watch({ pid, text: LONG_MARKERS, region: threadRect, triggers: [], timeoutS: 5, frames: returnFrames.abs }),
    );
    returned = back.ok && !back.value.timed_out && back.value.ms !== null;
  }
  // The next repetition could not see the marker, so it ends at once instead of waiting for each timeout.
  if (!returned && opened.ok && !opened.value.timed_out) ctx.state.set(LOST_KEY, true);
  const switched = await attempt(() =>
    ctx.instruments.watch({
      pid,
      text: SEED_MARKER,
      fuzzy: SEED_FUZZY,
      region: threadRect,
      triggers: shortTriggers,
      timeoutS: WATCH_TIMEOUT_S,
      frames: switchFrames.abs,
    }),
  );
  const durationMs = elapsedMs(ctx, started);
  const fields = (variant: string): TimingRowFields => ({
    testId: ID,
    variant,
    rep,
    unit: unitFor[variant]!,
    durationMs,
    receipts: receiptFields(framesFor[variant]!, null, log),
    notesPath: log.abs,
    notes: "",
  });

  // Council 2026-11-08: without a confirmed short thread the long one may still be on screen, and a redraw can take more
  // than any threshold, so the open is never timed then. The seed marker now matches one misread letter (bb).
  const notSetUp = setup.ok ? "the short thread did not show before the open" : setup.reason;
  const open = !setupSeen
    ? timingInvalid(ctx, fields("open"), notSetUp)
    : opened.ok
    ? opened.value.timed_out || opened.value.ms === null
      ? timingInvalid(ctx, fields("open"), "timed_out", { open: opened.value })
      : timingRow(ctx, { ...fields("open"), notes: OPEN_NOTES }, opened.value.ms)
    : timingInvalid(ctx, fields("open"), opened.reason);

  // Without the long thread on screen, scroll and switch would time the short thread and still look valid. QA found this
  // on the rows of 2026-11-05.
  const inLongThread = setupSeen && opened.ok && !opened.value.timed_out && opened.value.ms !== null;
  const notOpen = !setupSeen ? notSetUp : opened.ok ? "the long thread did not open" : opened.reason;
  const scroll = !inLongThread
    ? [invalid("scroll-gaps", notOpen, durationMs), invalid("scroll-max-gap", notOpen, durationMs)]
    : scrolled.ok
    ? [
        timingRow(
          ctx,
          { ...fields("scroll-gaps"), notes: JSON.stringify({ posted: scrolled.value.posted, frames: scrolled.value.frames }) },
          scrolled.value.gaps_over_33ms,
        ),
        timingRow(
          ctx,
          { ...fields("scroll-max-gap"), notes: JSON.stringify({ posted: scrolled.value.posted, frames: scrolled.value.frames }) },
          scrolled.value.max_gap_ms,
        ),
      ]
    : [invalid("scroll-gaps", scrolled.reason, durationMs), invalid("scroll-max-gap", scrolled.reason, durationMs)];

  const switchedRow = !inLongThread
    ? invalid("switch", notOpen, durationMs)
    : switched.ok
    ? switched.value.timed_out || switched.value.ms === null
      ? timingInvalid(ctx, fields("switch"), "timed_out", { switch: switched.value })
      : timingRow(ctx, { ...fields("switch"), notes: JSON.stringify({ text: SEED_MARKER }) }, switched.value.ms)
    : timingInvalid(ctx, fields("switch"), switched.reason);

  writeNotes(log.abs, {
    pid,
    open: opened.ok ? opened.value : opened.reason,
    scroll: scrolled.ok ? scrolled.value : scrolled.reason,
    switch: switched.ok ? switched.value : switched.reason,
    note: "open is the time until the text is seen; visual settling for A11 is a pilot item",
  });
  return [open, ...scroll, switchedRow];
}

export const a11LongThread: TestRunner = {
  id: ID,
  track: "A",
  repeats: () => 5,
  // Repetition 2 is what proves the thread came back to its end.
  smokeRepeats: 2,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep,
};
