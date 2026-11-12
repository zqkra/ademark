// Re-scores a finished Track B block from its own receipts with the current rules, and lists every row the receipts do
// not reproduce. Read only. The audit of 10 Nov (Track A) found wrong numbers that looked valid; the same audit of the B
// rows of 6 Nov found B3 rows about 2.5 times the capture, made by a harness older than the current split.
//
//   bun bench/tracks/b/rescore.ts <run folder>
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CaptureRow, ResultRow } from "../../core/contracts.ts";
import { priceFile } from "../../core/paths.ts";
import { loadTask } from "../../core/tasks.ts";
import { reconcile } from "../../capture/telemetry.ts";
import { classifyMainThread, isCompletion, priceRows, splitComponents, threadShape, totalComponents, type PriceFile } from "../../capture/tokens.ts";

export interface RepRescore {
  ade: string;
  test: "B1" | "B3";
  rep: number;
  valid: boolean;
  main: number;
  side: number;
  /** Variants whose recorded value the receipts do not give again. */
  differences: string[];
}

export interface BlockRescore {
  reps: RepRescore[];
  /** Problems with the block itself: no manifest, another price file. */
  notes: string[];
}

const TASK_FOR = { B1: "B1-hello", B3: "B3-real-prompt" } as const;

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function same(recorded: number | null, now: number | null): boolean {
  if (recorded === null || now === null) return recorded === now;
  return Math.abs(recorded - now) <= 1e-9 * Math.max(1, Math.abs(now));
}

export function rescoreBlock(runDir: string, prices: PriceFile = JSON.parse(readFileSync(priceFile(), "utf8")) as PriceFile): BlockRescore {
  const notes: string[] = [];
  const manifestPath = join(runDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const recorded = (JSON.parse(readFileSync(manifestPath, "utf8")) as { price_file_sha256?: string | null }).price_file_sha256 ?? null;
    const current = createHash("sha256").update(readFileSync(priceFile())).digest("hex");
    if (recorded !== current) notes.push(`price file ${recorded?.slice(0, 12) ?? "none"} in the manifest, ${current.slice(0, 12)} now`);
  } else {
    notes.push("no manifest");
  }
  const rows = jsonl<ResultRow>(join(runDir, "rows.jsonl")).filter((row) => row.test_id === "B1" || row.test_id === "B3");
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = `${row.test_id}|${row.rep}|${row.receipts.capture}|${row.receipts.log}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const reps: RepRescore[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const test = first.test_id as "B1" | "B3";
    const differences: string[] = [];
    const window = first.receipts.log === null ? null : readFileSync(join(runDir, first.receipts.log), "utf8").match(/window: (\d+) -> (\d+) ns/);
    if (first.receipts.capture === null || window === null) {
      reps.push({ ade: first.ade, test, rep: first.rep, valid: group.every((row) => row.valid), main: 0, side: 0, differences: ["no capture or window in the receipts"] });
      continue;
    }
    const capturePath = join(runDir, first.receipts.capture);
    const startNs = Number(window[1]);
    const endNs = Number(window[2]);
    const all = reconcile(jsonl<CaptureRow>(capturePath), jsonl<CaptureRow>(`${capturePath}.telemetry.jsonl`));
    const completions = all.filter((row) => row.t_ns >= startNs && row.t_ns <= endNs && isCompletion(row));
    const shapeOf = (row: CaptureRow) => {
      if (row.body_file === null) return null;
      try {
        return threadShape(JSON.parse(readFileSync(join(dirname(capturePath), row.body_file), "utf8")));
      } catch {
        return null;
      }
    };
    const classified = classifyMainThread(completions, loadTask(TASK_FOR[test]).prompt, shapeOf);
    const main = classified.filter((row) => row.main_thread === true);
    const split = splitComponents(classified);
    const now: Record<string, number | null> = {
      "fresh-input": split.main.input,
      "cache-write": split.main.cache_write,
      "cache-read": split.main.cache_read,
      output: split.main.output,
      "side-tokens": totalComponents(split.side),
      usd: priceRows(classified, prices).usd,
      requests: main.length,
    };
    // Only a valid row claims a number. A row taken from the session log is not in the capture, so it is named apart.
    for (const row of group) {
      if (!row.valid || !(row.variant in now)) continue;
      if (row.value === null) {
        differences.push(`${row.variant}: valid with no value`);
        continue;
      }
      if (same(row.value, now[row.variant]!)) continue;
      const fromLog = row.notes.includes("tokens from session log") || row.notes.includes("from session log, capture empty");
      differences.push(`${row.variant}: row ${row.value}, capture ${now[row.variant]}${fromLog ? " (row from the session log)" : ""}`);
    }
    if (group.some((row) => row.valid) && main.some((row) => row.model !== first.model)) {
      differences.push(`main model ${main.find((row) => row.model !== first.model)!.model}, row model ${first.model}`);
    }
    reps.push({ ade: first.ade, test, rep: first.rep, valid: group.every((row) => row.valid), main: main.length, side: classified.length - main.length, differences });
  }
  reps.sort((a, b) => a.ade.localeCompare(b.ade) || a.test.localeCompare(b.test) || a.rep - b.rep);
  return { reps, notes };
}

if (import.meta.main) {
  const runDir = process.argv[2];
  if (runDir === undefined) {
    console.error("usage: bun bench/tracks/b/rescore.ts <run folder>");
    process.exit(2);
  }
  const result = rescoreBlock(runDir);
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const rep of result.reps) {
    const status = rep.differences.length === 0 ? "reproduced" : `NOT REPRODUCED: ${rep.differences.join("; ")}`;
    console.log(`${rep.ade} ${rep.test} rep ${rep.rep} ${rep.valid ? "valid" : "invalid"} main ${rep.main} side ${rep.side}: ${status}`);
  }
  process.exit(result.reps.some((rep) => rep.differences.length > 0) ? 1 : 0);
}
