// Helpers shared by the Track A timing runners (TESTS.md §1.3 and §2: A1-A4 and A11).
import { mainAppPids } from "../../adapters/macos.ts";
import { appUsage } from "../../observer/observer.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Adapter,
  NativeEcho,
  Receipts,
  Rect,
  ReplayRequestLog,
  ResultRow,
  TestId,
  Trigger,
} from "../../core/contracts.ts";
import { NativeError } from "../../core/native.ts";
import { bootout, killPids, procsFor, procsUnder, waitGone, type PidHints } from "../../adapters/macos.ts";
import { invalidRow, receipt, type ReceiptPath } from "../../run/kit.ts";
import type { TestContext } from "../../run/context.ts";
import type { ReplayControl } from "../../run/instruments.ts";

// TESTS.md §1.3: one probe character every 50 ms, cycling through this string.
export const PROBE = "ademarkqz";
/**
 * The probe of one ADE. The native rule takes any new pair of probe letters in the region as Ready, and the default
 * probe has pairs of ordinary words: bb's placeholder ("... files, folders, or sections") and Traycer's ("... files/
 * folder, or use / to show available commands") hold "de" and "ma". On 10 and 11 Nov both apps reached Ready on their
 * placeholder in every A1 and A2 repetition, and the typing stopped before a key could echo. A profile may name a
 * probe whose pairs no word has (`calibration.probe`). What is timed does not change: the first frame with typed text.
 */
export function probeOf(ctx: TestContext): string {
  return ctx.adapter.calibration.probe ?? PROBE;
}
export const PROBE_INTERVAL_MS = 50;
// TESTS.md §1.3: 60 Hz frames and 50 ms probes bound Ready within about 67 ms.
export const READY_BOUND_MS = 67;
export const LAUNCH_TIMEOUT_S = 60;
export const NEW_THREAD_TIMEOUT_S = 30;
export const WATCH_TIMEOUT_S = 30;

export function receiptFields(
  frames: ReceiptPath | null,
  video: ReceiptPath | null,
  log: ReceiptPath | null,
): Receipts {
  return { samples: null, video: video?.rel ?? null, frames: frames?.rel ?? null, capture: null, log: log?.rel ?? null };
}

export interface TimingRowFields {
  testId: TestId;
  variant: string;
  rep: number;
  unit: string;
  durationMs: number;
  receipts: Receipts;
  notesPath: string | null;
  notes: string;
}

export function timingRow(ctx: TestContext, fields: TimingRowFields, value: number): ResultRow {
  return ctx.row({
    test_id: fields.testId,
    variant: fields.variant,
    rep: fields.rep,
    server: "replay",
    value,
    unit: fields.unit,
    duration_ms: fields.durationMs,
    valid: true,
    invalid_reason: null,
    receipts: fields.receipts,
    notes: fields.notes,
  });
}

export function timingInvalid(
  ctx: TestContext,
  fields: Omit<TimingRowFields, "notes">,
  reason: string,
  extra: Record<string, unknown> = {},
): ResultRow {
  writeNotes(fields.notesPath, { variant: fields.variant, invalid_reason: reason, ...extra });
  return invalidRow(
    ctx,
    {
      test_id: fields.testId,
      variant: fields.variant,
      rep: fields.rep,
      server: "replay",
      unit: fields.unit,
      duration_ms: fields.durationMs,
      receipts: fields.receipts,
      notes: "",
    },
    reason,
  );
}

export function writeNotes(path: string | null, data: Record<string, unknown>): void {
  if (path === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# notes\n\n${JSON.stringify(data, null, 2)}\n`);
}

export function elapsedMs(ctx: TestContext, startedNs: bigint): number {
  return Math.max(0, Number(ctx.instruments.now() - startedNs) / 1_000_000);
}

// A1 and A2 records: settled_ms is the secondary number of TESTS.md §1.3.
export function launchNotes(echo: NativeEcho, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ settled_ms: echo.settled_ms ?? "never settled", frames: echo.frames, ...extra });
}

