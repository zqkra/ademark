// results/<run-id>/night.md: what was measured, what was skipped and why, and how the night ended. It is written even
// when the night stops early, from whatever is known at that moment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResultRow } from "../core/contracts.ts";
import type { CheckResult } from "../ops/doctor.ts";
import type { RunResult } from "../run/loop.ts";
import type { TrackLetter } from "../run/registry.ts";
import { NOT_SUPPORTED } from "../calibrate/pass.ts";
import { markOf } from "./known-failures.ts";
import { formatLocal } from "./plan.ts";
import type { RepairAttempt } from "./repair.ts";
import type { SkippedAde } from "./select.ts";

export interface NightRehearsal {
  runId: string;
  runDir: string;
  ades: string[];
  rows: number;
  failures: string[];
  passed: boolean;
}

export interface NightState {
  runId: string;
  seed: string;
  dryRun: boolean;
  tracks: readonly TrackLetter[];
  startedAt: string;
  endedAt: string | null;
  /** Why the night stopped early; null when it reached the end of its plan. */
  stopReason: string | null;
  warnings: string[];
  knownAdes: string[];
  chosen: string[];
  order: string[];
  skipped: SkippedAde[];
  plan: string | null;
  doctor: CheckResult[] | null;
  doctorTable: string | null;
  machine: string[];
  rehearsal: NightRehearsal | null;
  result: RunResult | null;
  /** Every self-repair attempt of the night, in order. Absent in reports written before step 7b. */
  repairs?: RepairAttempt[];
  runDir: string;
  /** The harness commit the night started at, used when the run wrote no manifest. */
  harnessCommit: string | null;
}

export type AdeStatus = "measured" | "skipped" | "skipped for time" | "not started";

export interface AdeTableRow {
  ade: string;
  status: AdeStatus;
  rows: number;
  invalid: number;
  /** Invalid rows that no approved accepted limit names (ADEMARK-45). */
  fresh: number;
  retried: string;
  duration: string;
  note: string;
}

export function readRunRows(runDir: string): ResultRow[] {
  const path = join(runDir, "rows.jsonl");
  if (!existsSync(path)) return [];
  const rows: ResultRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (text.length === 0) continue;
    rows.push(JSON.parse(text) as ResultRow);
  }
  return rows;
}

export function readManifestInfo(runDir: string): { machineId: string | null; harnessCommit: string | null } {
  const path = join(runDir, "manifest.json");
  if (!existsSync(path)) return { machineId: null, harnessCommit: null };
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { machine_id?: unknown; harness_commit?: unknown };
    return {
      machineId: typeof manifest.machine_id === "string" ? manifest.machine_id : null,
      harnessCommit: typeof manifest.harness_commit === "string" ? manifest.harness_commit : null,
    };
  } catch {
    return { machineId: null, harnessCommit: null };
  }
}

// Rows are the only per-ADE timing the run leaves behind: the span from the first row's start to the last row's end.
function durationOf(rows: readonly ResultRow[]): string {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const started = Date.parse(row.started_at);
    if (Number.isNaN(started)) continue;
    start = Math.min(start, started);
    end = Math.max(end, started + row.duration_ms);
  }
  if (!Number.isFinite(start)) return "-";
  return `${((end - start) / 60_000).toFixed(1)} min`;
}

export function adeRows(state: NightState, rows: readonly ResultRow[]): AdeTableRow[] {
  const byAde = new Map<string, ResultRow[]>();
  for (const row of rows) {
    // The control writes bare-cli-claude and an agent variant writes <ade>-own: both belong to the known ADE.
    const ade = state.knownAdes.find((known) => row.ade === known || row.ade.startsWith(`${known}-`)) ?? row.ade;
    const list = byAde.get(ade) ?? [];
    list.push(row);
    byAde.set(ade, list);
  }
  const skipReasons = new Map(state.skipped.map((skip) => [skip.ade, skip.reason]));
  const timeSkipped = new Set(state.result?.skippedForTime ?? []);
  const retried = new Set(state.result?.retried ?? []);
  const known = [...state.knownAdes, ...[...byAde.keys()].filter((ade) => !state.knownAdes.includes(ade))];

  const table: AdeTableRow[] = [];
  for (const ade of known) {
    const adeRows = byAde.get(ade) ?? [];
    const notes: string[] = [];
    let status: AdeStatus;
    if (adeRows.length > 0) {
      status = "measured";
      if (timeSkipped.has(ade)) notes.push("its retry was skipped: the deadline passed");
      const repaired = state.repairs?.find((entry) => entry.result === "repaired" && entry.ade === ade);
      if (repaired !== undefined) notes.push(`repaired: yes (${repaired.commit?.slice(0, 7) ?? "no commit"})`);
    } else if (skipReasons.has(ade)) {
      status = "skipped";
      notes.push(skipReasons.get(ade)!);
    } else if (timeSkipped.has(ade)) {
      status = "skipped for time";
      notes.push("the deadline passed before it started");
    } else if (state.chosen.includes(ade)) {
      status = "not started";
      notes.push("the night stopped before the run reached it");
    } else {
      continue;
    }
    table.push({
      ade,
      status,
      rows: adeRows.length,
      invalid: adeRows.filter((row) => !row.valid).length,
      fresh: adeRows.filter((row) => !row.valid && !(row.invalid_reason ?? "").startsWith(NOT_SUPPORTED) && markOf({ ...row, ade }) === "NEW").length,
      retried: adeRows.length === 0 || state.result === null ? "-" : retried.has(ade) ? "yes" : "no",
      duration: durationOf(adeRows),
      note: notes.join("; "),
    });
  }
  return table;
}

