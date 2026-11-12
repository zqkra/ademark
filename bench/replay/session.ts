// Session files are the replay source: one header line, then one line per assistant turn.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type ReplayApi = "anthropic" | "openai";

export type ReplayPacing = "fixed" | "none";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type SessionBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface SessionUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SessionTurn {
  index: number;
  blocks: SessionBlock[];
  stop_reason: string;
  usage: SessionUsage;
}

export interface ReplaySession {
  name: string;
  api: ReplayApi;
  match: string;
  root: string;
  pacing: ReplayPacing;
  standIn: boolean;
  turns: SessionTurn[];
  file: string;
}

export interface SelectedTurn {
  turn: SessionTurn;
  synthetic: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseBlock(value: unknown): SessionBlock {
  const block = asRecord(value);
  if (!block || typeof block.type !== "string") {
    throw new Error(`bad session block: ${JSON.stringify(value)}`);
  }
  if (block.type === "text") {
    if (typeof block.text !== "string") throw new Error("text block without text");
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    if (typeof block.id !== "string" || typeof block.name !== "string") {
      throw new Error("tool_use block without id or name");
    }
    const input = asRecord(block.input) ?? {};
    return { type: "tool_use", id: block.id, name: block.name, input };
  }
  if (block.type === "thinking") {
    if (typeof block.thinking !== "string") throw new Error("thinking block without thinking");
    return { type: "thinking", thinking: block.thinking };
  }
  throw new Error(`unknown session block type: ${block.type}`);
}

function parseUsage(value: unknown): SessionUsage {
  const usage = asRecord(value) ?? {};
  const out: SessionUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const) {
    if (typeof usage[key] === "number") out[key] = usage[key] as number;
  }
  return out;
}

function parsePacing(value: unknown, file: string): ReplayPacing {
  if (value === undefined) return "fixed";
  if (value === "fixed" || value === "none") return value;
  throw new Error(`bad session pacing in ${file}: ${JSON.stringify(value)}`);
}

export function parseSessionFile(file: string, content: string): ReplaySession {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error(`empty session file: ${file}`);
  const header = asRecord(JSON.parse(lines[0]));
  if (!header || header.type !== "session") throw new Error(`missing session header: ${file}`);
  const api = header.api;
  if (api !== "anthropic" && api !== "openai") throw new Error(`bad session api in ${file}`);
  if (typeof header.match !== "string") throw new Error(`session without match: ${file}`);
  const name = typeof header.name === "string" ? header.name : file;
  const root = typeof header.root === "string" ? header.root : "";
  const pacing = parsePacing(header.pacing, file);
  const standIn = header.stand_in === true;
  const turns: SessionTurn[] = [];
  for (const line of lines.slice(1)) {
    const row = asRecord(JSON.parse(line));
    if (!row || row.type !== "turn") throw new Error(`bad turn line in ${file}`);
    if (!Array.isArray(row.blocks)) throw new Error(`turn without blocks in ${file}`);
    turns.push({
      index: typeof row.index === "number" ? row.index : turns.length,
      blocks: row.blocks.map(parseBlock),
      stop_reason: typeof row.stop_reason === "string" ? row.stop_reason : "end_turn",
      usage: parseUsage(row.usage),
    });
  }
  turns.sort((a, b) => a.index - b.index);
  return { name, api, match: header.match, root, pacing, standIn, turns, file };
}

export function loadSessionFile(path: string): ReplaySession {
  return parseSessionFile(path, readFileSync(path, "utf8"));
}

export function loadSessions(dir: string): ReplaySession[] {
  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort();
  return files.map((entry) => loadSessionFile(join(dir, entry)));
}

export function findSession(sessions: ReplaySession[], firstUserMessage: string): ReplaySession | null {
  const wanted = firstUserMessage.trim();
  for (const session of sessions) {
    if (session.match.trim() === wanted) return session;
  }
  return null;
}

function contentBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push(part);
      continue;
    }
    const record = asRecord(part);
    if (record && typeof record.text === "string") blocks.push(record.text);
  }
  return blocks;
}

