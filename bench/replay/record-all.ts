// Records the real stream-1 to stream-5 sessions in the pilot: one fresh arena copy, one recorder run
// and one Claude Code run per stream, then a cut to exactly the characters Track A replays.
// Usage: bun bench/replay/record-all.ts [--only stream-<n>] [--dry-run] [--upstream <url>] [--out <dir>]

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "../core/paths";
import { RECORDED_STREAMS, SESSIONS_DIR, STREAM_CHARS, mayReplace } from "./build-sessions";
import { startRecorder } from "./record";
import { recordingPrompt, recordingSource } from "./recordings";
import { parseSessionFile, type SessionBlock, type SessionTurn } from "./session";
import { withoutAgentSession } from "../core/env.ts";

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const RECORDING_USER = "ademark";
export const RECORDING_MODEL = "claude-opus-5-5";
export const RECORDING_MAX_TURNS = 40;

export interface AgentRun {
  prompt: string;
  cwd: string;
  baseUrl: string;
}

export type AgentRunner = (run: AgentRun) => Promise<void>;

export interface PostProcessOptions {
  stream: number;
  root: string;
  limit?: number;
}

export interface PostProcessResult {
  content: string;
  chars: number;
  turns: number;
}

// Characters a block puts on the wire: its text, or its tool input JSON.
export function blockChars(block: SessionBlock): number {
  if (block.type === "text") return block.text.length;
  if (block.type === "tool_use") return JSON.stringify(block.input).length;
  return 0;
}

export function streamedChars(blocks: SessionBlock[]): number {
  return blocks.reduce((sum, block) => sum + blockChars(block), 0);
}

// Keeps whole turns until the streamed characters reach the limit, then cuts inside the text
// block that crosses it, so the replayed answer is exactly `limit` characters long.
export function cutTurns(turns: SessionTurn[], limit: number): SessionTurn[] {
  const kept: SessionTurn[] = [];
  let total = 0;
  for (const turn of turns) {
    if (total >= limit) break;
    const blocks: SessionBlock[] = [];
    let cut = false;
    for (const block of turn.blocks) {
      const size = blockChars(block);
      if (total + size <= limit) {
        blocks.push(block);
        total += size;
        continue;
      }
      if (block.type === "text" && limit > total) {
        blocks.push({ type: "text", text: block.text.slice(0, limit - total) });
        total = limit;
      }
      cut = true;
      break;
    }
    if (blocks.length > 0) {
      kept.push({
        index: kept.length,
        blocks,
        stop_reason: cut ? "end_turn" : turn.stop_reason,
        usage: turn.usage,
      });
    }
    if (cut) break;
  }
  return kept;
}

export function postProcess(raw: string, options: PostProcessOptions): PostProcessResult {
  const name = `stream-${options.stream}`;
  const limit = options.limit ?? STREAM_CHARS;
  const session = parseSessionFile(name, raw);
  const turns = cutTurns(session.turns, limit);
  if (turns.length === 0) throw new Error(`the recording for ${name} has no turns`);
  const header = {
    type: "session",
    name,
    api: session.api,
    match: `replay:${name}`,
    root: options.root,
  };
  const lines = [header].concat(
    turns.map((turn) => ({
      type: "turn",
      index: turn.index,
      blocks: turn.blocks,
      stop_reason: turn.stop_reason,
      usage: turn.usage,
    })),
  );
  return {
    content: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    chars: turns.reduce((sum, turn) => sum + streamedChars(turn.blocks), 0),
    turns: turns.length,
  };
}

export async function claudeAgent(run: AgentRun): Promise<void> {
  const proc = Bun.spawn(
    [
      "claude",
      "--setting-sources",
      "project",
      "--no-session-persistence",
      "-p",
      run.prompt,
      "--model",
      RECORDING_MODEL,
      "--max-turns",
      String(RECORDING_MAX_TURNS),
    ],
    {
      cwd: run.cwd,
      env: { ...withoutAgentSession(), ANTHROPIC_BASE_URL: run.baseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const tail = (stderr.trim() || stdout.trim()).split("\n").slice(-3).join("\n");
    console.error(`claude exited ${code}; the recording stops where it stopped: ${tail}`);
  }
}

// The recorder assembles each answer after the client has read it, so wait for the file to stop growing.
async function waitForSettled(path: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  let lastSize = -1;
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size === lastSize) return;
      lastSize = size;
    }
    await Bun.sleep(100);
  }
  if (!existsSync(path)) throw new Error(`the recorder wrote no session to ${path}`);
}

export interface RecordStreamOptions {
  stream: number;
  upstream: string;
  outDir: string;
  arenaDir?: string;
  agent?: AgentRunner;
  workDir?: string;
  force?: boolean;
}

export interface RecordStreamResult {
  file: string;
  root: string;
  chars: number;
  turns: number;
}

