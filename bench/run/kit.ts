// Small shared helpers for wave 2b track runners: receipts, invalid rows, calibration, sampler CSVs.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Adapter, Receipts, ResultRow, TestId } from "../core/contracts.ts";
import { SAMPLE_COLUMNS } from "../core/contracts.ts";
import type { RowFields, TestContext } from "./context.ts";

// TESTS.md §0.1: the MB unit of every RAM row.
export const BYTES_PER_MB = 1_048_576;

export function emptyReceipts(): Receipts {
  return { samples: null, video: null, frames: null, capture: null, log: null };
}

export interface ReceiptPath {
  abs: string;
  /** Relative to the run folder, the form ResultRow.receipts uses. */
  rel: string;
}

export function receipt(ctx: TestContext, testId: TestId, rep: number, file: string): ReceiptPath {
  if (file.length === 0 || isAbsolute(file) || file.split("/").includes("..")) {
    throw new Error(`receipt: unsafe file name "${file}"`);
  }
  const abs = join(ctx.receiptDir(testId, rep), file);
  const rel = relative(ctx.runDir, abs).split(sep).join("/");
  return { abs, rel };
}

export function invalidRow(
  ctx: TestContext,
  fields: Omit<RowFields, "value" | "valid" | "invalid_reason">,
  reason: string,
): ResultRow {
  return ctx.row({ ...fields, value: null, valid: false, invalid_reason: reason });
}

export type CalibrationKey =
  | "composerRect"
  | "threadRect"
  | "launch"
  | "newThread"
  | "send"
  | "longThread"
  | "shortThread";

// A missing calibration field or trigger list means the runner cannot drive the ADE (TESTS.md §1.7).
export function missingCalibration(adapter: Adapter, keys: readonly CalibrationKey[]): string | null {
  for (const key of keys) {
    if (key === "composerRect" || key === "threadRect") {
      const rect = adapter.calibration[key];
      if (rect === null || rect.w <= 0 || rect.h <= 0) return `not calibrated: ${key}`;
      continue;
    }
    const triggers = adapter.timed[key];
    if (triggers === undefined || triggers.length === 0) return `not calibrated: ${key}`;
  }
  return null;
}

export interface SampleRow {
  t_ns: number;
  pid: number;
  ppid: number;
  group: string;
  exe: string;
  phys_footprint_b: number;
  lifetime_max_b: number;
  cpu_user_ns: number;
  cpu_sys_ns: number;
  wakeups_idle: number;
  wakeups_irq: number;
  energy_nj: number;
}

const STRING_COLUMNS = new Set<string>(["exe", "group"]);
const NUMERIC_COLUMNS = SAMPLE_COLUMNS.filter((column) => !STRING_COLUMNS.has(column)) as ReadonlyArray<
  keyof Omit<SampleRow, "exe" | "group">
>;

// Minimal CSV field splitter: the sampler quotes and doubles quotes only inside `exe`.
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

export function readSamples(csvPath: string): SampleRow[] {
  const text = readFileSync(csvPath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const header = lines.shift();
  if (header !== SAMPLE_COLUMNS.join(",")) {
    throw new Error(`readSamples: ${csvPath} header is not SAMPLE_COLUMNS`);
  }
  return lines.map((line, index) => {
    const fields = splitCsvLine(line);
    if (fields.length !== SAMPLE_COLUMNS.length) {
      throw new Error(`readSamples: ${csvPath} line ${index + 2} has ${fields.length} columns`);
    }
    const value: Record<string, string> = {};
    for (const [index, column] of SAMPLE_COLUMNS.entries()) value[column] = fields[index]!;
    const row: Record<string, number | string> = { exe: value.exe!, group: value.group! };
    for (const column of NUMERIC_COLUMNS) {
      const raw = value[column]!;
      const parsed = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(parsed)) {
        throw new Error(`readSamples: ${csvPath} line ${index + 2} column ${column} is not a number: "${raw}"`);
      }
      row[column] = parsed;
    }
    return row as unknown as SampleRow;
  });
}

// Per-tick sums, the series the weight tests publish (TESTS.md §1.2).
export function groupSeries(
  rows: readonly SampleRow[],
  group: "app" | "agents" | "total",
): Array<{ t_ns: number; bytes: number }> {
  const sums = new Map<number, number>();
  for (const row of rows) {
    if (group !== "total" && row.group !== group) continue;
    sums.set(row.t_ns, (sums.get(row.t_ns) ?? 0) + row.phys_footprint_b);
  }
  return [...sums.entries()]
    .sort(([left], [right]) => left - right)
    .map(([t_ns, bytes]) => ({ t_ns, bytes }));
}
