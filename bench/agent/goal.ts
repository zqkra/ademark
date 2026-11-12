// The agent's loop: look at the app window, take one action toward a goal, look again. It sets the stage before a
// measurement and never acts inside a timed window. Every look and action is kept, so a heal is always visible.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext, Point } from "../core/contracts.ts";
import { nativeBinary } from "../core/native.ts";
import { click, paste, pause, press, runTool } from "../adapters/macos.ts";
import { planMessage } from "../adapters/support.ts";
import { defaultDecide, type AgentAction, type Decide } from "./eyes.ts";

export const DEFAULT_MAX_ACTIONS = 8;
const SETTLE_AFTER_ACTION_MS = 900;

/** What the loop needs from the Mac. Real runs use the native helper; tests pass fakes. */
export interface Hands {
  screenshot(pid: number, out: string): Promise<void>;
  click(pid: number, point: Point, count: number): Promise<void>;
  keys(pid: number, combo: string): Promise<void>;
  type(pid: number, text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function nativeHands(ctx: AdapterContext): Hands {
  return {
    screenshot: async (pid, out) => {
      runTool(ctx, [nativeBinary(), "screenshot", "--pid", String(pid), "--out", out]);
    },
    click: async (pid, point, count) => await click(ctx, pid, point, count),
    keys: async (pid, combo) => await press(ctx, pid, combo),
    // Paste, not key events: Diri 0.11.2 reads letters from the key code, so posted Unicode arrives as "aaaa".
    type: async (pid, text) => await paste(ctx, pid, text),
    sleep: async (ms) => await pause(ctx, ms),
  };
}

/** A screenshot, tried 3 times: ScreenCaptureKit sometimes fails once ("audio/video capture failure", 2026-11-07). */
export async function shoot(hands: Hands, pid: number, out: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await hands.screenshot(pid, out);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      await hands.sleep(1000 * attempt);
    }
  }
}

/** Width and height from a PNG header (IHDR follows the 8-byte signature). */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.byteLength < 24 || view.getUint32(12) !== 0x49484452) throw new Error("not a PNG");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface GoalOptions {
  goal: string;
  /** Folder for the looks and the log. */
  dir: string;
  maxActions?: number;
  /** Screenshot pixels per window point: 1 on the reference display. */
  scale?: number;
  decide?: Decide;
  hands?: Hands;
  /** Keys this goal may press although the agent never does otherwise (eyes.ts, ALLOWABLE_KEYS). */
  allowKeys?: readonly string[];
}

export interface GoalResult {
  done: boolean;
  actions: number;
  reason: string;
  log: string;
  /** The actions taken, oldest first, so a working one can become a timed trigger. */
  taken: AgentAction[];
}

function describe(action: AgentAction): string {
  switch (action.action) {
    case "click":
    case "double_click":
      return `${action.action} ${action.x},${action.y}: ${action.reason}`;
    case "keys":
      return `keys ${action.combo}: ${action.reason}`;
    case "type":
      return `type ${JSON.stringify(action.text)}: ${action.reason}`;
    case "wait":
      return `wait ${action.ms} ms: ${action.reason}`;
    default:
      return `${action.action}: ${action.reason}`;
  }
}

async function act(hands: Hands, pid: number, action: AgentAction, scale: number): Promise<void> {
  const point = (x: number, y: number): Point => ({ x: Math.round(x / scale), y: Math.round(y / scale) });
  switch (action.action) {
    case "click":
      return await hands.click(pid, point(action.x, action.y), 1);
    case "double_click":
      return await hands.click(pid, point(action.x, action.y), 2);
    case "keys":
      return await hands.keys(pid, action.combo);
    case "type":
      return await hands.type(pid, action.text);
    case "wait":
      return await hands.sleep(action.ms);
    default:
      return;
  }
}

export function agentEnabled(): boolean {
  return process.env.ADEMARK_AGENT !== "off";
}

export function clearGoal(appName: string): string {
  return [
    `The main ${appName} window is usable: no dialog, sheet, popup, update banner, tour, tip, rating request or`,
    "what's-new panel covers it. If nothing covers it, answer done at once. Close each one you see.",
  ].join(" ");
}

/**
 * After launch, before anything is measured: close what an update, a tour or a tip put over the window. It never
 * throws: a block that still cannot work fails on its own checks, with the agent's looks kept as evidence.
 */
export async function clearBlockers(
  ctx: AdapterContext,
  pid: number,
  appName: string,
  dir: string,
  o: Pick<GoalOptions, "decide" | "hands" | "scale"> = {},
): Promise<GoalResult | null> {
  if (!agentEnabled()) return null;
  try {
    const result = await achieveGoal(ctx, pid, { goal: clearGoal(appName), dir, maxActions: 4, ...o });
    if (!result.done) ctx.log(`agent: ${appName} still covered: ${result.reason}`);
    return result;
  } catch (error) {
    ctx.log(`agent: clear ${appName} skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function achieveGoal(ctx: AdapterContext, pid: number, o: GoalOptions): Promise<GoalResult> {
  const log = join(o.dir, "agent.jsonl");
  if (ctx.dryRun) {
    ctx.log(planMessage("goal", [`pid=${pid}`, `goal=${o.goal}`]));
    return { done: true, actions: 0, reason: "dry run", log, taken: [] };
  }
  mkdirSync(o.dir, { recursive: true });
  const hands = o.hands ?? nativeHands(ctx);
  const decide = o.decide ?? defaultDecide;
  const scale = o.scale ?? 1;
  const maxActions = o.maxActions ?? DEFAULT_MAX_ACTIONS;
  const history: string[] = [];
  const taken: AgentAction[] = [];
  const write = (entry: Record<string, unknown>): void => appendFileSync(log, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  write({ goal: o.goal, pid, maxActions });
  // One look more than the actions: the last look only confirms.
  for (let look = 1; look <= maxActions + 1; look++) {
    const shot = join(o.dir, `look-${String(look).padStart(2, "0")}.png`);
    await shoot(hands, pid, shot);
    const png = new Uint8Array(readFileSync(shot));
    const { width, height } = pngSize(png);
    const started = Date.now();
    const action = await decide({ goal: o.goal, png, width, height, history, allowKeys: o.allowKeys });
    write({ look, shot, width, height, ms: Date.now() - started, action });
    ctx.log(`agent ${look}: ${describe(action)}`);
    if (action.action === "done") return { done: true, actions: history.length, reason: action.reason, log, taken };
    if (action.action === "fail") return { done: false, actions: history.length, reason: action.reason, log, taken };
    if (look > maxActions) break;
    await act(hands, pid, action, scale);
    history.push(describe(action));
    taken.push(action);
    await hands.sleep(SETTLE_AFTER_ACTION_MS);
  }
  return { done: false, actions: history.length, reason: `not done after ${maxActions} actions`, log, taken };
}
