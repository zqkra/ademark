// What runs by day on the folders of a finished night, from any account: `ademark qa` and `ademark report`. Both only
// read the measured folders; they write their verdicts and report beside them, or under --out.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Agent } from "../core/contracts.ts";
import { supervised } from "../night/repair-real.ts";
import { loadRunners, type TestRunner } from "../run/registry.ts";
import { controlFiles } from "./files.ts";
import { foldersOf, isRehearsalId } from "./folders.ts";
import { finishedFolder, measuredFolder, pool, QA_PARALLEL, qaFolder, queueView, type QaVerdict, type Spawn } from "./qa.ts";
import { AGENTS, adeLabel, expectedTests, MEASURED_ADES, TRACKS } from "./real.ts";
import { buildRunReport, refuseRehearsal } from "./report.ts";
import { minimumsOf } from "./topup.ts";

export interface DayFolder {
  ade: string;
  kind: "attempt" | "top-up";
  attempt: number;
  dir: string;
  from: "queue" | "disk";
}

/** The queue that knows this run: the real one, else the dry one. Missing in both, the folders on disk decide. */
function databaseFor(root: string): string[] {
  return [controlFiles(false, root).database, controlFiles(true, root).database].filter((path) => existsSync(path));
}

/**
 * The folders of a run that hold its rows: for each app the adopted (or last) measure attempt, and each top-up.
 * A rehearsal is refused: its rows are never a measurement.
 */
export function dayFolders(root: string, runId: string, ades: readonly string[], agents: readonly Agent[] = AGENTS): DayFolder[] {
  refuseRehearsal(runId);
  const out: DayFolder[] = [];
  const databases = databaseFor(root);
  for (const ade of ades) {
    // The first queue that knows this app decides, also when it says the measure is not done: the disk must not then
    // make a measurement of a folder the queue left unfinished (review R2, 2026-11-10).
    const known = databases.map((database) => ({ database, view: queueView(database, runId, ade) })).find((entry) => entry.view !== null);
    const first = measuredFolder({ root, database: known?.database ?? "", runId, ade, agents });
    if (first === null) continue;
    out.push({ ade, kind: "attempt", attempt: first.attempt, dir: first.dir, from: first.from });
    // Every top-up that ran to its end, oldest first (ADEMARK-51). The queue names them; without it, a folder counts only
    // with rows and every block marker, so a cut attempt never does (review R3, 2026-11-10).
    const topUps = foldersOf(root, runId, ade).topUps;
    const numbers = known !== undefined ? known.view!.topUps.filter((attempt) => topUps.has(attempt))
      : [...topUps.keys()].sort((a, b) => a - b).filter((attempt) => finishedFolder(topUps.get(attempt)!, ade, agents));
    for (const attempt of numbers) out.push({ ade, kind: "top-up", attempt, dir: topUps.get(attempt)!, from: first.from });
  }
  return out;
}

export async function runQa(o: {
  root: string;
  runId: string;
  ades: readonly string[];
  out?: string;
  dryRun: boolean;
  spawn?: Spawn;
  print?: (line: string) => void;
}): Promise<QaVerdict[]> {
  const print = o.print ?? console.log;
  const folders = dayFolders(o.root, o.runId, o.ades);
  if (folders.length === 0) print(`qa: no measured folder of ${o.runId} under ${o.root}`);
  for (const entry of folders) print(`qa: ${entry.ade} ${entry.kind} ${entry.attempt} (${entry.from}): ${entry.dir}`);
  if (o.dryRun) {
    print("qa: dry run, no reviewer started");
    return [];
  }
  const spawn: Spawn = o.spawn ?? ((argv, timeoutMs, stdoutPath) => supervised(argv, timeoutMs, undefined, stdoutPath));
  const verdicts = await pool(folders, QA_PARALLEL, (entry) =>
    qaFolder(entry.ade, entry.dir, spawn, o.out === undefined ? entry.dir : join(o.out, basename(entry.dir))));
  for (const verdict of verdicts) print(`qa: ${verdict.ade} ${basename(verdict.dir)}: ${verdict.ok ? "pass" : `fail: ${verdict.note}`}`);
  return verdicts;
}

export async function writeDayReport(o: { root: string; runId: string; ades: readonly string[]; out?: string; runners?: Map<string, TestRunner> }): Promise<string> {
  if (isRehearsalId(o.runId)) refuseRehearsal(o.runId);
  const runners = o.runners ?? ((await loadRunners()) as Map<string, TestRunner>);
  const folders = dayFolders(o.root, o.runId, o.ades);
  const qaDir = (dir: string): string => (o.out === undefined ? dir : join(o.out, basename(dir)));
  const apps = o.ades.filter((ade) => folders.some((entry) => entry.ade === ade)).map((ade) => {
    const first = folders.find((entry) => entry.ade === ade && entry.kind === "attempt")!;
    const topUps = folders.filter((entry) => entry.ade === ade && entry.kind === "top-up").map((entry) => ({ attempt: entry.attempt, dir: entry.dir }));
    return {
      ade,
      label: adeLabel(ade),
      first: { attempt: first.attempt, dir: first.dir },
      topUps,
      expected: expectedTests(ade, TRACKS, runners),
      note: "",
      qaDir,
    };
  });
  const text = buildRunReport({ runId: o.runId, ended: true, apps, minimums: minimumsOf(runners), root: o.root });
  const dir = o.out ?? join(o.root, o.runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "report.md");
  writeFileSync(path, text);
  return path;
}

export const ALL_ADES: readonly string[] = MEASURED_ADES;
