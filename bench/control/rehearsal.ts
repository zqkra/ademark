// rehearsal.md (ADEMARK-44): one smoke lap of every app on the real screen, by day, so the night is no longer the test.
// The agent reads it from the owner's account and fixes from the evidence. Its first line is the count that decides the night:
// invalid rows that are not accepted limits.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultRow } from "../core/contracts.ts";
import { isRehearsalId } from "./folders.ts";
import { freshCount, lineText, testLines, type TestLine } from "./verdicts.ts";

export interface RehearsalApp {
  ade: string;
  label: string;
  /** The task status: done, failed, pending, running, skipped. */
  status: string;
  note: string;
  minutes: number | null;
  rows: readonly ResultRow[];
  /** The tests this app should have run; a test with no row shows as missing. */
  expected: readonly string[];
}

/** What rehearsal.json keeps for the next lap's "Changed" section: one text per row ade and test. */
export type RehearsalLines = Record<string, string>;

/** The code a lap ran on: the harness commit and the hash of the measuring inputs (bench/native/bin, snapshots). */
export interface CodeId {
  commit: string | null;
  inputs: string | null;
}

export interface RehearsalFile {
  run_id: string;
  dry: boolean;
  /** False while the lap still runs. Files written before 2026-11-10 have none. */
  ended?: boolean;
  commit?: string | null;
  inputs?: string | null;
  fresh: number;
  lines: RehearsalLines;
}

const keyOf = (line: TestLine): string => `${line.rowAde} ${line.test}`;

/** The newest rehearsal before `runId` of the same kind (dry or real) that left a report, or null. */
export function previousRehearsal(root: string, runId: string, dry: boolean): RehearsalFile | null {
  if (!existsSync(root)) return null;
  const mine = dry ? `${runId}-dry` : runId;
  const names = readdirSync(root)
    .filter((name) => isRehearsalId(name) && name.endsWith("-dry") === dry && name < mine)
    .sort()
    .reverse();
  // The lap's own app folders (`-smoke`) hold no rehearsal.json, so only run folders answer.
  for (const name of names) {
    const path = join(root, name, "rehearsal.json");
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RehearsalFile;
    } catch {
      continue;
    }
  }
  return null;
}

/** The newest rehearsal of this kind (dry or real), finished or not. */
export function latestRehearsal(root: string, dry: boolean): RehearsalFile | null {
  // "~" sorts after every time stamp, so every lap is older than it.
  return previousRehearsal(root, "rehearsal-~", dry);
}

export interface RehearsalWarning {
  /** "ok" only for a finished lap with 0 NEW on the commit and inputs of now; any other case is a warning. */
  level: "ok" | "warn";
  text: string;
}

/**
 * The line the panel shows at Start and at New run (review R2, 2026-11-10). It never blocks: on 7 Nov a gate stopped 13
 * of 15 apps, so the rule "start only after a clean rehearsal" (RUNBOOK.md) stays the owner's call.
 */
export function rehearsalWarning(last: RehearsalFile | null, now: CodeId): RehearsalWarning {
  if (last === null) return { level: "warn", text: "No rehearsal yet: press Rehearse by day before a night." };
  const head = `Last rehearsal ${last.run_id}: ${last.fresh} NEW`;
  const short = (text: string | null | undefined): string => (text == null ? "unknown" : text.slice(0, 7));
  const reasons: string[] = [];
  if (last.ended !== true) reasons.push("it did not finish");
  if (last.fresh > 0) reasons.push(`${last.fresh} invalid rows are not accepted limits`);
  if (last.commit == null || last.commit !== now.commit) reasons.push(`it ran on commit ${short(last.commit)}, now ${short(now.commit)}`);
  if (last.inputs == null || last.inputs !== now.inputs) reasons.push("the measuring inputs (bench/native/bin, snapshots) changed since");
  if (reasons.length === 0) return { level: "ok", text: `${head}, on this commit and these inputs.` };
  return { level: "warn", text: `${head}. Warning: ${reasons.join("; ")}. Start still works.` };
}

/** Only apps of this lap are compared: a lap limited to two apps says nothing about the other thirteen. */
export function changes(now: RehearsalLines, before: RehearsalLines | null, ades: readonly string[]): string[] {
  if (before === null) return ["No earlier rehearsal to compare with."];
  const ours = (key: string): boolean => ades.some((ade) => key === ade || key.startsWith(`${ade} `) || key.startsWith(`${ade}-`));
  const out: string[] = [];
  for (const [key, text] of Object.entries(now)) {
    const old = before[key];
    if (old === undefined) out.push(`- ${key}: new, ${text}`);
    else if (old !== text) out.push(`- ${key}: ${old} -> ${text}`);
  }
  for (const key of Object.keys(before)) {
    if (ours(key) && now[key] === undefined) out.push(`- ${key}: gone (was ${before[key]})`);
  }
  return out.length === 0 ? ["Nothing changed."] : out;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function buildRehearsal(o: { runId: string; dry: boolean; ended: boolean; apps: readonly RehearsalApp[]; previous: RehearsalFile | null; code?: CodeId }):
  { markdown: string; file: RehearsalFile } {
  const lines: RehearsalLines = {};
  let fresh = 0;
  const body: string[] = [];
  for (const app of o.apps) {
    const started = app.status !== "pending";
    const tests = started ? testLines(app.ade, app.rows, app.expected) : [];
    fresh += freshCount(tests);
    const minutes = app.minutes === null ? "-" : `${app.minutes} min`;
    body.push(`## ${app.label} (${app.ade})`, "", `- step: ${app.status}${app.note.length > 0 ? `: ${app.note}` : ""}`, `- time: ${minutes}`, "");
    if (!started) {
      body.push("Not run yet.", "");
      continue;
    }
    body.push("| test | result |", "| --- | --- |");
    for (const line of tests) {
      lines[keyOf(line)] = lineText(line);
      const name = line.rowAde === app.ade ? line.test : `${line.test} (${line.rowAde})`;
      body.push(`| ${name} | ${cell(lineText(line))} |`);
    }
    body.push("");
  }
  const out = [
    `${fresh} invalid rows that are not accepted limits (NEW)`,
    "",
    `# Rehearsal ${o.runId}`,
    "",
    `- status: ${o.ended ? "finished" : "running"}`,
    `- dry run: ${o.dry ? "yes" : "no"}`,
    "- smoke rows: never a measurement, never published. A1, A2 and A3 ran 3 repetitions, every other test 1.",
    "- an invalid row is `accepted limit` only when the owner approved its entry in bench/night/known-failures.ts; every other invalid row and every missing test is NEW.",
    "",
    ...body,
    "## Changed since the last rehearsal",
    "",
    ...changes(lines, o.previous?.lines ?? null, o.apps.filter((app) => app.status !== "pending").map((app) => app.ade)),
  ];
  return {
    markdown: `${out.join("\n")}\n`,
    file: { run_id: o.runId, dry: o.dry, ended: o.ended, commit: o.code?.commit ?? null, inputs: o.code?.inputs ?? null, fresh, lines },
  };
}

export function writeRehearsal(dir: string, built: { markdown: string; file: RehearsalFile }): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rehearsal.json"), `${JSON.stringify(built.file, null, 2)}\n`);
  const path = join(dir, "rehearsal.md");
  writeFileSync(path, built.markdown);
  return path;
}
