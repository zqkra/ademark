// Session logs are the end-of-turn signal for waitDone (TESTS.md 1.7): Claude Code and Codex JSONL,
// pure parsers plus one poller. The formats are the ones Claude Code 2.1.303 and Codex 0.163.0 write.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AdapterContext, Agent, CapturedUsage } from "../core/contracts.ts";

export type SessionAgent = "claude" | "codex";

export interface SessionSummary {
  sessionId: string | null;
  cwd: string | null;
  version: string | null;
  model: string | null;
  effort: string | null;
  ended: boolean;
  endedAt: string | null;
  usage: CapturedUsage;
  /** Tool-use blocks on the main chain (Claude) or function/custom tool calls (Codex). */
  toolCalls: number;
  /** The last assistant text of the main chain. */
  lastText: string | null;
  /** Every model that wrote on the main chain, because its usage is all in `usage`. */
  models: string[];
  /** What the user sent on the main chain (Claude), to tell the test's session from a title session in the same folder. */
  userTexts: string[];
}

export interface SessionLogFile {
  path: string;
  mtimeMs: number;
  summary: SessionSummary;
}

export interface FindSessionLogsOptions {
  home: string;
  agent: SessionAgent;
  cwd: string;
  since: number | Date;
  /** Also match sessions anywhere under this folder (an ADE that opens its own worktree per thread). */
  cwdPrefix?: string;
}

export interface WaitOptions {
  ctx: AdapterContext;
  agent: Agent;
  cwd: string;
  since: number | Date;
  timeoutMs: number;
  pollMs: number;
  cwdPrefix?: string;
  /**
   * TESTS.md 1.7 idle rule for ADEs whose agent writes no session log. Pilot 2026-10-20: with it on, a Bare CLI seed
   * thread whose prompt was never submitted counted as done after 10 s. Adapters whose agent writes a log turn it off,
   * so only a real end of turn ends the wait.
   */
  idleFallback?: boolean;
}

export const FILE_QUIET_MS = 60_000;
export const CPU_WINDOW_MS = 10_000;
const SCAN_EVERY_MS = 10_000;
// The active log grows with every request, so a full parse is only worth a scan every few seconds.
const LOG_SCAN_MS = 5_000;
const AGENT_EXECUTABLES = new Set(["claude", "codex"]);

type Json = Record<string, unknown>;

function emptyUsage(): CapturedUsage {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0 };
}

function emptySummary(): SessionSummary {
  return {
    sessionId: null,
    cwd: null,
    version: null,
    model: null,
    effort: null,
    ended: false,
    endedAt: null,
    usage: emptyUsage(),
    toolCalls: 0,
    lastText: null,
    models: [],
    userTexts: [],
  };
}

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const found = text(value);
    if (found !== null) return found;
  }
  return null;
}

function jsonLines(content: string): Json[] {
  const out: Json[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = asObject(JSON.parse(line));
      if (parsed !== null) out.push(parsed);
    } catch {
      // A half-written last line is normal while the agent is still appending.
    }
  }
  return out;
}

