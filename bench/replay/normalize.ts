// Request-body normalization for ReplayRequestLog.body_sha256.
// Two requests that differ only in ids, timestamps or paths must hash equal.

import { createHash } from "node:crypto";

const DROP_KEYS = new Set(["metadata", "request_id", "user_id", "session_id"]);

const PATH_RE = /\/(?:Users|private\/var|tmp)\/[^"\s]*/g;
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

export function sanitizeString(value: string): string {
  return value.replace(PATH_RE, "<PATH>").replace(UUID_RE, "<UUID>").replace(TIME_RE, "<TIME>");
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(key)) continue;
      out[key] = scrub(entry);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  return "null";
}

export function normalizeBody(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return sanitizeString(rawBody);
  }
  return stableStringify(scrub(parsed));
}

export function bodySha256(rawBody: string): string {
  return createHash("sha256").update(normalizeBody(rawBody)).digest("hex");
}
