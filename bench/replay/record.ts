// ademark-record: a forwarding proxy that turns a real Claude or Codex conversation into a
// replay session file. Tests use a fake upstream; never point it at a real API in checks.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  assistantCount,
  userTextCandidates,
  type ReplayApi,
  type SessionBlock,
  type SessionUsage,
  type ToolUseBlock,
} from "./session";

export interface RecorderOptions {
  upstream: string;
  port: number;
  name: string;
  match: string;
  root: string;
  out: string;
}

export interface RecorderHandle {
  server: import("bun").Server;
  port: number;
  stop(): void;
}

interface AssembledTurn {
  blocks: SessionBlock[];
  stop_reason: string;
  usage: SessionUsage;
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function apiFor(path: string): ReplayApi | null {
  if (path.endsWith("/v1/messages")) return "anthropic";
  if (path.endsWith("/v1/responses") || path === "/responses") return "openai";
  return null;
}

function* sseData(text: string): Generator<string> {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (line.startsWith("data:")) yield line.slice(5).trimStart();
  }
}

function isToolUse(block: SessionBlock | undefined): block is ToolUseBlock {
  return block?.type === "tool_use";
}

export function parseAnthropicResponse(text: string, sse: boolean): AssembledTurn | null {
  const blocks: SessionBlock[] = [];
  const toolJson = new Map<number, string>();
  const usage: SessionUsage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "end_turn";

  const applyUsage = (value: Record<string, unknown> | undefined): void => {
    if (!value) return;
    if (typeof value.input_tokens === "number") usage.input_tokens = value.input_tokens;
    if (typeof value.output_tokens === "number") usage.output_tokens = value.output_tokens;
    if (typeof value.cache_creation_input_tokens === "number") {
      usage.cache_creation_input_tokens = value.cache_creation_input_tokens;
    }
    if (typeof value.cache_read_input_tokens === "number") {
      usage.cache_read_input_tokens = value.cache_read_input_tokens;
    }
  };

  if (!sse) {
    const body = parseJson(text);
    if (!body) return null;
    const content = Array.isArray(body.content) ? body.content : [];
    for (const entry of content) {
      if (entry === null || typeof entry !== "object") continue;
      const block = entry as Record<string, unknown>;
      if (block.type === "text") blocks.push({ type: "text", text: String(block.text ?? "") });
      else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: (block.input as Record<string, unknown>) ?? {},
        });
      } else if (block.type === "thinking") {
        blocks.push({ type: "thinking", thinking: String(block.thinking ?? "") });
      }
    }
    if (typeof body.stop_reason === "string") stopReason = body.stop_reason;
    applyUsage(body.usage as Record<string, unknown> | undefined);
    return blocks.length > 0 ? { blocks, stop_reason: stopReason, usage } : null;
  }

  for (const data of sseData(text)) {
    const event = parseJson(data) as Record<string, unknown> | null;
    if (!event) continue;
    const type = event.type;
    if (type === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      applyUsage(message?.usage as Record<string, unknown> | undefined);
    } else if (type === "content_block_start") {
      const index = Number(event.index ?? blocks.length);
      const block = event.content_block as Record<string, unknown> | undefined;
      if (!block) continue;
      if (block.type === "text") blocks[index] = { type: "text", text: String(block.text ?? "") };
      else if (block.type === "tool_use") {
        blocks[index] = {
          type: "tool_use",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: (block.input as Record<string, unknown>) ?? {},
        };
        toolJson.set(index, "");
      } else if (block.type === "thinking") {
        blocks[index] = { type: "thinking", thinking: String(block.thinking ?? "") };
      }
    } else if (type === "content_block_delta") {
      const index = Number(event.index ?? -1);
      const current = blocks[index];
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!current || !delta) continue;
      const deltaType = delta.type;
      if (deltaType === "text_delta" && current.type === "text") {
        current.text += String(delta.text ?? "");
      } else if (deltaType === "input_json_delta" && current.type === "tool_use") {
        toolJson.set(index, (toolJson.get(index) ?? "") + String(delta.partial_json ?? ""));
      } else if (deltaType === "thinking_delta" && current.type === "thinking") {
        current.thinking += String(delta.thinking ?? "");
      }
    } else if (type === "content_block_stop") {
      const index = Number(event.index ?? -1);
      const current = blocks[index];
      if (isToolUse(current)) {
        const json = toolJson.get(index) ?? "";
        if (json.length > 0) {
          const parsed = parseJson(json);
          if (parsed) current.input = parsed;
        }
      }
    } else if (type === "message_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
      const deltaUsage = event.usage as Record<string, unknown> | undefined;
      if (typeof deltaUsage?.output_tokens === "number") {
        usage.output_tokens = deltaUsage.output_tokens;
      }
    }
  }
  const ordered = blocks.filter((block): block is SessionBlock => block !== undefined);
  return ordered.length > 0 ? { blocks: ordered, stop_reason: stopReason, usage } : null;
}