function contentBlocks(content: unknown): Json[] {
  if (!Array.isArray(content)) return [];
  const blocks: Json[] = [];
  for (const part of content) {
    const block = asObject(part);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

// Claude Code names assistant text blocks `text`; Codex rollouts name them `output_text`.
function contentText(content: unknown, types: ReadonlySet<string>): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  const parts: string[] = [];
  for (const block of contentBlocks(content)) {
    if (!types.has(text(block.type) ?? "")) continue;
    const value = text(block.text);
    if (value !== null) parts.push(value);
  }
  return parts.length === 0 ? null : parts.join("\n");
}

const CLAUDE_TEXT_BLOCKS = new Set(["text"]);
/** Claude Code writes this model on a line it made itself, such as an API error. */
const SYNTHETIC_MODEL = "<synthetic>";
const CODEX_TEXT_BLOCKS = new Set(["output_text", "text"]);

function claudeUsage(usage: Json | null): CapturedUsage {
  if (usage === null) return emptyUsage();
  const breakdown = asObject(usage.cache_creation);
  return {
    input: count(usage.input_tokens),
    cache_write: count(usage.cache_creation_input_tokens),
    ...(breakdown === null ? {} : { cache_write_1h: count(breakdown.ephemeral_1h_input_tokens) }),
    cache_read: count(usage.cache_read_input_tokens),
    output: count(usage.output_tokens),
  };
}

function codexUsage(info: Json | null): CapturedUsage {
  const usage = asObject(info?.total_token_usage) ?? asObject(info?.last_token_usage);
  if (usage === null) return emptyUsage();
  return {
    input: count(usage.input_tokens),
    cache_write: count(usage.cache_write_input_tokens),
    cache_read: count(usage.cached_input_tokens),
    output: count(usage.output_tokens),
  };
}

export function addUsage(into: CapturedUsage, from: CapturedUsage): void {
  const ttlKnown = (usage: CapturedUsage): boolean => usage.cache_write === 0 || usage.cache_write_1h !== undefined;
  const known = ttlKnown(into) && ttlKnown(from);
  const writes1h = (into.cache_write_1h ?? 0) + (from.cache_write_1h ?? 0);
  into.input += from.input;
  into.cache_write += from.cache_write;
  if (into.cache_write > 0) into.cache_write_1h = known ? writes1h : undefined;
  into.cache_read += from.cache_read;
  into.output += from.output;
}

// Claude Code 2.1.303: one JSON object per line. `isSidechain: true` marks a subagent's own chain.
export function parseClaudeLog(content: string): SessionSummary {
  const summary = emptySummary();
  const usage = emptyUsage();
  // Claude Code writes one line per content block, and every line of a message repeats its usage.
  const usageByMessage = new Map<string, CapturedUsage>();
  let lastType: string | null = null;
  let lastStopReason: string | null = null;
  let lastTimestamp: string | null = null;

  for (const entry of jsonLines(content)) {
    if (entry.isSidechain === true) continue;
    const type = text(entry.type);
    if (type !== "user" && type !== "assistant") continue;

    summary.sessionId ??= text(entry.sessionId);
    // The first cwd is where the CLI was started; a later `cd` inside a tool is not the session's cwd.
    summary.cwd ??= text(entry.cwd);
    summary.version ??= text(entry.version);
    summary.effort = firstText(entry.effort, entry.perTurnEffort) ?? summary.effort;
    lastType = type;
    lastTimestamp = text(entry.timestamp) ?? lastTimestamp;

    const message = asObject(entry.message);
    if (type !== "assistant" || message === null) {
      lastStopReason = null;
      const said = message === null ? null : typeof message.content === "string" ? message.content : contentText(message.content, CLAUDE_TEXT_BLOCKS);
      if (said !== null) summary.userTexts.push(said);
      continue;
    }
    summary.model = firstText(message.model) ?? summary.model;
    const wrote = firstText(message.model);
    if (wrote !== null && wrote !== SYNTHETIC_MODEL && !summary.models.includes(wrote)) summary.models.push(wrote);
    const messageId = text(message.id);
    if (messageId === null) addUsage(usage, claudeUsage(asObject(message.usage)));
    else usageByMessage.set(messageId, claudeUsage(asObject(message.usage)));
    lastStopReason = text(message.stop_reason);
    for (const block of contentBlocks(message.content)) {
      if (text(block.type) === "tool_use") summary.toolCalls += 1;
    }
    summary.lastText = contentText(message.content, CLAUDE_TEXT_BLOCKS) ?? summary.lastText;
  }

  for (const messageUsage of usageByMessage.values()) addUsage(usage, messageUsage);
  summary.usage = usage;
  summary.ended = lastType === "assistant" && lastStopReason === "end_turn";
  summary.endedAt = summary.ended ? lastTimestamp : null;
  return summary;
}

// Codex 0.163.0 rollout: `{timestamp, type, payload}` per line.
export function parseCodexLog(content: string): SessionSummary {
  const summary = emptySummary();
  const summedLast = emptyUsage();
  let totalUsage: CapturedUsage | null = null;
  let lastStarted = -1;
  let lastComplete = -1;
  let completeAt: string | null = null;

  jsonLines(content).forEach((entry, index) => {
    const type = text(entry.type);
    const payload = asObject(entry.payload) ?? {};
    if (type === "session_meta") {
      summary.sessionId ??= firstText(payload.id, payload.session_id);
      summary.cwd ??= text(payload.cwd);
      summary.version ??= text(payload.cli_version);
      return;
    }
    if (type === "turn_context") {
      summary.model = text(payload.model) ?? summary.model;
      const mode = asObject(payload.collaboration_mode);
      const settings = asObject(mode?.settings);
      summary.effort =
        firstText(payload.effort, payload.reasoning_effort, settings?.reasoning_effort) ?? summary.effort;
      return;
    }
    if (type === "response_item") {
      const kind = text(payload.type);
      if (kind === "function_call" || kind === "custom_tool_call") summary.toolCalls += 1;
      if (kind === "message" && text(payload.role) === "assistant") {
        summary.lastText = contentText(payload.content, CODEX_TEXT_BLOCKS) ?? summary.lastText;
      }
      return;
    }
    if (type !== "event_msg") return;
    const kind = text(payload.type);
    if (kind === "agent_message") {
      summary.lastText = firstText(payload.message) ?? summary.lastText;
      return;
    }
    if (kind === "task_started") lastStarted = index;
    if (kind === "task_complete") {
      lastComplete = index;
      completeAt = text(entry.timestamp);
    }
    if (kind === "token_count") {
      const info = asObject(payload.info);
      // total_token_usage is cumulative for the session, so only the last event that has it counts.
      if (asObject(info?.total_token_usage) !== null) totalUsage = codexUsage(info);
      else if (asObject(info?.last_token_usage) !== null) addUsage(summedLast, codexUsage(info));
    }
  });

  summary.usage = totalUsage ?? summedLast;
  summary.ended = lastComplete > lastStarted;
  summary.endedAt = summary.ended ? completeAt : null;
  return summary;
}

export function parseSessionLog(agent: SessionAgent, content: string): SessionSummary {
  return agent === "claude" ? parseClaudeLog(content) : parseCodexLog(content);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// `/tmp/x` and `/private/tmp/x` are the same folder on macOS.
export function sameRealPath(a: string, b: string): boolean {
  const strip = (path: string): string => path.replace(/^\/private(?=\/)/, "");
  return strip(canonical(a)) === strip(canonical(b));
}

export function isUnderRealPath(path: string, folder: string): boolean {
  const strip = (value: string): string => value.replace(/^\/private(?=\/)/, "");
  const base = strip(canonical(folder));
  return strip(canonical(path)).startsWith(base.endsWith("/") ? base : `${base}/`);
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function claudeLogPaths(home: string): string[] {
  const root = join(home, ".claude", "projects");
  const out: string[] = [];
  for (const project of listDir(root)) {
    for (const name of listDir(join(root, project))) {
      if (name.endsWith(".jsonl")) out.push(join(root, project, name));
    }
  }
  return out;
}

function codexLogPaths(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const name of listDir(dir)) {
      const path = join(dir, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) walk(path, depth + 1);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(join(home, ".codex", "sessions"), 0);
  return out;
}

export function findSessionLogs(options: FindSessionLogsOptions): SessionLogFile[] {
  const since = typeof options.since === "number" ? options.since : options.since.getTime();
  const paths = options.agent === "claude" ? claudeLogPaths(options.home) : codexLogPaths(options.home);
  const found: SessionLogFile[] = [];
  for (const path of paths) {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < since) continue;
    const summary = parseSessionLog(options.agent, readFileSync(path, "utf8"));
    if (summary.cwd === null) continue;
    const under = options.cwdPrefix !== undefined && isUnderRealPath(summary.cwd, options.cwdPrefix);
    if (!under && !sameRealPath(summary.cwd, options.cwd)) continue;
    found.push({ path, mtimeMs, summary });
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface IdleProbe {
  newestChangeMs: number | null;
  agentCpuMs: number;
  agentPids: number[];
}

export function parseCpuTime(value: string): number {
  const parts = value.trim().split(":");
  let seconds = 0;
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isFinite(number)) return 0;
    seconds = seconds * 60 + number;
  }
  return Math.round(seconds * 1000);
}

// `ps -axo pid=,cputime=,comm=` rows: pid, cumulative CPU time, command path.
export function parsePsCpu(output: string): Array<{ pid: number; cpuMs: number; name: string }> {
  const out: Array<{ pid: number; cpuMs: number; name: string }> = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    out.push({ pid: Number(match[1]), cpuMs: parseCpuTime(match[2]!), name: basename(match[3]!.trim()) });
  }
  return out;
}

// `lsof -a -d cwd -Fpn` records: a `p<pid>` row, then the cwd as `n<path>`.
export function parseLsofCwds(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    else if (line.startsWith("n") && pid !== null) out.set(pid, line.slice(1).trim());
  }
  return out;
}

