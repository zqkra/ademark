// Calibration gate records (bench/adapters/gates/<ade>.json): `runs` smoke runs in a row from a clean reset.
// The night measures an ADE only when passed == runs and the bundle SHA-256 matches the installed app.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CalibrationGate, InstallInfo } from "../core/contracts.ts";
import { benchRoot } from "../core/paths.ts";

export type GateStatus = "ok" | "missing" | "failed" | "stale";

export function gatesDir(): string {
  return process.env.ADEMARK_GATES ?? resolve(benchRoot, "adapters", "gates");
}

export function gateFile(id: string, dir: string = gatesDir()): string {
  return join(dir, `${id}.json`);
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function validateGate(raw: unknown, path: string, id: string): string[] {
  const errors: string[] = [];
  const gate = asObject(raw);
  if (gate === null) return [`${path}: must be a JSON object`];

  if (typeof gate.ade !== "string" || gate.ade.length === 0) errors.push("ade: must be a non-empty string");
  else if (gate.ade !== id) errors.push(`ade: "${gate.ade}" does not match the gate file "${id}.json"`);
  for (const key of ["runs", "passed"] as const) {
    if (typeof gate[key] !== "number" || !Number.isInteger(gate[key]) || (gate[key] as number) < 0) {
      errors.push(`${key}: must be a non-negative integer`);
    }
  }
  if (
    typeof gate.runs === "number" &&
    typeof gate.passed === "number" &&
    Number.isInteger(gate.runs) &&
    Number.isInteger(gate.passed) &&
    gate.passed > gate.runs
  ) {
    errors.push("passed: must not be greater than runs");
  }
  for (const key of ["at", "harnessCommit", "version"] as const) {
    if (typeof gate[key] !== "string" || gate[key].length === 0) errors.push(`${key}: must be a non-empty string`);
  }
  if (gate.bundleSha256 !== null && (typeof gate.bundleSha256 !== "string" || gate.bundleSha256.length === 0)) {
    errors.push("bundleSha256: must be a non-empty string or null");
  }
  if (!Array.isArray(gate.failures) || !gate.failures.every((failure) => typeof failure === "string")) {
    errors.push("failures: must be an array of strings");
  }
  return errors;
}

export function readGate(id: string, dir?: string): CalibrationGate | null {
  const file = gateFile(id, dir);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const errors = validateGate(raw, file, id);
  if (errors.length > 0) throw new Error(`invalid gate record ${file}:\n${errors.join("\n")}`);
  return raw as unknown as CalibrationGate;
}

export function writeGate(gate: CalibrationGate, dir: string = gatesDir()): string {
  const file = gateFile(gate.ade, dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(gate, null, 2)}\n`);
  return file;
}

export function gateStatus(gate: CalibrationGate, installed: InstallInfo): GateStatus {
  if (!installed.installed) return "missing";
  if (gate.runs < 1 || gate.passed < gate.runs) return "failed";
  if (gate.version !== installed.version) return "stale";
  if (gate.bundleSha256 !== installed.binarySha256) return "stale";
  return "ok";
}
