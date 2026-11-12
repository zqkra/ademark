// The agent's eyes: one window screenshot and a goal in, one action out. GPT decides through the owner's ChatGPT plan
// (Codex), or GPT-6 Luna through OpenCode Go, so the Claude plan that the measured apps use is never spent here. Setup only: nothing here runs inside a timed window.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const AGENT_MODEL = process.env.ADEMARK_AGENT_MODEL ?? "gpt-6-luna";
const ENDPOINT = "https://opencode.ai/inference/go/openai/v1/responses";
const REQUEST_TIMEOUT_MS = 90_000;

export type AgentAction =
  | { action: "click"; x: number; y: number; reason: string }
  | { action: "double_click"; x: number; y: number; reason: string }
  | { action: "keys"; combo: string; reason: string }
  | { action: "type"; text: string; reason: string }
  | { action: "wait"; ms: number; reason: string }
  | { action: "done"; reason: string }
  | { action: "fail"; reason: string };

export interface Look {
  goal: string;
  png: Uint8Array;
  width: number;
  height: number;
  /** One line per earlier action of this goal, oldest first. */
  history: readonly string[];
  /** Keys this goal may press although the agent never does otherwise (`ALLOWABLE_KEYS`). */
  allowKeys?: readonly string[];
}

// The only forbidden key a goal can ask for. 2026-11-11, Capy 0.7.2: its folder step is a path field that already
// holds the last folder, and a path is typed over it only after select-all. Delete and backspace stay forbidden for
// every goal, so a select-all on the wrong focus still deletes nothing (the Orca case of 2026-11-07 was cmd+a, delete).
export const ALLOWABLE_KEYS: readonly string[] = ["cmd+a"];

export type Decide = (look: Look) => Promise<AgentAction>;

const KEY_NAMES = "a-z, 0-9, enter, tab, escape, space, left, right, up, down";
// Deleting, selecting everything, quitting and closing are never the agent's to do.
const FORBIDDEN_KEYS = /(^|\+)(delete|backspace)$|^cmd\+(a|q|w)$|^cmd\+(shift|alt)\+(q|w)$/;

export function instructions(look: Look): string {
  return [
    "You operate one macOS desktop app through a screenshot of its window, to reach a goal.",
    `The screenshot is the app window only: ${look.width} x ${look.height} pixels, origin at the top left.`,
    "Reply with exactly one JSON object and nothing else. The choices:",
    '{"action":"click","x":0,"y":0,"reason":"..."}',
    '{"action":"double_click","x":0,"y":0,"reason":"..."}',
    `{"action":"keys","combo":"cmd+n","reason":"..."} with modifiers cmd, alt, shift, ctrl and keys ${KEY_NAMES}`,
    '{"action":"type","text":"...","reason":"..."} types into the focused field',
    '{"action":"wait","ms":1000,"reason":"..."} when the app is still loading',
    '{"action":"done","reason":"..."} as soon as the goal is visibly true',
    '{"action":"fail","reason":"..."} when the goal cannot be reached',
    "Rules:",
    "- Never update or install anything, never sign out or sign in, never delete data, never change settings, plans,",
    "  models or permissions unless the goal asks for it.",
    (look.allowKeys ?? []).includes("cmd+a")
      ? "- Never press delete or backspace, never quit the app or close its window. For this goal cmd+a is allowed, in a text field only."
      : "- Never press delete or backspace, never select all, never quit the app or close its window.",
    "- To close a dialog, prefer Escape, then a Close, Not now, Later, Skip or Dismiss button.",
    "- Click the center of the element. If an action did not change the screen, try a different one.",
    `Goal: ${look.goal}`,
    look.history.length === 0 ? "No action taken yet." : `Actions so far:\n${look.history.map((line, i) => `${i + 1}. ${line}`).join("\n")}`,
  ].join("\n");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The model's text to one action. Anything malformed, or a point outside the window, is a fail, never a guess. */
export function parseAction(text: string, width: number, height: number, allowKeys: readonly string[] = []): AgentAction {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return { action: "fail", reason: `no JSON in the answer: ${text.slice(0, 120)}` };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return { action: "fail", reason: `bad JSON: ${match[0].slice(0, 120)}` };
  }
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  switch (raw.action) {
    case "click":
    case "double_click": {
      const { x, y } = raw;
      if (!finite(x) || !finite(y) || x < 0 || y < 0 || x >= width || y >= height) {
        return { action: "fail", reason: `point outside the window: ${JSON.stringify([x, y])}` };
      }
      return { action: raw.action, x: Math.round(x), y: Math.round(y), reason };
    }
    case "keys": {
      if (typeof raw.combo !== "string" || raw.combo.length === 0) return { action: "fail", reason: "keys without a combo" };
      const combo = raw.combo.toLowerCase();
      // 2026-11-07, Orca: the agent pressed cmd+a then delete on a guessed focus. In a file list that trashes files.
      const allowed = allowKeys.includes(combo) && ALLOWABLE_KEYS.includes(combo);
      if (FORBIDDEN_KEYS.test(combo) && !allowed) return { action: "fail", reason: `key not allowed for the agent: ${combo}` };
      return { action: "keys", combo, reason };
    }
    case "type":
      return typeof raw.text === "string" && raw.text.length > 0
        ? { action: "type", text: raw.text, reason }
        : { action: "fail", reason: "type without text" };
    case "wait":
      return { action: "wait", ms: finite(raw.ms) ? Math.min(Math.max(Math.round(raw.ms), 250), 10_000) : 1000, reason };
    case "done":
      return { action: "done", reason };
    case "fail":
      return { action: "fail", reason: reason || "the model gave up" };
    default:
      return { action: "fail", reason: `unknown action ${JSON.stringify(raw.action)}` };
  }
}

