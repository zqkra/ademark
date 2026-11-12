// Writes src/data/results.json, the only source of numbers on the site.
//
// Inputs (both are in the repository, in data/v1, redacted by bench/export/export.ts):
// 1. The medians of the night, one file per run, made with the harness's merge rule
//    (bench/control/topup.ts mergeAttempts): ADEMARK_SUMMARY, default data/v1/summary.json.
// 2. The raw rows of the token blocks: ADEMARK_RESULTS, default data/v1/runs.
//    B1 and B3 totals are summed per repetition from these rows, never from the medians of their parts.
//
// Run: bun scripts/results.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SUMMARY = process.env.ADEMARK_SUMMARY ?? new URL("../../data/v1/summary.json", import.meta.url).pathname;
const RESULTS = process.env.ADEMARK_RESULTS ?? new URL("../../data/v1/runs", import.meta.url).pathname;
const OUT = new URL("../src/data/results.json", import.meta.url).pathname;

type Stat = { m: number; lo: number; hi: number; n: number };
type Gap = { why: string };

const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const stat = (xs: number[]): Stat => ({ m: median(xs), lo: Math.min(...xs), hi: Math.max(...xs), n: xs.length });

const PARTS = ["fresh-input", "cache-write", "cache-read", "output", "side-tokens"];

function tokenTotals(folder: string | null, test: "B1" | "B3") {
  if (!folder) return null;
  const rows = readFileSync(join(RESULTS, folder, "rows.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.test_id === test && r.valid);
  const reps = new Map<number, Record<string, number>>();
  for (const r of rows) {
    const rep = reps.get(r.rep) ?? {};
    rep[r.variant] = r.value;
    reps.set(r.rep, rep);
  }
  const whole = [...reps.values()].filter((rep) => PARTS.every((p) => typeof rep[p] === "number"));
  if (!whole.length) return null;
  return {
    total: stat(whole.map((rep) => PARTS.reduce((sum, p) => sum + rep[p], 0))),
    cacheWrite: whole.map((rep) => rep["cache-write"]),
  };
}

const apps: Record<string, unknown> = {};
for (const [id, app] of Object.entries<any>(summary.apps)) {
  const tests: Record<string, Stat | Gap> = {};
  let version = "";
  for (const [rawKey, t] of Object.entries<any>(app.tests)) {
    const key = rawKey.replace(/ \[.*\]$/, "");
    version ||= t.app_version ?? "";
    tests[key] =
      t.median === null || t.median === undefined
        ? { why: t.reason ?? "no valid row" }
        : { m: t.median, lo: t.min, hi: t.max, n: t.n };
  }
  const b1 = tokenTotals(app.folders?.tokens ?? null, "B1");
  const b3 = tokenTotals(app.folders?.tokens ?? null, "B3");
  if (b1) {
    tests["B1/total"] = b1.total;
    tests["B1/cache-write-runs"] = { m: median(b1.cacheWrite), lo: Math.min(...b1.cacheWrite), hi: Math.max(...b1.cacheWrite), n: b1.cacheWrite.length };
  }
  if (b3) tests["B3/total"] = b3.total;
  const b2 = ["system", "tools", "mcp-tools", "injected", "params"].map((p) => tests[`B2/${p}`]);
  if (b2.every((s) => s && "m" in s)) {
    const sum = (b2 as Stat[]).reduce((acc, s) => acc + s.m, 0);
    tests["B2/total"] = { m: sum, lo: sum, hi: sum, n: 1 };
  }
  apps[id] = { version, tests };
}

const out = {
  run: summary.run,
  machine: summary.machine,
  model: summary.model,
  effort: summary.effort,
  generated: summary.generated,
  apps,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${OUT}`);
