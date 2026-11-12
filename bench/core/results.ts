// Writes one run: rows.jsonl, events.log and the per-repetition receipt folders (TESTS.md 0.1-0.3).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resultsRoot } from "./paths.ts";
import type { ResultRow, TestId } from "./contracts.ts";

export const EVENT_KINDS = [
  "crash",
  "freeze",
  "lost_session",
  "system_dialog",
  "gate_failure",
  "gate_values",
  "plan_limit_pause",
  "harness_error",
  "contamination_drift",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const FAMILIES = new Set(["control", "EL-SDK", "EL-PTY", "NATIVE", "OWN", "FIRST"]);
const TEST_IDS = new Set<string>([
  "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4", "C5", "C6",
  "F",
]);
const SERVERS = new Set(["replay", "live", "none"]);
const DRIVES = new Set(["cli", "api", "cdp", "ax", "keys", "manual"]);
const RECEIPT_KEYS = ["samples", "video", "frames", "capture", "log"] as const;
const ROW_KEYS = new Set([
  "run_id", "machine_id", "ade", "ade_version", "ade_build_sha256", "family", "test_id", "variant", "rep",
  "model", "effort", "server", "value", "unit", "started_at", "duration_ms", "valid", "invalid_reason",
  "drive", "receipts", "notes",
]);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message: string): never {
  throw new Error(`ResultRow: ${message}`);
}

function checkString(value: unknown, field: string, { allowEmpty = false } = {}): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (!allowEmpty && value.length === 0) fail(`${field} must not be empty`);
  return value;
}

function checkNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return checkString(value, field);
}

function checkEnum(value: unknown, field: string, allowed: Set<string>): string {
  checkString(value, field);
  if (!allowed.has(value as string)) fail(`${field} must be one of ${[...allowed].join(", ")} (got ${String(value)})`);
  return value as string;
}

function checkFinite(value: unknown, field: string, min?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a finite number`);
  if (min !== undefined && value < min) fail(`${field} must be >= ${min}`);
  return value;
}

export function validateRow(row: unknown): ResultRow {
  if (typeof row !== "object" || row === null || Array.isArray(row)) fail("row must be an object");
  const value = row as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!ROW_KEYS.has(key)) fail(`unknown field ${key}`);
  }

  checkString(value.run_id, "run_id");
  if (!SAFE_SEGMENT.test(value.run_id as string)) fail("run_id must be a safe path segment");
  checkString(value.machine_id, "machine_id");
  checkString(value.ade, "ade");
  checkString(value.ade_version, "ade_version");
  checkNullableString(value.ade_build_sha256, "ade_build_sha256");
  checkEnum(value.family, "family", FAMILIES);
  checkEnum(value.test_id, "test_id", TEST_IDS);
  checkString(value.variant, "variant", { allowEmpty: true });
  if (typeof value.rep !== "number" || !Number.isInteger(value.rep) || value.rep < 1) {
    fail("rep must be an integer >= 1");
  }
  checkNullableString(value.model, "model");
  checkNullableString(value.effort, "effort");
  checkEnum(value.server, "server", SERVERS);
  if (value.value !== null) checkFinite(value.value, "value");
  checkString(value.unit, "unit");
  const started = checkString(value.started_at, "started_at");
  if (Number.isNaN(Date.parse(started))) fail("started_at must be an ISO-8601 timestamp");
  checkFinite(value.duration_ms, "duration_ms", 0);
  if (typeof value.valid !== "boolean") fail("valid must be a boolean");
  if (!value.valid) {
    if (typeof value.invalid_reason !== "string" || value.invalid_reason.length === 0) {
      fail("invalid_reason is required when valid is false");
    }
  } else {
    checkNullableString(value.invalid_reason, "invalid_reason");
  }
  checkEnum(value.drive, "drive", DRIVES);

  const receipts = value.receipts;
  if (typeof receipts !== "object" || receipts === null || Array.isArray(receipts)) {
    fail("receipts must be an object");
  }
  const receiptValue = receipts as Record<string, unknown>;
  for (const key of Object.keys(receiptValue)) {
    if (!(RECEIPT_KEYS as readonly string[]).includes(key)) fail(`unknown receipts field ${key}`);
  }
  for (const key of RECEIPT_KEYS) {
    if (!(key in receiptValue)) fail(`receipts.${key} is missing`);
    checkNullableString(receiptValue[key], `receipts.${key}`);
  }

  checkString(value.notes, "notes", { allowEmpty: true });
  return row as ResultRow;
}

export class RunWriter {
  private currentRunId: string | null = null;
  private readonly root: string;

  constructor(root: string = resultsRoot()) {
    this.root = resolve(root);
  }

  open(runId: string): this {
    if (!SAFE_SEGMENT.test(runId)) throw new Error(`RunWriter: run_id must be a safe path segment, got ${runId}`);
    this.currentRunId = runId;
    mkdirSync(this.runDir, { recursive: true });
    // Create the files without truncating: a resumed run keeps its earlier rows.
    writeFileSync(this.rowsPath, "", { flag: "a" });
    writeFileSync(this.eventsPath, "", { flag: "a" });
    return this;
  }

  get runId(): string {
    if (this.currentRunId === null) throw new Error("RunWriter: call open(runId) first");
    return this.currentRunId;
  }

  get runDir(): string {
    return join(this.root, this.runId);
  }

  get rowsPath(): string {
    return join(this.runDir, "rows.jsonl");
  }

  get eventsPath(): string {
    return join(this.runDir, "events.log");
  }

  appendRow(row: ResultRow): void {
    const valid = validateRow(row);
    if (valid.run_id !== this.runId) throw new Error(`RunWriter: row run_id ${valid.run_id} != ${this.runId}`);
    appendFileSync(this.rowsPath, `${JSON.stringify(valid)}\n`);
  }

  receiptDir(ade: string, testId: TestId, rep: number): string {
    if (!SAFE_SEGMENT.test(ade)) throw new Error(`RunWriter: unsafe ade ${ade}`);
    if (!TEST_IDS.has(testId)) throw new Error(`RunWriter: unknown test id ${testId}`);
    if (!Number.isInteger(rep) || rep < 1) throw new Error(`RunWriter: rep must be an integer >= 1, got ${rep}`);
    const dir = join(this.runDir, ade, testId, `rep-${String(rep).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  event(kind: EventKind, message: string): void {
    if (!(EVENT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`RunWriter: unknown event kind ${kind}; allowed: ${EVENT_KINDS.join(", ")}`);
    }
    appendFileSync(this.eventsPath, `${new Date().toISOString()} ${kind} ${message}\n`);
  }
}