/** The OpenCode Go key: an env variable, the measuring account's key file, or the owner's pi login. */
export function agentKey(): string {
  const fromEnv = process.env.ADEMARK_AGENT_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const file = join(homedir(), ".config", "ademark", "opencode-go.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const pi = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(pi)) {
    const key = (JSON.parse(readFileSync(pi, "utf8")) as Record<string, { key?: string }>)["opencode-go"]?.key;
    if (key !== undefined) return key;
  }
  throw new Error(`no OpenCode Go key: set ADEMARK_AGENT_KEY or write ${file}`);
}

interface ResponsesBody {
  output?: Array<{ content?: Array<{ text?: string }> }>;
  error?: unknown;
}

// The agent's own Codex home: the harness restores ~/.codex before every block, which would sign this login out.
export function agentCodexHome(): string {
  return process.env.ADEMARK_AGENT_CODEX_HOME ?? join(homedir(), ".config", "ademark", "codex");
}

const CODEX_TIMEOUT_MS = 120_000;

/** The pinned CLI of the account, not whatever `codex` is first on PATH. */
export function codexBinary(): string {
  if (process.env.ADEMARK_AGENT_CODEX !== undefined) return process.env.ADEMARK_AGENT_CODEX;
  const local = join(homedir(), ".local", "bin", "codex");
  return existsSync(local) ? local : "codex";
}

let brainUsed = "none";
/** Which brain answered last: written next to every rehearsal, so a night that fell back to Luna says so. */
export function lastBrain(): string {
  return brainUsed;
}

/** One question about one screenshot, answered as text. */
export type Ask = (prompt: string, png: Uint8Array) => Promise<string>;

export class BrainError extends Error {}

/** GPT through the owner's ChatGPT plan: `codex exec` with the screenshot, read-only, nothing kept. */
export const codexAsk: Ask = async (prompt, png) => {
  const dir = mkdtempSync(join(tmpdir(), "ademark-agent-"));
  try {
    const image = join(dir, "look.png");
    const out = join(dir, "answer.txt");
    writeFileSync(image, png);
    const home = agentCodexHome();
    const proc = Bun.spawn(
      [
        codexBinary(), "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
        "-c", 'model_reasoning_effort="low"', "-i", image, "-o", out, prompt,
      ],
      {
        cwd: dir,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: CODEX_TIMEOUT_MS,
        env: { ...process.env, ...(existsSync(join(home, "auth.json")) ? { CODEX_HOME: home } : {}) },
      },
    );
    const code = await proc.exited;
    if (code !== 0 || !existsSync(out)) {
      const detail = (await new Response(proc.stderr).text()).trim().split("\n").slice(-2).join(" ");
      throw new BrainError(`codex exit ${code}: ${detail.slice(0, 200)}`);
    }
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** GPT-6 Luna through OpenCode Go. */
export const lunaAsk: Ask = async (prompt, png) => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentKey()}`,
      "content-type": "application/json",
      "x-opencode-session": crypto.randomUUID(),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: AGENT_MODEL,
      reasoning: { effort: "low" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
          ],
        },
      ],
    }),
  });
  const body = (await response.json()) as ResponsesBody;
  if (!response.ok) throw new BrainError(`luna ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return body.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ?? "";
};

/** Codex first (the owner's ChatGPT plan), Luna when Codex cannot answer. ADEMARK_AGENT_BRAIN picks one. */
export const defaultAsk: Ask = async (prompt, png) => {
  const brain = process.env.ADEMARK_AGENT_BRAIN ?? "codex";
  if (brain === "luna") {
    brainUsed = "luna";
    return await lunaAsk(prompt, png);
  }
  try {
    const answer = await codexAsk(prompt, png);
    brainUsed = "codex";
    return answer;
  } catch (error) {
    if (brain === "codex-only") throw error;
    try {
      const answer = await lunaAsk(prompt, png);
      brainUsed = "luna (codex failed)";
      return answer;
    } catch (fallback) {
      throw new BrainError(`${String(error)}; ${String(fallback)}`);
    }
  }
};

export function decideWith(ask: Ask): Decide {
  return async (look) => {
    try {
      return parseAction(await ask(instructions(look), look.png), look.width, look.height, look.allowKeys ?? []);
    } catch (error) {
      return { action: "fail", reason: error instanceof Error ? error.message : String(error) };
    }
  };
}

export const codexDecide = decideWith(codexAsk);
export const lunaDecide = decideWith(lunaAsk);
export const defaultDecide = decideWith(defaultAsk);
