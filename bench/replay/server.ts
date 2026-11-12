// ademark-replay: a local fake model API that answers every request from session files.
// Usage: bun bench/replay/server.ts --port <n> --sessions <dir> --log <requests.jsonl>

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReplayRequestLog } from "../core/contracts";
import { nowNs } from "../core/clock";
import { anthropicMessage, streamAnthropic } from "./anthropic";
import { bodySha256 } from "./normalize";
import { openAiResponse, streamOpenAi } from "./openai";
import {
  applyRootRewrite,
  assistantCount,
  loadSessions,
  matchSession,
  selectTurn,
  type ReplayApi,
  type ReplaySession,
  type SessionTurn,
} from "./session";

export interface ReplayStats {
  requests: number;
  by_session: Record<string, number>;
  unknown: number;
  rewrite_misses: number;
}

export interface ReplayServerOptions {
  port: number;
  sessionsDir: string;
  logPath?: string | null;
  envWorktree?: string;
}

export interface ReplayServerHandle {
  server: import("bun").Server;
  port: number;
  stats(): ReplayStats;
  resetStats(): void;
  stop(): void;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(run: (write: (payload: string) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await run((payload) => {
          controller.enqueue(encoder.encode(payload));
        });
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
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
  if (path === "/v1/messages") return "anthropic";
  if (path === "/v1/responses" || path === "/responses") return "openai";
  return null;
}

export function startReplayServer(options: ReplayServerOptions): ReplayServerHandle {
  const sessions = loadSessions(options.sessionsDir);
  const stats: ReplayStats = { requests: 0, by_session: {}, unknown: 0, rewrite_misses: 0 };
  const resetStats = (): void => {
    stats.requests = 0;
    stats.by_session = {};
    stats.unknown = 0;
    stats.rewrite_misses = 0;
  };
  if (options.logPath) mkdirSync(dirname(options.logPath), { recursive: true });

  const log = (entry: ReplayRequestLog): void => {
    if (!options.logPath) return;
    appendFileSync(options.logPath, `${JSON.stringify(entry)}\n`);
  };
  // The contamination control is the "hi" session. Its body is kept once per hash, so a drift can be read later.
  const keepControlBody = (session: string | null, sha: string, raw: string): void => {
    if (!options.logPath || session !== "hi") return;
    const path = `${options.logPath}.hi-${sha.slice(0, 12)}.json`;
    if (!existsSync(path)) writeFileSync(path, raw);
  };

  const selectBlocks = (
    session: ReplaySession | null,
    body: Record<string, unknown> | null,
  ): SessionTurn => {
    if (!session) {
      return {
        index: 0,
        blocks: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {},
      };
    }
    const selected = selectTurn(session, assistantCount(body));
    if (!selected) {
      return {
        index: 0,
        blocks: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {},
      };
    }
    const rewritten = applyRootRewrite(session, selected.turn.blocks, body, options.envWorktree);
    if (rewritten.miss) stats.rewrite_misses += 1;
    return { ...selected.turn, blocks: rewritten.blocks };
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/_ademark/health") return json({ ok: true });
    if (request.method === "GET" && path === "/_ademark/stats") return json(stats);
    if (request.method === "POST" && path === "/_ademark/reset") {
      resetStats();
      return json(stats);
    }
    if (request.method !== "POST") return json({ error: "not_found" }, 404);

    const bytes = new Uint8Array(await request.arrayBuffer());
    const raw = new TextDecoder().decode(bytes);
    const body = parseJson(raw);

    if (path === "/v1/messages/count_tokens") {
      stats.requests += 1;
      const session = matchSession(sessions, body);
      log({
        t_ns: Number(nowNs()),
        api: "anthropic",
        path,
        bytes: bytes.length,
        body_sha256: bodySha256(raw),
        session: session?.name ?? null,
        user_agent: request.headers.get("user-agent"),
      });
      return json({ input_tokens: Math.ceil(bytes.length / 4) });
    }

    const api = apiFor(path);
    if (!api) return json({ error: "not_found" }, 404);

    const session = matchSession(sessions, body);
    stats.requests += 1;
    if (session) stats.by_session[session.name] = (stats.by_session[session.name] ?? 0) + 1;
    else stats.unknown += 1;

    const sha = bodySha256(raw);
    log({
      t_ns: Number(nowNs()),
      api,
      path,
      bytes: bytes.length,
      body_sha256: sha,
      session: session?.name ?? null,
      user_agent: request.headers.get("user-agent"),
    });
    keepControlBody(session?.name ?? null, sha, raw);

    const turn = selectBlocks(session, body);
    const model = typeof body?.model === "string" ? body.model : "unknown";
    const context = {
      model,
      inputTokens: turn.usage.input_tokens ?? Math.ceil(bytes.length / 4),
      pacing: session?.pacing ?? "fixed",
    };
    const stream = body?.stream === true;

    if (api === "anthropic") {
      if (!stream) return json(anthropicMessage(turn, context));
      return sseResponse((write) => streamAnthropic(turn, context, write));
    }
    if (!stream) return json(openAiResponse(turn, context));
    return sseResponse((write) => streamOpenAi(turn, context, write));
  };

  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      try {
        return await handler(request);
      } catch (error) {
        return json({ error: "replay_failure", message: String(error) }, 500);
      }
    },
  });

  return {
    server,
    port: server.port,
    stats: () => ({ ...stats, by_session: { ...stats.by_session } }),
    resetStats,
    stop: () => server.stop(true),
  };
}

function parseArgs(argv: string[]): ReplayServerOptions {
  const options: ReplayServerOptions = {
    port: 0,
    sessionsDir: "bench/replay/sessions",
    logPath: null,
  };
  let portGiven = false;
  const known = new Set(["--port", "--sessions", "--log"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!known.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--port") {
      options.port = Number(value);
      portGiven = true;
    } else if (flag === "--sessions") options.sessionsDir = value;
    else if (flag === "--log") options.logPath = value;
  }
  if (!portGiven || !Number.isInteger(options.port) || options.port < 0) {
    throw new Error("--port is required");
  }
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const handle = startReplayServer(options);
    console.log(`ademark-replay listening on http://127.0.0.1:${handle.port}`);
  } catch (error) {
    console.error(String(error));
    process.exit(2);
  }
}