export function launchPid(ctx: TestContext): number {
  const value = ctx.state.get("launch_pid");
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function composerRectOf(ctx: TestContext): Rect {
  const rect = ctx.adapter.calibration.composerRect;
  if (rect === null) throw new Error("missingCalibration said composerRect was set");
  return rect;
}

export function threadRectOf(ctx: TestContext): Rect {
  const rect = ctx.adapter.calibration.threadRect;
  if (rect === null) throw new Error("missingCalibration said threadRect was set");
  return rect;
}

// A1 step 1: bundle paths and vendor dirs both mark an attributed process (TESTS.md §1.2). A host that stays open
// (ADES.md 3.0) is not killed: only its agent CLIs are.
export function adePidHints(adapter: Adapter, home: string): PidHints {
  const hints = adapter.processes();
  if (adapter.hostStaysOpen === true) {
    const entries = hints.agentExecutables;
    return { names: entries.filter((entry) => !entry.includes("/")), bundlePaths: entries.filter((entry) => entry.includes("/")) };
  }
  return { bundlePaths: [...hints.bundlePaths, ...hints.vendorDirs.map((dir) => expandHome(dir, home))] };
}

function expandHome(dir: string, home: string): string {
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  return dir;
}

// A1 steps 1-2: kill every attributed process and boot out the launch agents. Returns the pids still alive.
export async function killAdeProcesses(ctx: TestContext): Promise<number[]> {
  const hints = adePidHints(ctx.adapter, ctx.adapterCtx.home);
  // Agent CLIs are matched only under the host, never an agent session elsewhere on the machine.
  const find = () =>
    ctx.adapter.hostStaysOpen === true
      ? procsUnder(ctx.adapterCtx, launchPid(ctx), hints)
      : procsFor(ctx.adapterCtx, hints);
  // Three passes: a helper can respawn or take more than 10 s to leave (Diri A1, 2026-11-08).
  for (let pass = 1; pass <= 3; pass++) {
    const pids = (await find()).map((proc) => proc.pid);
    if (pids.length === 0) return [];
    killPids(ctx.adapterCtx, pids);
    for (const label of ctx.adapter.calibration.launchAgents) bootout(ctx.adapterCtx, label);
    await waitGone(ctx.adapterCtx, pids, 10_000);
  }
  const survivors = await find();
  if (survivors.length > 0) ctx.log(`still alive after 3 passes: ${survivors.map((proc) => `${proc.pid} ${proc.path}`).join(", ")}`);
  return survivors.map((proc) => proc.pid);
}

// Untimed hygiene before A1's and A2's quit (Adapter.beforeQuit). It only tidies the state the relaunch restores, so
// its failure is logged and written in the row's notes, and the repetition is measured. 2026-11-10, Orca: after a
// repetition's own quit the next step ran on a stopped app ("Could not read Orca runtime metadata ... Start the Orca
// app first") and made 13 rows invalid that 9 Nov had measured without the step.
export async function runBeforeQuit(ctx: TestContext, before: "relaunch" | "cold"): Promise<string | null> {
  try {
    await ctx.adapter.beforeQuit?.(ctx.adapterCtx, before);
    return null;
  } catch (error) {
    const reason = `before the ${before} quit: ${error instanceof Error ? error.message : String(error)}`;
    ctx.log(`${reason} (measured anyway)`);
    return reason;
  }
}

/** The notes key a failed step before the quit leaves on the row. */
export function beforeQuitNote(failed: string | null): Record<string, unknown> {
  return failed === null ? {} : { before_quit_failed: failed };
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

// Rule 5: a NativeError makes the row invalid with its reason; every other error is a harness error.
export async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (!(error instanceof NativeError)) throw error;
    return { ok: false, reason: nativeReason(error) };
  }
}

