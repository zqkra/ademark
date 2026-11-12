// `ademark summarize`: reads rows.jsonl and writes summary.json (TESTS.md 0.1) with paired CIs vs the Bare CLI.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResultRow } from "./contracts.ts";
import { isTie, pairedBootstrapCI, summary, type Summary } from "./stats.ts";

export interface GroupSummary {
  n: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  against_bare_cli: { lo: number; hi: number; diffMedian: number; tie: boolean; n_pairs: number } | null;
}

export interface RunSummary {
  run_id: string;
  rows: number;
  invalid_rows: number;
  generated_from: string;
  /** True for a smoke run: the summary opens with the rehearsal banner and is never published. */
  smoke: boolean;
  ades: Record<string, { family: string; tests: Record<string, GroupSummary> }>;
}

export const SMOKE_BANNER = "SMOKE RUN: rehearsal only, never published";

export const BARE_CLI_PREFIX = "bare-cli";

function isBareCli(ade: string): boolean {
  return ade === BARE_CLI_PREFIX || ade.startsWith(`${BARE_CLI_PREFIX}-`);
}

export function readRows(path: string): ResultRow[] {
  if (!existsSync(path)) throw new Error(`rows file not found: ${path}`);
  const rows: ResultRow[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (text.length === 0) continue;
    try {
      rows.push(JSON.parse(text) as ResultRow);
    } catch (error) {
      throw new Error(`rows.jsonl line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return rows;
}

function groupKey(row: ResultRow): string {
  return row.variant.length > 0 ? `${row.test_id}/${row.variant}` : row.test_id;
}

function validValue(row: ResultRow): number | null {
  return row.valid && row.value !== null ? row.value : null;
}

function medianOf(rows: readonly ResultRow[]): number | null {
  const values = rows.map(validValue).filter((value): value is number => value !== null);
  return values.length === 0 ? null : summary(values).median;
}

// Pair by (test, variant, rep): every ADE is run in the same order against the same replay sessions.
function pairedAgainst(rows: readonly ResultRow[], bare: readonly ResultRow[], seed: number) {
  const bareByKey = new Map<string, number>();
  for (const row of bare) {
    const value = validValue(row);
    if (value !== null) bareByKey.set(`${groupKey(row)}#${row.rep}`, value);
  }
  const a: number[] = [];
  const b: number[] = [];
  for (const row of rows) {
    const value = validValue(row);
    if (value === null) continue;
    const reference = bareByKey.get(`${groupKey(row)}#${row.rep}`);
    if (reference === undefined) continue;
    a.push(value);
    b.push(reference);
  }
  if (a.length === 0) return null;
  const ci = pairedBootstrapCI(a, b, { resamples: 10000, seed });
  return { lo: ci.lo, hi: ci.hi, diffMedian: ci.diffMedian, tie: isTie(ci), n_pairs: a.length };
}

export function summarizeRows(
  rows: readonly ResultRow[],
  seed = 1,
  options: { smoke?: boolean } = {},
): RunSummary {
  const runIds = [...new Set(rows.map((row) => row.run_id))];
  const ades: RunSummary["ades"] = {};
  const byAde = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = byAde.get(row.ade) ?? [];
    list.push(row);
    byAde.set(row.ade, list);
  }

  for (const [ade, adeRows] of byAde) {
    const family = adeRows[0]?.family ?? "";
    const bareRows = [...byAde.entries()]
      .filter(([other]) => isBareCli(other))
      .flatMap(([, list]) => list);
    const byTest = new Map<string, ResultRow[]>();
    for (const row of adeRows) {
      const key = groupKey(row);
      const list = byTest.get(key) ?? [];
      list.push(row);
      byTest.set(key, list);
    }
    const tests: Record<string, GroupSummary> = {};
    for (const [key, testRows] of byTest) {
      const values = testRows.map(validValue).filter((value): value is number => value !== null);
      const stats: Summary = summary(values);
      const comparable = isBareCli(ade) ? null : pairedAgainst(testRows, bareRows, seed);
      tests[key] = {
        n: stats.n,
        median: stats.median,
        p25: stats.p25,
        p75: stats.p75,
        min: stats.min,
        max: stats.max,
        against_bare_cli: comparable,
      };
    }
    ades[ade] = { family, tests };
  }

  return {
    run_id: runIds.length === 1 ? runIds[0]! : runIds.join(","),
    rows: rows.length,
    invalid_rows: rows.filter((row) => !row.valid).length,
    generated_from: "rows.jsonl",
    smoke: options.smoke === true,
    ades,
  };
}

// The manifest is the only place that knows the run's mode; rows alone do not carry it.
function isSmokeRun(runDir: string): boolean {
  const path = join(runDir, "manifest.json");
  if (!existsSync(path)) return false;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { mode?: string };
    return manifest.mode === "smoke";
  } catch {
    return false;
  }
}

export function summarizeRun(runDir: string): { path: string; summary: RunSummary } {
  const dir = resolve(runDir);
  const rows = readRows(join(dir, "rows.jsonl"));
  const result = summarizeRows(rows, 1, { smoke: isSmokeRun(dir) });
  const path = join(dir, "summary.json");
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return { path, summary: result };
}

export function formatSummary(summary: RunSummary): string {
  const lines: string[] = [];
  if (summary.smoke) lines.push(SMOKE_BANNER);
  lines.push(`run ${summary.run_id}: ${summary.rows} rows, ${summary.invalid_rows} invalid`);
  for (const [ade, entry] of Object.entries(summary.ades)) {
    for (const [test, stats] of Object.entries(entry.tests)) {
      const paired = stats.against_bare_cli;
      const suffix = paired
        ? `  vs bare-cli: ${paired.diffMedian.toFixed(3)} [${paired.lo.toFixed(3)}, ${paired.hi.toFixed(3)}] ${paired.tie ? "tie" : "differs"} (n=${paired.n_pairs})`
        : "";
      lines.push(`${ade.padEnd(20)} ${test.padEnd(10)} n=${stats.n} median=${stats.median.toFixed(3)}${suffix}`);
    }
  }
  return lines.join("\n");
}
