// ADEMARK-56: tests set aside after review. A review of the night of 10 Nov (ADEMARK-55) found valid rows with a wrong
// number. Rows on disk are evidence and never change, so the set-aside is applied when Control reads an attempt's rows
// (bench/control/qa.ts rowsIn): the rows of a listed test in a listed attempt count as not valid, the pass measures the
// test again in the same run, and the report shows why. An entry never makes a row valid. Rules: METHODOLOGY.md, top-up.
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import type { ResultRow } from "../core/contracts.ts";

export interface SetAside {
  /** The Control run: `control-2026-11-10T08-31-19Z`. */
  run: string;
  /** The Control app id. A row of an agent variant (`<ade>-own`) belongs to it too. */
  ade: string;
  test: string;
  /** `1` for the first measure attempt, `2` for the next one, `topup-1` for the first top-up. */
  attempt: string;
  /** One sentence: what the review found. */
  reason: string;
  /** A path under results/, from the attempt folder down to the receipt that shows it. */
  evidence: string;
  /** YYYY-MM-DD of the review. */
  date: string;
}

export const SET_ASIDE_PREFIX = "set aside after review: ";

const T3_STALE =
  "the composer region was stale after T3 Code updated itself to 0.1.8: the probe was first read at 88 characters, and " +
  "the video shows the app ready seconds earlier";
const T3_EVIDENCE =
  "control-2026-11-10T08-31-19Z-t3code-1/t3code/A3/rep-02/frames.json and control-2026-11-10T08-31-19Z-t3code-1/t3code/A3/rep-02/video.mov";

// Add an entry only with evidence from the receipts. The thread of ADEMARK-55 may name more rows of the same night.
export const SET_ASIDE: readonly SetAside[] = [
  ...["A1", "A2", "A3"].map((test) => ({
    run: "control-2026-11-10T08-31-19Z", ade: "t3code", test, attempt: "1", reason: T3_STALE, evidence: T3_EVIDENCE, date: "2026-11-10",
  })),
  {
    run: "control-2026-11-10T08-31-19Z",
    ade: "emdash",
    test: "A3",
    attempt: "1",
    reason: "Ready was accepted on one misread frame after 17 s, while the old thread was still on screen behind the Create Task modal",
    evidence: "control-2026-11-10T08-31-19Z-emdash-1/emdash/A3/rep-02/frames.json",
    date: "2026-11-10",
  },
  {
    run: "control-2026-11-10T08-31-19Z",
    ade: "synara",
    test: "A9",
    attempt: "1",
    reason: "the app had not quit when it was weighed: the quit opened a modal",
    evidence: "control-2026-11-10T08-31-19Z-synara-1/synara/A9/",
    date: "2026-11-10",
  },
  // Audit of 2026-11-11: every valid A1, A2 and A3 row of the night was checked for a real probe echo in its frames.
  {
    run: "control-2026-11-10T08-31-19Z",
    ade: "traycer",
    test: "A1",
    attempt: "2",
    reason:
      "Ready came from the restored thread's text, not from the probe: the composer region was over the transcript, and " +
      "the word parsed holds a probe pair. The docked composer already held the probe earlier",
    evidence: "control-2026-11-10T08-31-19Z-traycer-2/traycer/A1/rep-01/frames.json and control-2026-11-10T08-31-19Z-traycer-2/traycer/A1/rep-01/video.mov",
    date: "2026-11-11",
  },
  ...["A1", "A2"].map((test) => ({
    run: "control-2026-11-10T08-31-19Z",
    ade: "bb",
    test,
    attempt: "1",
    reason:
      "Ready came from the composer's placeholder (folders holds a probe pair), not from the probe: at Ready the " +
      "composer is empty in the video, because bb does not focus it after a launch and the profile had no focus click",
    evidence: "control-2026-11-10T08-31-19Z-bb-1/bb/A1/rep-01/frames.json and control-2026-11-10T08-31-19Z-bb-1/bb/A1/rep-01/video.mov",
    date: "2026-11-11",
  })),
];

/** The name of the attempt folder an entry names, without the `-dry` of a dry run. */
export function folderOf(entry: SetAside): string {
  return `${entry.run}-${entry.ade}-${entry.attempt}`;
}

/** A dry Control writes `<id>-dry`: the same attempt, so a copy of a real night in a dry Control sees the same list. */
function nameOf(dir: string): string {
  return basename(dir).replace(/-dry$/, "");
}

function belongs(rowAde: string, ade: string): boolean {
  return rowAde === ade || rowAde.startsWith(`${ade}-`);
}

export function isSetAside(row: { invalid_reason: string | null }): boolean {
  return (row.invalid_reason ?? "").startsWith(SET_ASIDE_PREFIX);
}

/** The entries that name this attempt folder. */
export function entriesFor(dir: string, entries: readonly SetAside[] = SET_ASIDE): SetAside[] {
  const name = nameOf(dir);
  return entries.filter((entry) => folderOf(entry) === name);
}

/**
 * The rows of an attempt folder as Control counts them: each row of a listed test is not valid, with the reason of its
 * entry. It returns new objects; the rows it was given, and the file they came from, stay as they are.
 */
export function applySetAside(dir: string, rows: readonly ResultRow[], entries: readonly SetAside[] = SET_ASIDE): ResultRow[] {
  const mine = entriesFor(dir, entries);
  if (mine.length === 0) return [...rows];
  return rows.map((row) => {
    const entry = mine.find((candidate) => candidate.test === row.test_id && belongs(row.ade, candidate.ade));
    return entry === undefined ? row : { ...row, valid: false, invalid_reason: `${SET_ASIDE_PREFIX}${entry.reason}` };
  });
}

/**
 * Entries that change nothing in a report, with why: one of this run whose folder the report does not read or that has
 * no row of the test, or one of a run with no folder under `root`. `read` is each folder the report read, with its rows.
 */
export function unusedEntries(o: {
  runId: string;
  read: readonly { dir: string; rows: readonly ResultRow[] }[];
  root?: string;
  entries?: readonly SetAside[];
}): { entry: SetAside; why: string }[] {
  const entries = o.entries ?? SET_ASIDE;
  const out: { entry: SetAside; why: string }[] = [];
  const names = o.root !== undefined && existsSync(o.root) ? readdirSync(o.root) : null;
  for (const entry of entries) {
    if (entry.run !== o.runId) {
      if (names !== null && !names.some((name) => name.startsWith(`${entry.run}-`))) out.push({ entry, why: `no folder of run ${entry.run}` });
      continue;
    }
    const folder = o.read.find((item) => nameOf(item.dir) === folderOf(entry));
    if (folder === undefined) out.push({ entry, why: `the report reads no folder ${folderOf(entry)}` });
    else if (!folder.rows.some((row) => row.test_id === entry.test && belongs(row.ade, entry.ade))) out.push({ entry, why: `${folderOf(entry)} has no row of ${entry.test}` });
  }
  return out;
}
