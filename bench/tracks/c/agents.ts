// What the captured requests of a C1 run say about its agents: how many there were, and when the last one worked.
//
// 2026-11-11, before the first real C1. The end of a run was the first session log with an end of turn
// (waitForEndOfTurn). With several agents that is one worker that finished, or a lead that handed the work out and
// ended its turn, while the others still build: the grade would read a half-built repository. And a run where no
// worker ever started (a trigger line that did nothing, orchestration switched off) would have been published as an
// orchestrated build. The capture answers both, from the request bodies alone:
// - a request whose last user message answers a tool is an agent in the middle of its work;
// - a request that starts a thread of its own, with tools that change the repository, is one agent.
// Checked on the 25 real captures of 6 and 7 Nov (reduced copies of their requests are the fixture
// bench/test/fixtures/c-agents-2026-11.json): every app sends a session id, no session starts two threads in one
// single-agent turn, and every block of one agent reads as one agent.
import { createHash } from "node:crypto";
import { isCompletion, threadShape } from "../../capture/tokens.ts";
import type { CaptureRow } from "../../core/contracts.ts";

export interface RequestMeta {
  /** The client's session id (`metadata.user_id` of Claude Code, as JSON or as `..._session_<id>`), or null. */
  session: string | null;
  /** The request carries a tool that changes the repository. A title, a quota and a metadata call do not. */
  coding: boolean;
  /** The last user message answers a tool: an agent in the middle of its work. */
  answersTool: boolean;
  /** A hash of the first user message when this request starts a thread of its own with coding tools; else null. */
  root: string | null;
}

const CODING_TOOLS = /^(bash|edit|write|multiedit|notebookedit|shell|local_shell|exec_command|apply_patch)$/i;
// Calls that start a thread and are not an agent: Claude Code's suggestion of the next prompt, and the summary that
// replaces a conversation that ran out of context (the lead then goes on under a new first message).
const NOT_AN_AGENT = [/\[SUGGESTION MODE/, /^This session is being continued from a previous conversation/];

function sessionOf(body: Record<string, unknown>): string | null {
  const user = (body.metadata as { user_id?: unknown } | undefined)?.user_id;
  if (typeof user !== "string") return null;
  try {
    const parsed = JSON.parse(user) as { session_id?: unknown };
    if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) return parsed.session_id;
  } catch {
    // An older client sends `user_<hash>_account_<uuid>_session_<uuid>`.
  }
  return /session_([0-9a-f-]{36})/.exec(user)?.[1] ?? null;
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool) => {
    const record = tool as { name?: unknown; function?: { name?: unknown }; type?: unknown } | null;
    const name = record?.name ?? record?.function?.name ?? record?.type;
    return typeof name === "string" ? [name] : [];
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown } | null)?.text === "string" ? (part as { text: string }).text : "")).join("");
}

function firstUserText(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) {
    const first = (body.messages as { role?: unknown; content?: unknown }[]).find((message) => message?.role === "user");
    return textOf(first?.content).trim();
  }
  if (typeof body.input === "string") return body.input.trim();
  if (Array.isArray(body.input)) {
    const first = (body.input as { role?: unknown; content?: unknown }[]).find((item) => item?.role === "user");
    return textOf(first?.content).trim();
  }
  return "";
}

/** Null for a body that is not a model request. */
export function requestMeta(body: unknown): RequestMeta | null {
  const shape = threadShape(body);
  if (shape === null) return null;
  const record = body as Record<string, unknown>;
  const coding = toolNames(record).some((name) => CODING_TOOLS.test(name));
  const text = firstUserText(record);
  const starts = coding && shape.startsTurn && !shape.continuation && text.length > 0 && !NOT_AN_AGENT.some((pattern) => pattern.test(text));
  return {
    session: sessionOf(record),
    coding,
    answersTool: !shape.startsTurn,
    root: starts ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null,
  };
}

export interface AgentsSeen {
  /**
   * Agents that worked: each client session with an answer to a tool counts once, and once more for each further
   * thread it started (a subagent shares the session of its parent). A session that never answered a tool is not an
   * agent, whatever it carries: MonoCode's title call has the full tool list (7 Nov).
   */
  agents: number;
  /** Client sessions with at least one answer to a tool. */
  sessions: number;
  /** How many requests answered a tool. */
  toolAnswers: number;
  /** When the last answer to a tool ended (the `t_ns` of its row), or null. */
  lastWorkNs: number | null;
}

/** Reads each body once: a run has thousands of requests, and the watch looks at the capture every few seconds. */
export class AgentWatch {
  private readonly metas = new Map<string, RequestMeta | null>();

  constructor(private readonly bodyText: (row: CaptureRow) => string | null) {}

  metaOf(row: CaptureRow): RequestMeta | null {
    if (row.body_file === null) return null;
    if (!this.metas.has(row.body_file)) {
      let meta: RequestMeta | null = null;
      try {
        const text = this.bodyText(row);
        meta = text === null ? null : requestMeta(JSON.parse(text));
      } catch {
        meta = null;
      }
      this.metas.set(row.body_file, meta);
    }
    return this.metas.get(row.body_file)!;
  }

  /** The agents of the requests that ended in [fromNs, toNs]. A refused request is not work. */
  read(rows: readonly CaptureRow[], fromNs: number, toNs: number = Number.POSITIVE_INFINITY): AgentsSeen {
    // A request with no session id (another client) goes to one shared session.
    const sessions = new Map<string, { roots: Set<string>; answers: number }>();
    let toolAnswers = 0;
    let lastWorkNs: number | null = null;
    for (const row of rows) {
      // A row with no path is not a model request: the run check names it, the watch goes on.
      if (typeof row.path !== "string" || row.t_ns < fromNs || row.t_ns > toNs || row.status >= 400 || !isCompletion(row)) continue;
      const meta = this.metaOf(row);
      if (meta === null) continue;
      const key = meta.session ?? "-";
      const session = sessions.get(key) ?? { roots: new Set<string>(), answers: 0 };
      sessions.set(key, session);
      if (meta.root !== null) session.roots.add(meta.root);
      if (meta.answersTool) {
        session.answers += 1;
        toolAnswers += 1;
        if (lastWorkNs === null || row.t_ns > lastWorkNs) lastWorkNs = row.t_ns;
      }
    }
    const working = [...sessions.values()].filter((session) => session.answers > 0);
    return {
      agents: working.reduce((sum, session) => sum + Math.max(1, session.roots.size), 0),
      sessions: working.length,
      toolAnswers,
      lastWorkNs,
    };
  }
}