function userContents(body: unknown): unknown[] {
  const record = asRecord(body);
  if (!record) return [];
  const contents: unknown[] = [];
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      const entry = asRecord(message);
      if (entry?.role === "user") contents.push(entry.content);
    }
    return contents;
  }
  if (typeof record.input === "string") return [record.input];
  if (Array.isArray(record.input)) {
    for (const item of record.input) {
      const entry = asRecord(item);
      if (entry?.role === "user") contents.push(entry.content);
    }
    return contents;
  }
  return contents;
}

export function firstUserText(body: unknown): string {
  const contents = userContents(body);
  if (contents.length === 0) return "";
  return contentBlocks(contents[0]).join("").trim();
}

// Candidates come from every user message, in order: the trimmed concatenation of its text
// first, then each text block on its own, without empties or duplicates.
// Some clients (Claude Code, Codex) put reminders or AGENTS.md text in earlier user messages.
export function userTextCandidates(body: unknown): string[] {
  const candidates: string[] = [];
  const push = (value: string): void => {
    const text = value.trim();
    if (text.length === 0 || candidates.includes(text)) return;
    candidates.push(text);
  };
  for (const content of userContents(body)) {
    const blocks = contentBlocks(content);
    push(blocks.join(""));
    for (const block of blocks) push(block);
  }
  return candidates;
}

export function matchSession(sessions: ReplaySession[], body: unknown): ReplaySession | null {
  for (const candidate of userTextCandidates(body)) {
    const session = findSession(sessions, candidate) ?? findLongerStream(sessions, candidate);
    if (session) return session;
  }
  return null;
}

// The fixed pacing of anthropic.ts (16 characters every 50 ms). Kept here so session.ts does not import an emitter.
const PACED_CHARS_PER_S = (16 * 1000) / 50;
const LONGER_STREAM = /^(replay:stream-[1-5]) @(\d+)s$/;
const LONGEST_STREAM_S = 600;

/**
 * ADEMARK-41: `replay:stream-N @240s` selects stream-N with its last text block made long enough to stream 240 s. A7
 * asks for it when a profile's five starts spread too far for 150 s together (2026-11-09: Orca had 139 s). The session
 * keeps its name, so the stats and the request log count it as stream-N. The text grows by whole paragraphs of its own
 * answer, never cut inside a code fence, so it lasts at least the time asked for.
 */
export function findLongerStream(sessions: ReplaySession[], text: string): ReplaySession | null {
  const match = LONGER_STREAM.exec(text.trim());
  if (match === null) return null;
  const seconds = Number(match[2]);
  if (seconds < 1 || seconds > LONGEST_STREAM_S) return null;
  const session = findSession(sessions, match[1]!);
  if (session === null || session.pacing !== "fixed" || session.turns.length === 0) return null;
  const last = session.turns[session.turns.length - 1]!;
  const index = last.blocks.findLastIndex((block) => block.type === "text");
  if (index < 0) return null;
  const block = last.blocks[index] as TextBlock;
  const target = Math.ceil(seconds * PACED_CHARS_PER_S);
  if (block.text.length >= target) return session;
  const longer = lengthen(block.text, target);
  const blocks = last.blocks.map((entry, at) => (at === index ? { ...block, text: longer } : entry));
  const usage = { ...last.usage, output_tokens: Math.ceil(longer.length / 4) };
  return { ...session, turns: [...session.turns.slice(0, -1), { ...last, blocks, usage }] };
}

// Paragraphs split on blank lines outside code fences, so a fence is always taken whole.
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (line.trim().length === 0 && !inFence) {
      if (current.length > 0) out.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) out.push(current.join("\n"));
  return out;
}

function lengthen(text: string, target: number): string {
  const parts = paragraphs(text);
  let out = text;
  for (let at = 0; out.length < target; at = (at + 1) % parts.length) out += `\n\n${parts[at]}`;
  return out;
}

