// Token capture from Claude Code's own telemetry: a small OTLP receiver turns its `api_request` events into CaptureRows.
// It sees every call the CLI makes, side calls included, but not a call that skips the CLI, so it runs beside mitmproxy
// as the safety net of a block (run/real.ts).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CaptureRow } from "../core/contracts.ts";
import { userTextCandidates } from "../replay/session.ts";

const API_HOST = "api.anthropic.com";
const API_PATH = "/v1/messages";

interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpRecord {
  attributes?: { key: string; value: OtlpValue }[];
}

interface OtlpBody {
  resourceLogs?: { scopeLogs?: { logRecords?: OtlpRecord[] }[] }[];
}

type Attributes = Record<string, string>;

function attributesOf(record: OtlpRecord): Attributes {
  const out: Attributes = {};
  for (const { key, value } of record.attributes ?? []) {
    const raw = value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue;
    if (raw !== undefined) out[key] = String(raw);
  }
  return out;
}

export function eventsOf(body: OtlpBody): Attributes[] {
  const events: Attributes[] = [];
  for (const resource of body.resourceLogs ?? []) {
    for (const scope of resource.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) events.push(attributesOf(record));
    }
  }
  return events;
}

const count = (value: string | undefined): number => Number(value ?? 0) || 0;

// The same hashes the proxy writes, so classifyMainThread decides main and side calls by the prompt. `query_source` names
// the subsystem, not the thread: a compact call belongs to the test thread.
export function bodyHashes(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return userTextCandidates(JSON.parse(readFileSync(path, "utf8"))).map((text) => createHash("sha256").update(text).digest("hex"));
  } catch {
    return [];
  }
}

/** `nowNs` and `nowMs` pair the host clock of the rows with the wall clock of the events. */
export function rowsFromEvents(events: readonly Attributes[], nowNs: number, nowMs: number, bodiesDir = ""): CaptureRow[] {
  const requestFile = new Map<string, string>();
  const bodyLength = new Map<string, number>();
  for (const event of events) {
    if (event["event.name"] === "api_request_body" && event.request_body_id !== undefined) {
      bodyLength.set(event.request_body_id, count(event.body_length));
    }
    if (event["event.name"] === "api_response_body" && event.request_id !== undefined && event.request_body_id !== undefined) {
      requestFile.set(event.request_id, event.request_body_id);
    }
  }
  const rows: CaptureRow[] = [];
  for (const event of events) {
    if (event["event.name"] !== "api_request") continue;
    const bodyId = event.request_id === undefined ? undefined : requestFile.get(event.request_id);
    const eventMs = Date.parse(event["event.timestamp"] ?? "");
    rows.push({
      t_ns: Number.isFinite(eventMs) ? nowNs - (nowMs - eventMs) * 1_000_000 : nowNs,
      request_id: event.request_id ?? null,
      host: API_HOST,
      path: API_PATH,
      pid: null,
      process: "claude",
      model: event.model ?? null,
      user_agent: null,
      req_bytes: bodyId === undefined ? 0 : (bodyLength.get(bodyId) ?? 0),
      status: 200,
      usage: {
        input: count(event.input_tokens),
        cache_write: count(event.cache_creation_tokens),
        cache_read: count(event.cache_read_tokens),
        output: count(event.output_tokens),
      },
      main_thread: null,
      user_text_sha256: bodyId === undefined ? [] : bodyHashes(join(bodiesDir, `${basename(bodyId)}.request.json`)),
      chunk_t_ns: [],
      body_file: bodyId === undefined ? null : `bodies/${basename(bodyId)}.request.json`,
    });
  }
  return rows.sort((a, b) => a.t_ns - b.t_ns);
}

/**
 * The proxy rows plus every telemetry row the proxy did not see, so a partial proxy capture loses nothing and no call
 * counts twice. The provider's request id says what is one call: equal token counts can be two calls.
 */
export function reconcile(proxy: readonly CaptureRow[], telemetry: readonly CaptureRow[]): CaptureRow[] {
  const byId = new Map(telemetry.filter((row) => row.request_id != null).map((row) => [row.request_id, row]));
  const seen = new Set(proxy.map((row) => row.request_id).filter((id) => id != null));
  // The proxy cannot read usage in a compressed stream, so a matching row keeps its metadata and takes telemetry's usage.
  const merged = proxy.map((row) => (row.usage === null ? { ...row, usage: byId.get(row.request_id)?.usage ?? null } : row));
  const missing = telemetry.filter((row) => row.request_id == null || !seen.has(row.request_id));
  return [...merged, ...missing].sort((a, b) => a.t_ns - b.t_ns);
}

export interface TelemetryCapture {
  outPath: string;
  env: Record<string, string>;
  rows(): CaptureRow[];
  stop(): Promise<void>;
}

export const TELEMETRY_ENV_NAMES = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_RAW_API_BODIES",
] as const;

export function startTelemetryCapture(out: string, nowNs: () => number): TelemetryCapture {
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  const events: Attributes[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/logs")) {
        const body = (await request.json().catch(() => ({}))) as OtlpBody;
        const received = eventsOf(body);
        events.push(...received);
        if (received.length > 0) appendFileSync(`${outPath}.events.jsonl`, `${received.map((event) => JSON.stringify(event)).join("\n")}\n`);
      }
      return Response.json({});
    },
  });
  const rows = (): CaptureRow[] => rowsFromEvents(events, nowNs(), Date.now(), join(dirname(outPath), "bodies"));
  return {
    outPath,
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}`,
      OTEL_LOGS_EXPORT_INTERVAL: "1000",
      OTEL_LOG_RAW_API_BODIES: `file:${join(dirname(outPath), "bodies")}`,
    },
    rows,
    stop: async () => {
      // The CLI flushes on an interval, so the last calls can land just after the block ends.
      await Bun.sleep(1_500);
      try {
        appendFileSync(outPath, rows().map((row) => `${JSON.stringify(row)}\n`).join(""));
      } finally {
        await server.stop(true);
      }
    },
  };
}
