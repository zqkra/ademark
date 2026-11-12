import { describe, expect, test } from "bun:test";
import type { CaptureRow } from "../core/contracts.ts";
import { eventsOf, reconcile, rowsFromEvents, startTelemetryCapture } from "./telemetry.ts";

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const otlp = (...records: Record<string, string>[]) => ({
  resourceLogs: [{ scopeLogs: [{ logRecords: records.map((record) => ({ attributes: Object.entries(record).map(([k, v]) => attr(k, v)) })) }] }],
});
const main = {
  "event.name": "api_request",
  "event.timestamp": "2026-11-06T07:08:02.000Z",
  model: "claude-opus-5-5",
  input_tokens: "2",
  output_tokens: "4",
  cache_read_tokens: "11391",
  cache_creation_tokens: "24878",
  query_source: "sdk",
  request_id: "req_1",
};
const side = { ...main, model: "claude-haiku-5-5", query_source: "generate_session_title", request_id: "req_2" };
const body = { "event.name": "api_request_body", request_body_id: "abc", body_length: "4556" };
const response = { "event.name": "api_response_body", request_id: "req_1", request_body_id: "abc" };

describe("telemetry capture", () => {
  test("turns api_request events into rows, and leaves main or side to the prompt", () => {
    const events = eventsOf(otlp(main, side, body, response));
    const rows = rowsFromEvents(events, 5_000_000_000, Date.parse("2026-11-06T07:08:03.000Z"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      model: "claude-opus-5-5",
      main_thread: null,
      usage: { input: 2, output: 4, cache_read: 11391, cache_write: 24878 },
      body_file: "bodies/abc.request.json",
      req_bytes: 4556,
    });
    expect(rows[1]).toMatchObject({ main_thread: null, body_file: null });
  });

  test("the event time lands on the host clock", () => {
    const rows = rowsFromEvents(eventsOf(otlp(main)), 5_000_000_000, Date.parse("2026-11-06T07:08:03.000Z"));
    expect(rows[0]?.t_ns).toBe(4_000_000_000);
  });

  test("reconcile keeps proxy rows and adds only what the proxy missed", () => {
    const row = (request_id: string, t_ns: number) => ({ t_ns, request_id, model: "m", usage: { input: 100, cache_write: 0, cache_read: 0, output: 1 } }) as CaptureRow;
    // Same model and tokens, two different calls: the proxy saw only the second.
    const merged = reconcile([row("b", 2)], [row("a", 1), row("b", 2)]);
    expect(merged.map((entry) => entry.request_id)).toEqual(["a", "b"]);
    expect(reconcile([], [row("a", 1)])).toHaveLength(1);
  });

  test("a proxy row with no usage takes it from telemetry and keeps its metadata", () => {
    const usage = { input: 600, cache_write: 0, cache_read: 0, output: 5 };
    const proxy = { t_ns: 1, request_id: "a", model: "m", usage: null, process: "Electron" } as CaptureRow;
    const telemetry = { t_ns: 1, request_id: "a", model: "m", usage, process: "claude" } as CaptureRow;
    expect(reconcile([proxy], [telemetry])).toEqual([{ ...proxy, usage }]);
  });

  test("a real receiver takes OTLP over HTTP", async () => {
    const capture = startTelemetryCapture(`/tmp/ademark-telemetry-${process.pid}/capture.jsonl`, () => 0);
    const reply = await fetch(`${capture.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`, { method: "POST", body: JSON.stringify(otlp(main)) });
    expect(reply.status).toBe(200);
    expect(capture.rows()).toHaveLength(1);
    await capture.stop();
  });
});