function isAssistantOutput(item: Record<string, unknown>): boolean {
  if (item.type === "function_call" || item.type === "reasoning") return true;
  return item.type === "message" && item.role === "assistant";
}

export function assistantCount(body: unknown): number {
  const record = asRecord(body);
  if (!record) return 0;
  if (Array.isArray(record.messages)) {
    return record.messages.filter((message) => asRecord(message)?.role === "assistant").length;
  }
  if (Array.isArray(record.input)) {
    let count = 0;
    let inRun = false;
    for (const item of record.input) {
      const entry = asRecord(item);
      if (entry && isAssistantOutput(entry)) {
        if (!inRun) {
          count += 1;
          inRun = true;
        }
      } else {
        inRun = false;
      }
    }
    return count;
  }
  return 0;
}

export function selectTurn(session: ReplaySession, index: number): SelectedTurn | null {
  if (session.turns.length === 0) return null;
  if (index >= 0 && index < session.turns.length) {
    return { turn: session.turns[index], synthetic: false };
  }
  const last = session.turns[session.turns.length - 1];
  if (index < 0) return { turn: last, synthetic: false };
  return {
    turn: {
      index,
      blocks: last.blocks.filter((block): block is TextBlock => block.type === "text"),
      stop_reason: "end_turn",
      usage: last.usage,
    },
    synthetic: true,
  };
}

const WORKTREE_PATTERNS = [
  /Primary working directory: (\S+)/,
  /Working directory: (\S+)/,
  /CWD: (\S+)/,
  /<cwd>([^<]+)<\/cwd>/,
];

function walkStrings(value: unknown, visit: (text: string) => boolean): boolean {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (walkStrings(item, visit)) return true;
    }
    return false;
  }
  const record = asRecord(value);
  if (!record) return false;
  for (const entry of Object.values(record)) {
    if (walkStrings(entry, visit)) return true;
  }
  return false;
}

function findCwdKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCwdKey(item);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.cwd === "string" && record.cwd.trim().length > 0) return record.cwd.trim();
  for (const entry of Object.values(record)) {
    const found = findCwdKey(entry);
    if (found) return found;
  }
  return null;
}

export function currentWorktreePath(body: unknown, env = process.env.ADEMARK_WORKTREE): string | null {
  let found = "";
  walkStrings(body, (text) => {
    for (const pattern of WORKTREE_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        found = match[1].trim();
        return true;
      }
    }
    return false;
  });
  if (found.length > 0) return found;
  const fromKey = findCwdKey(body);
  if (fromKey) return fromKey;
  return env && env.trim().length > 0 ? env.trim() : null;
}

export function rewriteValue(value: unknown, root: string, current: string): unknown {
  if (typeof value === "string") return value.split(root).join(current);
  if (Array.isArray(value)) return value.map((entry) => rewriteValue(entry, root, current));
  const record = asRecord(value);
  if (record) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      out[key] = rewriteValue(entry, root, current);
    }
    return out;
  }
  return value;
}

export function turnNeedsRewrite(blocks: SessionBlock[], root: string): boolean {
  if (!root) return false;
  return blocks.some(
    (block) => block.type === "tool_use" && JSON.stringify(block.input).includes(root),
  );
}

export function rewriteTurnBlocks(blocks: SessionBlock[], root: string, current: string): SessionBlock[] {
  return blocks.map((block) =>
    block.type === "tool_use"
      ? { ...block, input: rewriteValue(block.input, root, current) as Record<string, unknown> }
      : block,
  );
}

export interface RootRewrite {
  blocks: SessionBlock[];
  attempted: boolean;
  miss: boolean;
}

export function applyRootRewrite(
  session: ReplaySession,
  blocks: SessionBlock[],
  body: unknown,
  env?: string,
): RootRewrite {
  if (!turnNeedsRewrite(blocks, session.root)) return { blocks, attempted: false, miss: false };
  const current = currentWorktreePath(body, env);
  if (!current) return { blocks, attempted: true, miss: true };
  return { blocks: rewriteTurnBlocks(blocks, session.root, current), attempted: true, miss: false };
}