// Newest file mtime under a folder. `.git` and `node_modules` are skipped: their churn is huge and says
// little about whether the agent is still working.
export function newestChangeMs(root: string, limit = 20_000): number | null {
  let newest: number | null = null;
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || seen >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= limit) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      seen++;
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (newest === null || mtimeMs > newest) newest = mtimeMs;
      } catch {
        // A file that vanished mid-walk is not a change.
      }
    }
  };
  walk(root, 0);
  return newest;
}

function run(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

export function agentCpuProbe(cwd: string): IdleProbe {
  const processes = parsePsCpu(run(["ps", "-axo", "pid=,cputime=,comm="])).filter((proc) =>
    AGENT_EXECUTABLES.has(proc.name),
  );
  const newest = newestChangeMs(cwd);
  if (processes.length === 0) return { newestChangeMs: newest, agentCpuMs: 0, agentPids: [] };
  const args = ["lsof", "-a", "-d", "cwd", "-Fpn"];
  for (const proc of processes) args.push("-p", String(proc.pid));
  const cwds = parseLsofCwds(run(args));
  const mine = processes.filter((proc) => {
    const found = cwds.get(proc.pid);
    return found !== undefined && sameRealPath(found, cwd);
  });
  return {
    newestChangeMs: newest,
    agentCpuMs: mine.reduce((sum, proc) => sum + proc.cpuMs, 0),
    agentPids: mine.map((proc) => proc.pid),
  };
}

function sessionAgent(agent: Agent): SessionAgent {
  if (agent === "claude" || agent === "codex") return agent;
  throw new Error(`no session log for agent "${agent}"`);
}

// The idle fallback of TESTS.md 1.7: the worktree is quiet and no agent process spent CPU there recently.
export interface WaitDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  probe(cwd: string): IdleProbe;
}

