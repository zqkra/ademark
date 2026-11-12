// `ademark adapter check`: conformance only, nothing is launched (TESTS.md 1.7).
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Adapter, AdeProfile, Calibration, InstallInfo } from "../core/contracts.ts";
import { benchRoot } from "../core/paths.ts";
import { checkProfile, loadProfile, ProfileError, profileAgents } from "./profile.ts";

export const CALIBRATION_KEYS = [
  "appName", "bundleId", "composerRect", "threadRect", "focusClick", "masks", "drive", "dataDirs", "launchAgents",
] as const;

export const ADAPTER_MEMBERS = [
  "id", "name", "family", "agents", "calibration", "timed", "installCheck", "reset", "configure", "launch",
  "newThread", "send", "waitDone", "quit", "processes",
] as const;

const CALIBRATION_METHODS = ["reset", "configure", "launch", "newThread", "send", "waitDone", "quit"] as const;

const FAMILIES = new Set(["control", "EL-SDK", "EL-PTY", "NATIVE", "OWN", "FIRST"]);
const DRIVES = new Set(["cli", "api", "cdp", "ax", "keys", "manual"]);
const AGENTS = new Set(["claude", "codex", "own"]);

export interface FieldStatus {
  key: string;
  filled: boolean;
  value: string;
}

export interface AdapterCheck {
  id: string;
  ok: boolean;
  errors: string[];
  fields: FieldStatus[];
  filled: number;
  missing: number;
  install: InstallInfo | null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

function checkRect(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((key) => typeof rect[key] === "number");
}

export async function checkAdapter(id: string, adapter: unknown): Promise<AdapterCheck> {
  const errors: string[] = [];
  const fields: FieldStatus[] = [];

  if (typeof adapter !== "object" || adapter === null) {
    return { id, ok: false, errors: ["module does not export an adapter object"], fields, filled: 0, missing: 0, install: null };
  }
  const candidate = adapter as Partial<Adapter> & Record<string, unknown>;

  // A profile that exists must validate; a missing one is a stub adapter, not a conformance error.
  let profile: AdeProfile | null = null;
  const profileCheck = checkProfile(id, profileAgents(adapter as Adapter));
  if (profileCheck.status === "invalid") errors.push(...profileCheck.errors);
  if (profileCheck.status === "ok") {
    try {
      profile = loadProfile(id);
    } catch (error) {
      errors.push(...(error instanceof ProfileError ? error.errors : [String(error)]));
    }
  }

  for (const member of ADAPTER_MEMBERS) {
    const value = candidate[member];
    if (value === undefined) {
      errors.push(`missing member: ${member}`);
      continue;
    }
    const wantsFunction = member === "installCheck" || member === "processes" || (CALIBRATION_METHODS as readonly string[]).includes(member);
    if (wantsFunction && typeof value !== "function") errors.push(`${member} must be a function`);
  }

  if (typeof candidate.id !== "string" || candidate.id.length === 0) errors.push("id must be a non-empty string");
  else if (candidate.id !== id) errors.push(`id "${candidate.id}" does not match file name "${id}"`);
  if (typeof candidate.name !== "string" || candidate.name.length === 0) errors.push("name must be a non-empty string");
  if (typeof candidate.family !== "string" || !FAMILIES.has(candidate.family)) {
    errors.push(`family must be one of ${[...FAMILIES].join(", ")}`);
  }
  if (!Array.isArray(candidate.agents) || candidate.agents.length === 0) errors.push("agents must be a non-empty array");
  else if (!candidate.agents.every((agent) => AGENTS.has(agent))) errors.push("agents must only contain claude, codex or own");

  const calibration = (profile?.calibration ?? candidate.calibration) as Partial<Calibration> | undefined;
  if (typeof calibration !== "object" || calibration === null) {
    errors.push("missing member: calibration");
  } else {
    for (const key of CALIBRATION_KEYS) {
      const value = (calibration as Record<string, unknown>)[key];
      if (!(key in calibration)) {
        errors.push(`calibration is missing the key ${key}`);
        continue;
      }
      if ((key === "composerRect" || key === "threadRect") && !checkRect(value)) {
        errors.push(`calibration.${key} must be null or {x,y,w,h}`);
      }
      if (key === "drive" && (typeof value !== "string" || !DRIVES.has(value))) {
        errors.push(`calibration.drive must be one of ${[...DRIVES].join(", ")}`);
      }
      if ((key === "masks" || key === "dataDirs" || key === "launchAgents") && !Array.isArray(value)) {
        errors.push(`calibration.${key} must be an array`);
      }
      fields.push({ key, filled: isFilled(value), value: describe(value) });
    }
  }

  const timed = candidate.timed as Record<string, unknown> | undefined;
  if (typeof timed !== "object" || timed === null) {
    errors.push("missing member: timed");
  } else {
    for (const key of ["launch", "newThread", "send"]) {
      if (!Array.isArray(timed[key])) errors.push(`timed.${key} must be an array`);
      else fields.push({ key: `timed.${key}`, filled: (timed[key] as unknown[]).length > 0, value: describe(timed[key]) });
    }
  }

  let install: InstallInfo | null = null;
  if (typeof candidate.installCheck === "function") {
    try {
      install = await candidate.installCheck.call(adapter);
      if (typeof install !== "object" || install === null) errors.push("installCheck() must return an InstallInfo");
      else {
        if (typeof install.installed !== "boolean") errors.push("installCheck().installed must be a boolean");
        for (const key of ["version", "path", "binarySha256"] as const) {
          if (install[key] !== null && typeof install[key] !== "string") {
            errors.push(`installCheck().${key} must be a string or null`);
          }
        }
      }
    } catch (error) {
      errors.push(`installCheck() threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const filled = fields.filter((field) => field.filled).length;
  return { id, ok: errors.length === 0, errors, fields, filled, missing: fields.length - filled, install };
}

export function formatCheck(check: AdapterCheck): string {
  const lines: string[] = [];
  lines.push(`${check.id}: ${check.ok ? "conforms" : "does NOT conform"}`);
  lines.push(`  install: ${check.install ? `${check.install.installed ? "installed" : "not installed"}${check.install.version ? ` ${check.install.version}` : ""}` : "not checked"}`);
  lines.push(`  calibration: ${check.filled} filled, ${check.missing} missing`);
  for (const field of check.fields) {
    lines.push(`  ${field.filled ? "ok     " : "missing"} ${field.key} = ${field.value}`);
  }
  for (const error of check.errors) lines.push(`  error: ${error}`);
  return lines.join("\n");
}

export function adapterFile(id: string): string {
  return resolve(benchRoot, "adapters", `${id}.ts`);
}

// A freshly scaffolded adapter is not in the registry yet, so load it straight from its file.
export async function loadAdapterModule(id: string): Promise<unknown> {
  const file = adapterFile(id);
  if (!existsSync(file)) throw new Error(`adapter file not found: ${file}`);
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const candidates = [module.default, ...Object.values(module)];
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null && "calibration" in candidate && "installCheck" in candidate) {
      return candidate;
    }
  }
  return module.default ?? candidates.find((candidate) => typeof candidate === "object" && candidate !== null);
}