export function parseOpenAiResponse(text: string, sse: boolean): AssembledTurn | null {
  const blocks: SessionBlock[] = [];
  const argumentsJson = new Map<number, string>();
  const usage: SessionUsage = { input_tokens: 0, output_tokens: 0 };

  const applyUsage = (value: Record<string, unknown> | undefined): void => {
    if (!value) return;
    if (typeof value.input_tokens === "number") usage.input_tokens = value.input_tokens;
    if (typeof value.output_tokens === "number") usage.output_tokens = value.output_tokens;
    const details = value.input_tokens_details as Record<string, unknown> | undefined;
    if (typeof details?.cached_tokens === "number") {
      usage.cache_read_input_tokens = details.cached_tokens;
    }
  };

  const applyItem = (index: number, item: Record<string, unknown>): void => {
    if (item.type === "message") {
      blocks[index] = { type: "text", text: "" };
    } else if (item.type === "function_call") {
      blocks[index] = {
        type: "tool_use",
        id: String(item.call_id ?? item.id ?? ""),
        name: String(item.name ?? ""),
        input: {},
      };
      argumentsJson.set(index, "");
    }
  };

  if (!sse) {
    const body = parseJson(text);
    if (!body) return null;
    const output = Array.isArray(body.output) ? body.output : [];
    output.forEach((entry, index) => {
      if (entry === null || typeof entry !== "object") return;
      const item = entry as Record<string, unknown>;
      applyItem(index, item);
      if (item.type === "message") {
        const content = Array.isArray(item.content) ? item.content : [];
        const textParts = content
          .map((part) => {
            const record = part as Record<string, unknown>;
            return record.type === "output_text" ? String(record.text ?? "") : "";
          })
          .join("");
        blocks[index] = { type: "text", text: textParts };
      } else if (item.type === "function_call") {
        const parsed = parseJson(String(item.arguments ?? "{}"));
        const block = blocks[index];
        if (isToolUse(block) && parsed) block.input = parsed;
      }
    });
    applyUsage(body.usage as Record<string, unknown> | undefined);
    return blocks.length > 0 ? { blocks: blocks.filter(Boolean), stop_reason: stopReasonOf(blocks), usage } : null;
  }

  for (const data of sseData(text)) {
    const event = parseJson(data) as Record<string, unknown> | null;
    if (!event) continue;
    const type = event.type;
    if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item) applyItem(Number(event.output_index ?? blocks.length), item);
    } else if (type === "response.output_text.delta") {
      const index = Number(event.output_index ?? -1);
      const current = blocks[index];
      if (current?.type === "text") current.text += String(event.delta ?? "");
    } else if (type === "response.output_text.done") {
      const index = Number(event.output_index ?? -1);
      const current = blocks[index];
      if (current?.type === "text") current.text = String(event.text ?? current.text);
    } else if (type === "response.function_call_arguments.delta") {
      const index = Number(event.output_index ?? -1);
      argumentsJson.set(index, (argumentsJson.get(index) ?? "") + String(event.delta ?? ""));
    } else if (type === "response.function_call_arguments.done") {
      const index = Number(event.output_index ?? -1);
      const current = blocks[index];
      const parsed = parseJson(String(event.arguments ?? ""));
      if (isToolUse(current) && parsed) current.input = parsed;
    } else if (type === "response.output_item.done") {
      const index = Number(event.output_index ?? -1);
      const current = blocks[index];
      if (isToolUse(current) && Object.keys(current.input).length === 0) {
        const parsed = parseJson(argumentsJson.get(index) ?? "");
        if (parsed) current.input = parsed;
      }
    } else if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      applyUsage(response?.usage as Record<string, unknown> | undefined);
    }
  }
  const ordered = blocks.filter((block): block is SessionBlock => block !== undefined);
  return ordered.length > 0 ? { blocks: ordered, stop_reason: stopReasonOf(ordered), usage } : null;
}

