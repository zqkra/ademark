// Task folders in the open-harness format (TASKS.md 1.1): task.toml plus prompt.md.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Fault,
  FaultKind,
  FollowUp,
  FollowUpPolicy,
  Recovery,
  TaskSpec,
  TestId,
} from "./contracts.ts";
import { tasksRoot } from "./paths.ts";

const TEST_IDS: readonly TestId[] = [
  "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4", "C5", "C6",
  "F",
];

// task.toml spells the kinds agent_kill | network_cut | app_restart (TASKS.md 1.1); only these are accepted.
const FAULT_KINDS: Record<string, FaultKind> = {
  agent_kill: "kill-agent",
  network_cut: "cut-network",
  app_restart: "restart-app",
};

const MODELS = ["claude", "codex", "both"] as const;

interface TaskToml {
  id?: unknown;
  test_id?: unknown;
  version?: unknown;
  track?: unknown;
  model?: unknown;
  mode?: unknown;
  thread?: unknown;
  prompt?: unknown;
  time_cap_s?: unknown;
  repeats?: unknown;
  grade_groups?: unknown;
  chat_lock_probe?: unknown;
  followup?: unknown;
  followup_policy?: unknown;
  fault?: unknown;
  recovery?: unknown;
}

function asNumber(value: unknown, field: string, { integer = false, min = 0 } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`task.toml: ${field} must be a ${integer ? "whole " : ""}number >= ${min}`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`task.toml: ${field} must be a non-empty string`);
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`task.toml: ${field} must be a boolean`);
  return value;
}

function asStringArray(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`task.toml: ${field} must be an array of strings`);
  }
  return value as string[];
}

function asTable(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`task.toml: ${field} must be a table`);
  }
  return value as Record<string, unknown>;
}

export function taskTestId(id: string, explicit?: unknown): TestId {
  const candidate = typeof explicit === "string" ? explicit : (id.match(/^([ABCF]\d{1,2})/) ?? [])[1];
  if (!candidate) throw new Error(`task ${id}: cannot derive a test id; set test_id in task.toml`);
  const normalized = candidate.toUpperCase() as TestId;
  if (!TEST_IDS.includes(normalized)) throw new Error(`task ${id}: unknown test id ${candidate}`);
  return normalized;
}

export function parseModel(value: unknown): TaskSpec["model"] {
  if (typeof value !== "string" || !(MODELS as readonly string[]).includes(value)) {
    throw new Error(`task.toml: model must be one of ${MODELS.join(", ")}`);
  }
  return value as TaskSpec["model"];
}

// `text` is the follow-up file's content, read byte for byte from the task folder.
export function parseFollowups(raw: unknown, taskDir: string): FollowUp[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("task.toml: [[followup]] must be an array of tables");
  return raw.map((entry, index) => {
    const table = asTable(entry, `followup[${index}]`);
    const id = asString(table.id, `followup[${index}].id`);
    const file = asString(table.file, `followup[${index}].file`);
    const path = join(taskDir, file);
    if (!existsSync(path)) throw new Error(`task ${taskDir}: follow-up ${id} is missing ${path}`);
    return { id, at_s: asNumber(table.at_s, `followup[${index}].at_s`), file, text: readFileSync(path, "utf8") };
  });
}

// duration_s is how long a network cut stays up; it never comes from [recovery].wait_s.
export function parseFaults(rawFault: unknown): Fault[] {
  if (rawFault === undefined) return [];
  const table = asTable(rawFault, "fault");
  const kindRaw = asString(table.kind, "fault.kind");
  const kind = FAULT_KINDS[kindRaw];
  if (!kind) throw new Error(`task.toml: unknown fault kind ${kindRaw}; use agent_kill, network_cut or app_restart`);
  return [
    {
      kind,
      at_s: asNumber(table.at_s, "fault.at_s"),
      duration_s: table.duration_s === undefined ? null : asNumber(table.duration_s, "fault.duration_s"),
    },
  ];
}

export function parseFollowupPolicy(raw: unknown): FollowUpPolicy | null {
  if (raw === undefined) return null;
  const table = asTable(raw, "followup_policy");
  return {
    refused_retry_every_s: asNumber(table.refused_retry_every_s, "followup_policy.refused_retry_every_s"),
    refused_give_up_s: asNumber(table.refused_give_up_s, "followup_policy.refused_give_up_s"),
  };
}

export function parseRecovery(raw: unknown): Recovery | null {
  if (raw === undefined) return null;
  const table = asTable(raw, "recovery");
  return {
    wait_s: asNumber(table.wait_s, "recovery.wait_s"),
    message: asString(table.message, "recovery.message"),
  };
}

export function loadTask(taskId: string, root: string = tasksRoot()): TaskSpec {
  return loadTaskDir(join(root, taskId), taskId);
}

// The grader can point at a task folder directly; `fallbackId` names it in errors when task.toml has no id.
export function loadTaskDir(dir: string, fallbackId: string): TaskSpec {
  const tomlPath = join(dir, "task.toml");
  if (!existsSync(tomlPath)) throw new Error(`task ${fallbackId}: missing ${tomlPath}`);
  const toml = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as TaskToml;

  const id = typeof toml.id === "string" && toml.id.length > 0 ? toml.id : fallbackId;
  const promptFile = typeof toml.prompt === "string" && toml.prompt.length > 0 ? toml.prompt : "prompt.md";
  const promptPath = join(dir, promptFile);
  if (!existsSync(promptPath)) throw new Error(`task ${fallbackId}: missing ${promptPath}`);

  return {
    id,
    version: asString(toml.version, "version"),
    test_id: taskTestId(id, toml.test_id),
    model: parseModel(toml.model),
    time_cap_s: asNumber(toml.time_cap_s, "time_cap_s"),
    repeats: toml.repeats === undefined ? 1 : asNumber(toml.repeats, "repeats", { integer: true, min: 1 }),
    prompt: readFileSync(promptPath, "utf8"),
    grade_groups: asStringArray(toml.grade_groups, "grade_groups", []),
    chat_lock_probe: toml.chat_lock_probe === undefined ? false : asBoolean(toml.chat_lock_probe, "chat_lock_probe"),
    followups: parseFollowups(toml.followup, dir),
    followup_policy: parseFollowupPolicy(toml.followup_policy),
    faults: parseFaults(toml.fault),
    recovery: parseRecovery(toml.recovery),
  };
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length === length) return out;
    }
  }
  if (bits > 0 && out.length < length) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, length);
}

export type HandoffCodes = Record<"W1" | "W2" | "W3" | "W4", string>;

export function generateHandoffCodes(seed: string): HandoffCodes {
  if (seed.length === 0) throw new Error("generateHandoffCodes: seed must not be empty");
  const code = (worker: "W1" | "W2" | "W3" | "W4"): string => {
    const digest = createHmac("sha256", seed).update(worker).digest();
    return `ADM-${worker}-${base32(new Uint8Array(digest), 6)}`;
  };
  return { W1: code("W1"), W2: code("W2"), W3: code("W3"), W4: code("W4") };
}

export function renderHandoffCodes(prompt: string, seed: string): string {
  const codes = generateHandoffCodes(seed);
  let out = prompt;
  for (const [worker, code] of Object.entries(codes)) {
    out = out.split(`{{${worker}_CODE}}`).join(code);
  }
  return out;
}