const NATIVE_REASONS = ["trigger_skipped", "not_frontmost"];

function nativeReason(error: NativeError): string {
  return NATIVE_REASONS.find((reason) => error.message.includes(reason)) ?? error.message;
}

export function parseReplayLog(text: string): ReplayRequestLog[] {
  const entries: ReplayRequestLog[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    entries.push(JSON.parse(line) as ReplayRequestLog);
  }
  return entries;
}

export function readReplayLog(path: string): ReplayRequestLog[] {
  return existsSync(path) ? parseReplayLog(readFileSync(path, "utf8")) : [];
}

// A4: the first request of the session at or after the Enter key (TESTS.md A4).
export function firstRequestAfter(
  entries: readonly ReplayRequestLog[],
  session: string,
  t0Ns: number,
): ReplayRequestLog | null {
  let earliest: ReplayRequestLog | null = null;
  for (const entry of entries) {
    if (entry.session !== session || entry.t_ns < t0Ns) continue;
    if (earliest === null || entry.t_ns < earliest.t_ns) earliest = entry;
  }
  return earliest;
}

export function replayControl(ctx: TestContext): ReplayControl | null {
  const value = ctx.state.get("replay");
  if (typeof value !== "object" || value === null) return null;
  const control = value as Partial<ReplayControl>;
  return typeof control.logPath === "string" && typeof control.port === "number" ? (value as ReplayControl) : null;
}

// The block publishes the control in state["replay"] (bench/run/loop.ts). Without it there is no log to read, so
// A4 must not guess a path that a later loop change could silently break.
export function replayLogPath(ctx: TestContext): string | null {
  return replayControl(ctx)?.logPath ?? null;
}

export interface LaunchRowOptions {
  /** Receipts of the first-launch tier get their own names, so the cold run cannot overwrite them. */
  filePrefix?: string;
  notesPrefix?: string;
  notesExtra?: Record<string, unknown>;
  /** A1: on a timeout, read the whole window once before the quit and name a probe that reached a shell. */
  readWindowOnTimeout?: boolean;
}

// 2026-11-09, Orca A1 rep-02 video at 1.2 s: Orca restored its tab by typing `claude --resume` into a fresh shell, a
// probe letter came first, and zsh answered "command not found: dclaude". The probes then went to the shell, outside
// the composer, and the row only said timed_out.
export const PROBE_IN_SHELL_REASON = "the probe reached the shell before the app's own restore command";