function stopReasonOf(blocks: SessionBlock[]): string {
  return blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
}

export function startRecorder(options: RecorderOptions): RecorderHandle {
  mkdirSync(dirname(options.out), { recursive: true });

  let headerWritten = false;
  const writeHeader = (api: ReplayApi): void => {
    if (headerWritten) return;
    headerWritten = true;
    if (existsSync(options.out)) {
      const first = readFileSync(options.out, "utf8").split(/\r?\n/)[0] ?? "";
      if (first.length > 0) return;
    }
    writeFileSync(
      options.out,
      `${JSON.stringify({
        type: "session",
        name: options.name,
        api,
        match: options.match,
        root: options.root,
      })}\n`,
    );
  };

  const assemble = async (
    stream: ReadableStream<Uint8Array>,
    api: ReplayApi,
    turnIndex: number,
    contentType: string,
  ): Promise<void> => {
    const text = await new Response(stream).text();
    const sse = contentType.includes("text/event-stream");
    const assembled =
      api === "anthropic" ? parseAnthropicResponse(text, sse) : parseOpenAiResponse(text, sse);
    if (!assembled) return;
    writeHeader(api);
    appendFileSync(
      options.out,
      `${JSON.stringify({
        type: "turn",
        index: turnIndex,
        blocks: assembled.blocks,
        stop_reason: assembled.stop_reason,
        usage: assembled.usage,
      })}\n`,
    );
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const api = apiFor(url.pathname);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await request.arrayBuffer() : undefined;
    const headers = new Headers(request.headers);
    for (const name of ["host", "content-length", "connection", "accept-encoding"]) {
      headers.delete(name);
    }

    let upstream: Response;
    try {
      upstream = await fetch(new URL(url.pathname + url.search, options.upstream), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "upstream_failed", message: String(error) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    const responseHeaders = new Headers(upstream.headers);
    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) {
      responseHeaders.delete(name);
    }

    const rawBody = body ? new TextDecoder().decode(body) : "";
    const parsedBody = parseJson(rawBody);
    const matched =
      api !== null &&
      parsedBody !== null &&
      userTextCandidates(parsedBody).includes(options.match.trim());

    if (!matched || !upstream.body) {
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    const [toClient, toParse] = upstream.body.tee();
    const turnIndex = assistantCount(parsedBody);
    const contentType = upstream.headers.get("content-type") ?? "";
    void assemble(toParse, api, turnIndex, contentType).catch((error) => {
      console.error(`ademark-record: ${String(error)}`);
    });
    return new Response(toClient, { status: upstream.status, headers: responseHeaders });
  };

  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  return {
    server,
    port: server.port,
    stop: () => server.stop(true),
  };
}

function parseArgs(argv: string[]): RecorderOptions {
  const options: Partial<RecorderOptions> = {};
  const known = new Set(["--upstream", "--port", "--name", "--match", "--root", "--out"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!known.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--upstream") options.upstream = value;
    else if (flag === "--port") options.port = Number(value);
    else if (flag === "--name") options.name = value;
    else if (flag === "--match") options.match = value;
    else if (flag === "--root") options.root = value;
    else if (flag === "--out") options.out = value;
  }
  for (const key of ["upstream", "port", "name", "match", "root", "out"] as const) {
    if (options[key] === undefined) throw new Error(`--${key} is required`);
  }
  return options as RecorderOptions;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const handle = startRecorder(options);
    console.log(`ademark-record listening on http://127.0.0.1:${handle.port}`);
  } catch (error) {
    console.error(String(error));
    process.exit(2);
  }
}