const defaultWaitDeps: WaitDeps = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  probe: (cwd) => agentCpuProbe(cwd),
};

export async function waitForEndOfTurn(
  options: WaitOptions & { deps?: Partial<WaitDeps> },
): Promise<{ done: boolean; reason: string }> {
  // An ADE's own agent (Capy) writes no session log this harness can read, so only the idle fallback can end its wait.
  // Until 2026-11-11 this threw before that fallback was reached, and Capy's block ended at its first seed thread
  // ('no session log for agent "own"') although its profile sets idleFallback. Without the fallback it still throws:
  // a wait that nothing can end must not start.
  const agent = options.agent === "own" && options.idleFallback !== false ? null : sessionAgent(options.agent);
  const since = typeof options.since === "number" ? options.since : options.since.getTime();
  const deps: WaitDeps = { ...defaultWaitDeps, ...options.deps };
  const startedAt = deps.now();
  const pollMs = options.pollMs > 0 ? options.pollMs : 1000;
  let previousCpuMs: number | null = null;
  let lastCpuAt = startedAt;
  let newestChange: number | null = null;
  let lastProbeAt = -Infinity;
  let lastLogAt = -Infinity;

  while (true) {
    const now = deps.now();
    if (agent !== null && now - lastLogAt >= LOG_SCAN_MS) {
      lastLogAt = now;
      const logs = findSessionLogs({ home: options.ctx.home, agent, cwd: options.cwd, since, cwdPrefix: options.cwdPrefix });
      const ended = logs.find((log) => log.summary.ended);
      if (ended !== undefined) {
        options.ctx.log(`waitDone: end of turn in ${ended.path}`);
        return { done: true, reason: "end_turn" };
      }
    }

    if (options.idleFallback !== false && now - lastProbeAt >= SCAN_EVERY_MS) {
      const probe = deps.probe(options.cwd);
      lastProbeAt = now;
      if (previousCpuMs !== null && probe.agentCpuMs > previousCpuMs) lastCpuAt = now;
      previousCpuMs = probe.agentCpuMs;
      if (probe.newestChangeMs !== null) {
        newestChange = newestChange === null ? probe.newestChangeMs : Math.max(newestChange, probe.newestChangeMs);
      }
      const fileQuiet = newestChange === null || now - newestChange >= FILE_QUIET_MS;
      if (fileQuiet && now - lastCpuAt >= CPU_WINDOW_MS) {
        options.ctx.log(`waitDone: idle fallback after ${Math.round((now - startedAt) / 1000)} s`);
        return { done: true, reason: "idle" };
      }
    }

    if (deps.now() - startedAt >= options.timeoutMs) return { done: false, reason: "timeout" };
    await deps.sleep(pollMs);
  }
}