function markdownTable(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => " --- ").join("|")}|`,
    ...rows.map((row) => `| ${row.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function localStamp(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : `${iso} (${formatLocal(parsed)} local)`;
}

export function buildNightReport(state: NightState, rows: readonly ResultRow[]): string {
  const manifest = readManifestInfo(state.runDir);
  const table = adeRows(state, rows);
  const lines: string[] = [`# Night ${state.runId}`, ""];
  lines.push(`- NEW invalid rows: ${table.reduce((sum, row) => sum + row.fresh, 0)} (invalid rows that are not accepted limits; zero is the goal)`);
  lines.push(`- started: ${localStamp(state.startedAt)}`);
  lines.push(`- ended: ${state.endedAt === null ? "still running" : localStamp(state.endedAt)}`);
  lines.push(
    `- status: ${state.stopReason === null && state.endedAt !== null ? "finished" : `stopped: ${state.stopReason ?? "unknown"}`}`,
  );
  lines.push(`- tracks: ${state.tracks.join(",")}`);
  lines.push(`- seed: ${state.seed}`);
  lines.push(`- dry run: ${state.dryRun ? "yes" : "no"}`);
  lines.push(`- machine: ${manifest.machineId ?? "not collected"}`);
  lines.push(`- harness commit: ${manifest.harnessCommit ?? state.harnessCommit ?? "unknown"}`);
  lines.push("");

  lines.push("## ADEs", "");
  if (table.length === 0) {
    lines.push("The night stopped before choosing the ADEs.");
  } else {
    lines.push(
      markdownTable(
        ["ade", "status", "rows", "invalid rows", "NEW", "retried", "duration", "note"],
        table.map((row) => [
          row.ade,
          row.status,
          String(row.rows),
          String(row.invalid),
          String(row.fresh),
          row.retried,
          row.duration,
          row.note,
        ]),
      ),
    );
    lines.push("");
    lines.push("A row whose invalid reason starts with `not supported` does not fail a gate. Durations run from the first row's start to the last row's end.");
  }
  lines.push("");

  lines.push("## Skipped ADEs", "");
  if (state.skipped.length === 0) {
    lines.push("None.");
  } else {
    lines.push(markdownTable(["ade", "reason"], state.skipped.map((skip) => [skip.ade, skip.reason])));
  }
  lines.push("");

  if ((state.repairs ?? []).length > 0) {
    lines.push("## Repairs", "");
    lines.push(
      markdownTable(
        ["ade", "attempt", "result", "minutes", "commit", "diff", "note"],
        state.repairs!.map((entry) => [
          entry.ade,
          String(entry.attempt),
          entry.result,
          String(entry.minutes),
          entry.commit?.slice(0, 7) ?? "-",
          entry.diff ?? "-",
          entry.note,
        ]),
      ),
    );
    lines.push("");
  }

  lines.push("## Doctor", "");
  if (state.doctorTable === null) {
    lines.push("The night stopped before doctor ran.");
  } else {
    lines.push("```text", state.doctorTable, "```");
  }
  lines.push("");

  lines.push("## Rehearsal", "");
  if (state.rehearsal === null) {
    lines.push("The night stopped before the rehearsal.");
  } else {
    lines.push(`- run: ${state.rehearsal.runId}`);
    lines.push(`- ADEs: ${state.rehearsal.ades.join(", ")}`);
    lines.push(`- rows: ${state.rehearsal.rows}`);
    lines.push(`- result: ${state.rehearsal.passed ? "passed" : "failed"}`);
    for (const failure of state.rehearsal.failures) lines.push(`  - ${failure}`);
    if (state.dryRun) lines.push("- dry run: only that every block finished was checked, not row validity");
  }
  lines.push("");

  lines.push("## Machine", "");
  if (state.machine.length === 0) lines.push("The machine step did not run.");
  else lines.push("```text", state.machine.join("\n"), "```");
  lines.push("");

  if (state.plan !== null || state.warnings.length > 0) {
    lines.push("## Notes", "");
    for (const warning of state.warnings) lines.push(`- ${warning}`);
    if (state.plan !== null) {
      if (state.warnings.length > 0) lines.push("");
      lines.push("```text", state.plan, "```");
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function writeNightReport(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
