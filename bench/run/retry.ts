// Retry support (RUNBOOK.md §7): a stopped block runs again at the end of the night. The earlier rows and receipts
// stay in the run folder as attempt 1, so the published rows are always the last attempt.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Agent, ResultRow } from "../core/contracts.ts";
import { MODEL_PINS } from "./models.ts";
import { TRACK_ORDER, type TrackLetter } from "./registry.ts";

export const DONE_MARKER = ".done";
export const SUPERSEDED_ROWS = "rows-superseded.jsonl";

// A block is one (track, agent) pair, so its marker names both: the finished agent of a stopped track keeps its
// marker, the stopped one does not.
export function blockMarker(runDir: string, rowAde: string, track: TrackLetter, agent: Agent): string {
  return join(runDir, rowAde, `${track}-${agent}${DONE_MARKER}`);
}

/** Before ADEMARK-17 one marker covered every agent of a track. */
export function legacyMarker(runDir: string, rowAde: string, track: TrackLetter): string {
  return join(runDir, rowAde, `${track}${DONE_MARKER}`);
}

// `legacyDone` honors an old `<track>.done` marker, which an old run wrote once for the whole track: only a row ade
// whose track has a single block may read it, or one stopped agent would hide behind another agent's marker.
export function blockIsDone(
  runDir: string,
  rowAde: string,
  track: TrackLetter,
  agent: Agent,
  legacyDone = false,
): boolean {
  if (existsSync(blockMarker(runDir, rowAde, track, agent))) return true;
  return legacyDone && existsSync(legacyMarker(runDir, rowAde, track));
}

export function attemptFolder(runDir: string, rowAde: string, retry: number): string {
  return join(runDir, `${rowAde}.attempt-${retry}`);
}

// A resumed run may retry the same block again: never overwrite an earlier attempt folder.
export function freeAttemptFolder(runDir: string, rowAde: string, retry: number): string {
  let attempt = retry;
  let folder = attemptFolder(runDir, rowAde, attempt);
  while (existsSync(folder)) {
    attempt += 1;
    folder = attemptFolder(runDir, rowAde, attempt);
  }
  return folder;
}

export interface BlockId {
  rowAde: string;
  track: TrackLetter;
  agent: Agent;
}

interface RowMove extends BlockId {
  label: string;
  attemptDir: string;
}

// Rows carry the pinned model, so one agent's rows never move with another agent's block of the same track.
function moveRows(runDir: string, o: RowMove): number {
  const rowsPath = join(runDir, "rows.jsonl");
  if (!existsSync(rowsPath)) return 0;
  const testIds = new Set<string>(TRACK_ORDER[o.track]);
  const model = MODEL_PINS[o.agent].model;
  const kept: string[] = [];
  const superseded: string[] = [];
  for (const line of readFileSync(rowsPath, "utf8").split("\n")) {
    const text = line.trim();
    if (text.length === 0) continue;
    const row = JSON.parse(text) as ResultRow;
    if (row.ade === o.rowAde && testIds.has(row.test_id) && row.model === model) {
      superseded.push(JSON.stringify({ ...row, superseded_by: o.label, attempt_dir: o.attemptDir }));
    } else {
      kept.push(text);
    }
  }
  if (superseded.length === 0) return 0;
  writeFileSync(rowsPath, kept.length === 0 ? "" : `${kept.join("\n")}\n`);
  appendFileSync(join(runDir, SUPERSEDED_ROWS), `${superseded.join("\n")}\n`);
  return superseded.length;
}

// TESTS.md §0.2: the per-track test ids are the block's receipt folders; Track B adds the agent after the test id.
function receiptPaths(o: BlockId): string[][] {
  return TRACK_ORDER[o.track].map((testId) => (o.track === "B" ? [testId, o.agent] : [testId]));
}

// Only the block's own receipts move, keeping their relative layout. Other blocks of the row ade keep theirs, and
// every marker stays where it is.
function moveReceipts(runDir: string, o: BlockId, attemptDir: string): number {
  let moved = 0;
  for (const relative of receiptPaths(o)) {
    const from = join(runDir, o.rowAde, ...relative);
    if (!existsSync(from)) continue;
    const to = join(attemptDir, ...relative);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    moved += 1;
  }
  return moved;
}

/**
 * Called just before a stopped block runs again, never for a block whose marker exists. `attempt` is the folder of
 * this retry pass, shared by every stopped block of the row ade.
 */
export function supersedeBlock(
  runDir: string,
  rowAde: string,
  track: TrackLetter,
  agent: Agent,
  retry: number,
  attempt: string = freeAttemptFolder(runDir, rowAde, retry),
): void {
  const moved =
    moveRows(runDir, { rowAde, track, agent, label: `retry ${retry}`, attemptDir: basename(attempt) }) +
    moveReceipts(runDir, { rowAde, track, agent }, attempt);
  // The rows name the attempt folder, so it exists even when the block left no receipt behind.
  if (moved > 0) mkdirSync(attempt, { recursive: true });
}