// One screenshot and one OCR of the window, untimed: the echo has already ended. Any failure keeps the plain timeout.
async function timeoutWindowReason(ctx: TestContext, shot: string): Promise<{ reason: string | null; lines: string[] | string }> {
  try {
    const pid = ctx.instruments.dryRun
      ? 0
      : mainAppPids(ctx.adapter.processes().bundlePaths, ctx.adapter.calibration.launchAgents)[0];
    if (pid === undefined) return { reason: null, lines: "no window to read" };
    await ctx.instruments.screenshot({ pid, out: shot });
    const { lines } = await ctx.instruments.ocr({ image: shot });
    return { reason: lines.some((line) => /command not found/i.test(line)) ? PROBE_IN_SHELL_REASON : null, lines };
  } catch (error) {
    return { reason: null, lines: `window not read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// A1 step 5-7 and A2 step 4-8: the gate, the launch echo and the quit that closes the repetition.
// Work: the instructions the app and its helpers ran until it was ready. Unlike wall time, a busy machine does not move it.
function launchWork(ctx: TestContext): number | null {
  if (ctx.instruments.dryRun || ctx.adapter.hostStaysOpen === true) return null;
  const [pid] = mainAppPids(ctx.adapter.processes().bundlePaths, ctx.adapter.calibration.launchAgents);
  return pid === undefined ? null : appUsage(pid).instructions;
}

export async function launchRow(
  ctx: TestContext,
  testId: TestId,
  rep: number,
  variant: string,
  triggers: readonly Trigger[],
  options: LaunchRowOptions = {},
): Promise<ResultRow> {
  const filePrefix = options.filePrefix ?? "";
  const frames = receipt(ctx, testId, rep, `${filePrefix}frames.json`);
  const video = receipt(ctx, testId, rep, `${filePrefix}video.mov`);
  const log = receipt(ctx, testId, rep, `${filePrefix}notes.md`);
  const fields = {
    testId,
    variant,
    rep,
    unit: "s",
    durationMs: 0,
    receipts: receiptFields(frames, video, log),
    notesPath: log.abs,
    notes: "",
  };
  const started = ctx.instruments.now();
  const calibration = ctx.adapter.calibration;
  const gates = await ctx.instruments.gates();
  if (!gates.cpu_quiet_ok) return timingInvalid(ctx, fields, "gate failure", { ...options.notesExtra, gates });
  const result = await attempt(() =>
    ctx.instruments.echo({
      // pid 0 waits for the app the open trigger starts; a host that stays open is already running.
      pid: ctx.adapter.hostStaysOpen === true ? launchPid(ctx) : 0,
      triggers: [...triggers],
      region: calibration.launchComposerRect ?? composerRectOf(ctx),
      focusClick: calibration.focusClick ?? undefined,
      probe: probeOf(ctx),
      intervalMs: PROBE_INTERVAL_MS,
      timeoutS: LAUNCH_TIMEOUT_S,
      frames: frames.abs,
      video: video.abs,
      masks: calibration.masks,
      clear: calibration.clearKeys,
    }),
  );
  const timedOut = result.ok && (result.value.timed_out || result.value.ready_ms === null);
  const shot = receipt(ctx, testId, rep, `${filePrefix}timeout-window.png`);
  const window = timedOut && options.readWindowOnTimeout === true ? await timeoutWindowReason(ctx, shot.abs) : null;
  const work = launchWork(ctx);
  await ctx.adapter.quit(ctx.adapterCtx);
  const durationMs = elapsedMs(ctx, started);
  // The extra notes (idle wait, a failed step before the quit) are kept on an invalid row too, so its reason has context.
  const extraNotes = options.notesExtra ?? {};
  if (!result.ok) return timingInvalid(ctx, { ...fields, durationMs }, result.reason, { ...extraNotes, gates });
  const echo = result.value;
  if (echo.timed_out || echo.ready_ms === null) {
    const extra = window === null ? {} : { timeout_window: shot.abs, timeout_window_ocr: window.lines };
    return timingInvalid(ctx, { ...fields, durationMs }, window?.reason ?? "timed_out", { ...extraNotes, gates, echo, ...extra });
  }
  const firstRead = firstReadCheck(ctx, frames.abs, echo);
  if (firstRead.reason !== null) {
    return timingInvalid(ctx, { ...fields, durationMs }, firstRead.reason, { ...extraNotes, gates, echo, ...firstRead.note });
  }
  return timingRow(
    ctx,
    {
      ...fields,
      durationMs,
      notes: `${options.notesPrefix ?? ""}${launchNotes(echo, { ...options.notesExtra, work_instructions: work, ...firstRead.note })}`,
    },
    echo.ready_ms / 1000,
  );
}

// Pilot 2026-10-20: in Zeron's font fast OCR read "Seeded" as "S8eded" in every frame, so A11 switch timed out while
// the short thread was on screen. "unchanged" (same reply, absent from the long thread) was read right every time. A3
// reads it too, as the marker of the old thread (ADEMARK-40).
export const SEED_MARKER = "unchanged";
// bb's OCR reads "unch3nged" (2026-11-08); one substitution, never letters added or dropped, so "changed" never counts.
export const SEED_FUZZY = 1;
// The end of the seed reply ("... and the repository is unchanged."). A3's Ready frame must show neither the marker nor
// this line. 2026-11-10, real window: Vision read the marker as "unch&nged", the "&" was dropped, and the word alone
// was not seen; the longer line still is, with up to 3 wrong letters.
export const SEED_LINE = "repository is unchanged";

/** The triggers without the waits after the last action (Orca's new thread ends with a 2.5 s wait). */
export function withoutTrailingWaits(triggers: readonly Trigger[]): Trigger[] {
  let end = triggers.length;
  while (end > 0 && triggers[end - 1]!.kind === "wait") end -= 1;
  return triggers.slice(0, end);
}


// ADEMARK-55, night of 10 Nov (control-2026-11-10T08-31-19Z-t3code-1): T3 Code 0.1.8 moved its new-thread composer
// 10 points down, and composerRect cut its first text line. The region read nothing while the app took keys, and the
// probe was first read when the box had grown to three lines: 88 characters, so A1, A2 and A3 gave the time until the
// text reached the region (11.5, 10.2 and 8.8 s; the video shows A3's echo at 0.2 s). The echo types one character every
// 50 ms, so a region in the right place first reads a short run. Every other valid A1 to A3 row of that night read 13
// characters or fewer at the first read. Two cycles of the probe is the limit.
export const LATE_PROBE_LIMIT = 2 * PROBE.length;
// The same 18 characters for a profile's own probe, whatever its length: the limit is typing time, about 0.9 s.

/** Lowercase letters and digits only, as the native ProbeMatcher.normalize (a bullet is read back as "e"). */
function normalizeProbeText(text: string): string {
  return text.toLowerCase().replaceAll("•", "e").replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The longest run of probe characters in one OCR line, in probe order. One misread letter ("q2" for "qz") or one
 * dropped letter does not end the run: a misread must never make a long first read look short.
 */
export function probeRunLength(line: string, probe: string = PROBE): number {
  const text = normalizeProbeText(line);
  const at = (index: number) => probe[index % probe.length]!;
  let best = 0;
  for (let start = 0; start < text.length; start++) {
    for (let offset = 0; offset < probe.length; offset++) {
      if (probe[offset] !== text[start]) continue;
      let position = start;
      let expected = offset;
      let length = 0;
      while (position < text.length) {
        if (text[position] === at(expected)) {
          position += 1;
          expected += 1;
          length = position - start;
        } else if (position + 1 < text.length && text[position + 1] === at(expected + 1)) {
          position += 1;
          expected += 1;
        } else if (text[position] === at(expected + 1)) {
          expected += 1;
        } else {
          break;
        }
      }
      best = Math.max(best, length);
    }
  }
  return best;
}

interface FrameLines {
  t_ns: number;
  ocr: string[];
}

export type FirstProbeRead = { chars: number; echo: boolean } | { unread: string };

/** The probe characters of the Ready frame (its t_ns is the echo's ready_ns), read from the echo's frames file. */
export function firstProbeRead(framesPath: string, readyNs: number, probe: string = PROBE): FirstProbeRead {
  if (!existsSync(framesPath)) return { unread: "the frames file is missing" };
  let frames: FrameLines[];
  try {
    frames = (JSON.parse(readFileSync(framesPath, "utf8")) as { frames: FrameLines[] }).frames;
  } catch (error) {
    return { unread: `the frames file is not readable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const ready = frames.find((frame) => frame.t_ns === readyNs);
  if (ready === undefined) return { unread: "the Ready frame is not in the frames file" };
  return { chars: Math.max(0, ...ready.ocr.map((line) => probeRunLength(line, probe))), echo: ready.ocr.some((line) => lineHoldsProbe(line, probe)) };
}

// ADEMARK-55 review R1, night of 10 Nov: the native rule takes any new probe pair in the region as Ready, and ordinary
// text holds such pairs. bb's A1 and A2 reached Ready on its placeholder ("... files, folders, or sections": "de"), and
// Traycer's A1 on its transcript ("parsed": "ar"), with nothing typed in sight. A real echo is a word of probe letters.
export const READY_NOT_PROBE = "Ready came from text that is not the probe";
// The pairs the probe can form, the last letter followed by the first.
const pairsOf = (probe: string): Set<string> => new Set([...probe].map((letter, index) => `${letter}${probe[(index + 1) % probe.length]}`));
// Other letters a real echo may hold: misread, dropped or added letters. Checked on every valid A1 to A3 row of 10 Nov:
// the real short echoes need up to 2 ("adern", "> Tharkqzl", ") rkgiadl"), the ordinary words that gave false Ready
// need 4 or more ("parsed", "folders", "det8ils", "De8crlb8").
const ECHO_OTHER_LETTERS = 2;
// The caret right after the typed text is read as one of these ("adl", "ozadl"); one such last letter is not counted.
const CARET_READS = new Set(["l", "i", "1"]);

/** Fewest edits that turn the word into some stretch of the repeated probe (substitutions, drops and additions). */
function editsFromProbe(word: string, probe: string): number {
  const text = probe.repeat(Math.ceil(word.length / probe.length) + 2);
  let previous = new Array<number>(text.length + 1).fill(0);
  for (let i = 1; i <= word.length; i++) {
    const current = [i];
    for (let j = 1; j <= text.length; j++) {
      const swap = previous[j - 1]! + (word[i - 1] === text[j - 1] ? 0 : 1);
      current.push(Math.min(swap, previous[j]! + 1, current[j - 1]! + 1));
    }
    previous = current;
  }
  return Math.min(...previous);
}

/** One OCR word that is a real echo: it holds a probe pair, and at most 2 other letters around the probe's order. */
export function wordIsProbe(raw: string, probe: string = PROBE): boolean {
  const word = normalizeProbeText(raw);
  const pairs = pairsOf(probe);
  let paired = false;
  for (let i = 0; i + 1 < word.length; i++) if (pairs.has(word.slice(i, i + 2))) paired = true;
  if (!paired) return false;
  const typed = word.length > 2 && CARET_READS.has(word.at(-1)!) ? word.slice(0, -1) : word;
  return editsFromProbe(typed, probe) <= ECHO_OTHER_LETTERS;
}

export function lineHoldsProbe(line: string, probe: string = PROBE): boolean {
  return line.split(/\s+/).some((word) => wordIsProbe(word, probe));
}

export function lateProbeReason(chars: number): string {
  return `the composer region read the probe late: ${chars} characters at the first read, so the region is not where the composer is`;
}

export const FIRST_READ_UNCHECKED = "the first read of the probe was not checked";

/**
 * The guard after a timed echo that reached Ready: null when the first read is short, or the reason that makes the row
 * invalid. A dry run writes no frames, and its rows are never published, so a missing file there is only a note.
 */
export function firstReadCheck(
  ctx: TestContext,
  framesPath: string,
  echo: NativeEcho,
): { reason: string | null; note: Record<string, unknown> } {
  if (echo.ready_ns === null) return { reason: FIRST_READ_UNCHECKED, note: {} };
  const probe = probeOf(ctx);
  const read = firstProbeRead(framesPath, echo.ready_ns, probe);
  if ("unread" in read) {
    if (ctx.instruments.dryRun) return { reason: null, note: { first_read_chars: `not checked in a dry run: ${read.unread}` } };
    return { reason: `${FIRST_READ_UNCHECKED}: ${read.unread}`, note: {} };
  }
  // A probe of the profile is named, so a reader knows which letters the frames should show.
  const note = probe === PROBE ? { first_read_chars: read.chars } : { first_read_chars: read.chars, probe };
  if (read.chars > LATE_PROBE_LIMIT) return { reason: lateProbeReason(read.chars), note };
  return { reason: read.echo ? null : READY_NOT_PROBE, note };
}
