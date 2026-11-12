// A4 First Word: Enter to the first word of the replay answer on screen (TESTS.md A4).
import type { ResultRow } from "../../core/contracts.ts";
import { paste } from "../../adapters/macos.ts";
import { missingCalibration, receipt, type CalibrationKey } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import type { TestContext } from "../../run/context.ts";
import {
  attempt,
  elapsedMs,
  firstRequestAfter,
  launchPid,
  readReplayLog,
  receiptFields,
  replayLogPath,
  threadRectOf,
  timingInvalid,
  timingRow,
  WATCH_TIMEOUT_S,
  writeNotes,
} from "./shared.ts";

const ID = "A4";
const PROMPT = "replay:hi";
const FIRST_WORD = "LEDGERMARK";
const SESSION = "hi";
const VARIANTS = ["total", "before-request", "on-screen"] as const;
const CALIBRATION: readonly CalibrationKey[] = ["threadRect", "send"];
// Apps that get the prompt by paste, not typed. Diri 0.11.2 reads the key code and ignores the event's text, and the
// native helper sends ":" with key code 0, so "replay:hi" arrived as "replayahi" and the replay server answered "ok"
// (night of 2026-11-10: control-2026-11-10T08-31-19Z-diri-1/diri/A4/rep-01/frames.json reads "replJyah*" then "ok", and
// a-replay.jsonl logs the request with no session; 18 rows timed_out, and no A4 of Diri ever passed a gate). The prompt
// is setup before the stopwatch, which starts at the send trigger, so a paste changes no measured interval. Diri's own
// send pastes, and its seed turns matched the whole night.
export const PASTE_PROMPT: ReadonlySet<string> = new Set(["diri"]);

interface Values {
  total: number;
  "before-request": number;
  "on-screen": number;
}

function rowSet(ctx: TestContext, rep: number, durationMs: number, values: Values, notes: string): ResultRow[] {
  const frames = receipt(ctx, ID, rep, "frames.json");
  const log = receipt(ctx, ID, rep, "notes.md");
  const fields = {
    testId: ID,
    rep,
    unit: "ms",
    durationMs,
    receipts: receiptFields(frames, null, log),
    notesPath: log.abs,
    notes,
  };
  return VARIANTS.map((variant) => timingRow(ctx, { ...fields, variant }, values[variant]));
}

function invalidSet(ctx: TestContext, rep: number, durationMs: number, reason: string): ResultRow[] {
  const frames = receipt(ctx, ID, rep, "frames.json");
  const log = receipt(ctx, ID, rep, "notes.md");
  const fields = {
    testId: ID,
    rep,
    unit: "ms",
    durationMs,
    receipts: receiptFields(frames, null, log),
    notesPath: log.abs,
  };
  return VARIANTS.map((variant) => timingInvalid(ctx, { ...fields, variant }, reason));
}

async function runRep(ctx: TestContext, rep: number): Promise<ResultRow[]> {
  const reason = missingCalibration(ctx.adapter, CALIBRATION);
  if (reason !== null) return invalidSet(ctx, rep, 0, reason);
  const logPath = replayLogPath(ctx);
  if (logPath === null) return invalidSet(ctx, rep, 0, "no replay control");

  const started = ctx.instruments.now();
  const pid = launchPid(ctx);
  await ctx.adapter.newThread(ctx.adapterCtx);
  // Unmeasured: the stopwatch starts at Enter. A composer that is still painting drops the first typed character.
  await ctx.instruments.sleep(1500);
  const typed = PASTE_PROMPT.has(ctx.adapter.id)
    ? await attempt(() => paste(ctx.adapterCtx, pid, PROMPT))
    : await attempt(() => ctx.instruments.keys({ pid, text: PROMPT }));
  if (!typed.ok) return invalidSet(ctx, rep, elapsedMs(ctx, started), typed.reason);

  const frames = receipt(ctx, ID, rep, "frames.json");
  const watched = await attempt(() =>
    ctx.instruments.watch({
      pid,
      text: FIRST_WORD,
      // Vision read "LEDGEPNARK" on Orca (2026-11-08): two misread letters of this rare word still count.
      fuzzy: 2,
      region: threadRectOf(ctx),
      triggers: ctx.adapter.timed.send,
      timeoutS: WATCH_TIMEOUT_S,
      frames: frames.abs,
    }),
  );
  const durationMs = elapsedMs(ctx, started);
  if (!watched.ok) return invalidSet(ctx, rep, durationMs, watched.reason);

  const watch = watched.value;
  // Pilot 2026-10-20: T3 Code sat on "Start agent" past the 30 s watch, so no request came either; that is a timeout.
  if (watch.timed_out || watch.ms === null) {
    return invalidSet(ctx, rep, durationMs, "timed_out");
  }
  const request = firstRequestAfter(readReplayLog(logPath), SESSION, watch.t0_ns);
  if (request === null) return invalidSet(ctx, rep, durationMs, "no replay request");

  const total = watch.ms;
  const before = (request.t_ns - watch.t0_ns) / 1_000_000;
  const onScreen = total - before;
  const notes = JSON.stringify({ t0_ns: watch.t0_ns, t_request_ns: request.t_ns, session: SESSION });
  const log = receipt(ctx, ID, rep, "notes.md");
  writeNotes(log.abs, {
    variant: "all",
    prompt: PROMPT,
    first_word: FIRST_WORD,
    total_ms: total,
    before_request_ms: before,
    on_screen_ms: onScreen,
    request,
  });
  return rowSet(ctx, rep, durationMs, { total, "before-request": before, "on-screen": onScreen }, notes);
}

export const a4FirstWord: TestRunner = {
  id: ID,
  track: "A",
  repeats: () => 10,
  maxExtraRuns: 3,
  adaptive: { variant: "total", min: 6, absTol: 1000 / 60 },
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep,
};