export async function recordStream(options: RecordStreamOptions): Promise<RecordStreamResult> {
  const file = join(options.outDir, `stream-${options.stream}.jsonl`);
  if (!options.force && !mayReplace(file)) {
    throw new Error(`refusing to overwrite the recording at ${file}; pass --force to replace it`);
  }
  const prompt = recordingPrompt(options.stream);
  const work = options.workDir ?? mkdtempSync(join(tmpdir(), `ademark-record-stream-${options.stream}-`));
  const root = join(work, "arena");
  cpSync(options.arenaDir ?? join(repoRoot, "arena"), root, { recursive: true });
  const raw = join(work, "recorded.jsonl");

  const recorder = startRecorder({
    upstream: options.upstream,
    port: 0,
    name: `stream-${options.stream}`,
    match: prompt,
    root,
    out: raw,
  });
  try {
    await (options.agent ?? claudeAgent)({
      prompt,
      cwd: root,
      baseUrl: `http://127.0.0.1:${recorder.port}`,
    });
    await waitForSettled(raw);
  } finally {
    recorder.stop();
  }

  const result = postProcess(readFileSync(raw, "utf8"), { stream: options.stream, root });
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(file, result.content);
  return { file, root, chars: result.chars, turns: result.turns };
}

export interface RecordAllOptions {
  only: number | null;
  dryRun: boolean;
  upstream: string;
  outDir: string;
  force: boolean;
}

export interface Plan {
  stream: number;
  source: string;
  prompt: string;
  upstream: string;
  outDir: string;
}

export function planRecordings(options: RecordAllOptions): Plan[] {
  const streams = options.only === null ? [...RECORDED_STREAMS] : [options.only];
  return streams.map((stream) => ({
    stream,
    source: recordingSource(stream),
    prompt: recordingPrompt(stream),
    upstream: options.upstream,
    outDir: options.outDir,
  }));
}

export function planLines(plan: Plan): string[] {
  const first = plan.prompt.split("\n")[0] ?? "";
  return [
    `stream-${plan.stream}`,
    `  prompt: ${plan.source}, ${plan.prompt.length} chars, starts with "${first.slice(0, 72)}..."`,
    "  arena: <new temp folder>/arena (copy of arena/)",
    `  recorder: bun bench/replay/record.ts --upstream ${plan.upstream} --port 0 --name stream-${plan.stream} --match "<prompt>" --root <temp>/arena --out <temp>/recorded.jsonl`,
    `  agent: claude --setting-sources project --no-session-persistence -p "<prompt>" --model ${RECORDING_MODEL} --max-turns ${RECORDING_MAX_TURNS}`,
    `  output: ${join(plan.outDir, `stream-${plan.stream}.jsonl`)} (cut to ${STREAM_CHARS} characters, refuses to overwrite a recording without --force)`,
  ];
}

export function parseRecordAllArgs(argv: string[]): RecordAllOptions {
  const options: RecordAllOptions = {
    only: null,
    dryRun: false,
    upstream: DEFAULT_UPSTREAM,
    outDir: resolve(SESSIONS_DIR),
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--force") {
      options.force = true;
      continue;
    }
    if (flag !== "--only" && flag !== "--upstream" && flag !== "--out") {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--only") {
      const match = /^stream-([1-5])$/.exec(value);
      if (!match) throw new Error(`--only wants stream-1 to stream-5, got ${value}`);
      options.only = Number(match[1]);
    } else if (flag === "--upstream") {
      options.upstream = value;
    } else {
      options.outDir = resolve(value);
    }
  }
  return options;
}

export function realApiRefusal(options: RecordAllOptions, user: string): string | null {
  if (options.dryRun) return null;
  if (options.upstream !== DEFAULT_UPSTREAM) return null;
  if (user === RECORDING_USER) return null;
  return (
    `refusing to record against ${DEFAULT_UPSTREAM} as ${user}: it calls the real API. ` +
    `Pass --upstream <url>, or run this as ${RECORDING_USER} in the pilot.`
  );
}

if (import.meta.main) {
  let options: RecordAllOptions;
  try {
    options = parseRecordAllArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  }
  const plans = planRecordings(options);
  if (options.dryRun) {
    for (const plan of plans) console.log(planLines(plan).join("\n"));
  } else {
    const user = userInfo().username;
    const refusal = realApiRefusal(options, user);
    if (refusal) {
      console.error(refusal);
      process.exit(2);
    }
    for (const plan of plans) {
      console.log(planLines(plan)[0]);
      try {
        const result = await recordStream({
          stream: plan.stream,
          upstream: plan.upstream,
          outDir: plan.outDir,
          force: options.force,
        });
        console.log(
          `stream-${plan.stream}: ${result.turns} turns, ${result.chars} characters, arena ${result.root}`,
        );
        console.log(`wrote ${result.file}`);
      } catch (error) {
        console.error(`stream-${plan.stream} failed: ${String(error instanceof Error ? error.message : error)}`);
        process.exitCode = 1;
      }
    }
  }
}
