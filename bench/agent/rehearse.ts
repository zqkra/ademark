// Before an app is measured, the agent rehearses like a person: it clears what covers the window, finds the message
// box, types a probe there and reads it back, clears it, and checks that "new thread" really opens one. When the app's
// script is wrong, the agent finds what works, and the stopwatch then repeats exactly that action. The agent never
// acts while the stopwatch runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext, Point, Rect, Trigger } from "../core/contracts.ts";
import { decideWith, defaultAsk, type Ask } from "./eyes.ts";
import { achieveGoal, clearGoal, pngSize, shoot, type Hands } from "./goal.ts";
import { ANSWERS, COMPOSER, center, locate, overlap, toPoints } from "./locate.ts";

// Vision reads real-looking words and drops strings like "zqxj7"; the native self-test reads this one.
export const PROBE = "LEDGERMARK";

/** Read when the first 7 letters show: the text cursor often hides the last one ("LEDGERMAR" on Synara). */
export function readsProbe(lines: readonly string[]): boolean {
  return lines.join(" ").toUpperCase().replace(/[^A-Z]/g, "").includes(PROBE.slice(0, 7));
}
const AFTER_TRIGGER_MS = 2500;
const AGREE = 0.3;

export interface RehearsalHands extends Hands {
  /** OCR lines in a region of a screenshot, in screenshot pixels. */
  ocr(image: string, region: Rect): Promise<string[]>;
}

export interface RehearsalInput {
  pid: number;
  appName: string;
  guide: string;
  dir: string;
  /** Screenshot pixels per window point. */
  scale: number;
  composerRect: Rect | null;
  threadRect: Rect | null;
  clearKeys: string[];
  newThread: Trigger[] | null;
  ask?: Ask;
  hands: RehearsalHands;
}

export interface Rehearsal {
  cleared: boolean;
  composerRect: Rect | null;
  focusClick: Point | null;
  threadRect: Rect | null;
  composerSource: "profile" | "agent" | "none";
  typingWorks: boolean;
  newThread: Trigger[] | null;
  newThreadSource: "profile" | "agent" | "failed" | "skipped";
  /** The probe could not be cleared from the composer: the block must not measure. */
  probeLeft: boolean;
  notes: string[];
}

export function judgePrompt(question: string, guide: string): string {
  return [
    "This is a screenshot of one macOS app window.",
    ...(guide.length > 0 ? [`About this app: ${guide}`] : []),
    `Question: ${question}`,
    'Reply with only {"answer":true,"reason":"..."} or {"answer":false,"reason":"..."}.',
  ].join("\n");
}

export function parseJudge(text: string): { answer: boolean; reason: string } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return { answer: false, reason: `no JSON: ${text.slice(0, 80)}` };
  try {
    const raw = JSON.parse(match[0]) as { answer?: unknown; reason?: unknown };
    return { answer: raw.answer === true, reason: typeof raw.reason === "string" ? raw.reason : "" };
  } catch {
    return { answer: false, reason: "bad JSON" };
  }
}

/** The last click or key combo of a goal, as a trigger the stopwatch can repeat. Typing never becomes a trigger. */
export function triggerFrom(action: { action: string; x?: number; y?: number; combo?: string }, scale: number): Trigger | null {
  if ((action.action === "click" || action.action === "double_click") && action.x !== undefined && action.y !== undefined) {
    return { kind: "click", point: { x: Math.round(action.x / scale), y: Math.round(action.y / scale) } };
  }
  if (action.action === "keys" && action.combo !== undefined) return { kind: "keys", combo: action.combo };
  return null;
}

// The composer in screenshot pixels, with a margin: a tight 32 pt box clips the line Vision has to read.
function readRegion(rect: Rect, scale: number, width: number, height: number): Rect {
  const pad = 16;
  const x = Math.max(0, (rect.x - pad) * scale);
  const y = Math.max(0, (rect.y - pad) * scale);
  return { x, y, w: Math.min(width - x, (rect.w + 2 * pad) * scale), h: Math.min(height - y, (rect.h + 2 * pad) * scale) };
}

export async function rehearse(ctx: AdapterContext, input: RehearsalInput): Promise<Rehearsal> {
  const { hands, pid, scale } = input;
  const ask = input.ask ?? defaultAsk;
  mkdirSync(input.dir, { recursive: true });
  const notes: string[] = [];
  let shots = 0;
  const look = async (tag: string): Promise<{ path: string; png: Uint8Array }> => {
    shots += 1;
    const path = join(input.dir, `rehearse-${String(shots).padStart(2, "0")}-${tag}.png`);
    await shoot(hands, pid, path);
    return { path, png: new Uint8Array(readFileSync(path)) };
  };
  const judge = async (question: string, tag: string): Promise<{ answer: boolean; reason: string }> => {
    const shot = await look(tag);
    return parseJudge(await ask(judgePrompt(question, input.guide), shot.png));
  };
  const goal = async (text: string, label: string, maxActions: number) =>
    await achieveGoal(ctx, pid, { goal: text, dir: join(input.dir, label), maxActions, scale, decide: decideWith(ask), hands });

  // 1. Nothing covers the window.
  const cleared = (await goal(clearGoal(input.appName), "clear", 6)).done;
  if (!cleared) notes.push("something may still cover the window");

  // 2. Where is the message box?
  let first = await look("locate");
  const size = pngSize(first.png);
  let found = await locate(ask, first.png, size, [COMPOSER, ANSWERS], input.guide);
  if (found.composer === null) {
    notes.push("no message box seen; the agent tries to show one");
    await goal(`Show the place where the user types a message to the AI agent in the current project. Do not type anything. ${input.guide}`, "show-composer", 4);
    first = await look("locate-again");
    found = await locate(ask, first.png, size, [COMPOSER, ANSWERS], input.guide);
  }
  const agentComposer = found.composer === null ? null : toPoints(found.composer, scale);
  const agentAnswers = found.answers === null ? null : toPoints(found.answers, scale);
  // Only a box the agent can see is typed into: a guessed position once landed on Orca's sidebar.
  let composerRect: Rect | null = null;
  let composerSource: Rehearsal["composerSource"] = "none";
  if (agentComposer !== null && input.composerRect !== null && overlap(input.composerRect, agentComposer) >= AGREE) {
    composerRect = input.composerRect;
    composerSource = "profile";
  } else if (agentComposer !== null) {
    if (input.composerRect !== null) notes.push(`composer moved: profile ${JSON.stringify(input.composerRect)}, agent ${JSON.stringify(agentComposer)}`);
    composerRect = agentComposer;
    composerSource = "agent";
  } else {
    notes.push("no message box found: nothing typed");
  }
  const threadRect = input.threadRect ?? agentAnswers;

  // 3. Typing reaches it: click, type a probe, read it back, clear it, read again.
  let typingWorks = false;
  let probeLeft = false;
  if (composerRect !== null) {
    const focus = center(composerRect);
    for (let attempt = 1; attempt <= 2 && !typingWorks; attempt++) {
      await hands.click(pid, focus, 1);
      await hands.sleep(300);
      await hands.type(pid, PROBE);
      await hands.sleep(600);
      const typed = await look(`typed-${attempt}`);
      const lines = await hands.ocr(typed.path, readRegion(composerRect, scale, size.width, size.height));
      typingWorks = readsProbe(lines);
      for (const combo of input.clearKeys) await hands.keys(pid, combo);
      await hands.sleep(400);
      if (!typingWorks && attempt === 1) {
        notes.push(`probe not read in the composer: ${JSON.stringify(lines).slice(0, 120)}`);
        await goal("The text cursor is in the message box where the user types to the AI agent. Click into it; do not delete anything.", "focus", 3);
      }
    }
    // A probe left in the box would ride along with the next prompt and change what is measured.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const left = await look(`cleared-${attempt}`);
      probeLeft = readsProbe(await hands.ocr(left.path, readRegion(composerRect, scale, size.width, size.height)));
      if (!probeLeft) break;
      for (const combo of input.clearKeys) await hands.keys(pid, combo);
      await hands.sleep(400);
    }
    if (probeLeft) notes.push("the probe is still in the composer after clearing");
  }

  // 4. "New thread" really opens a new one. The oracle needs no model: a probe left as a draft in the current thread
  // must be gone from the window once a new thread opens. A screen that only looks empty cannot fool it.
  let newThread = input.newThread;
  let newThreadSource: Rehearsal["newThreadSource"] = newThread === null ? "skipped" : "profile";
  let drafted = false;
  const probeGone = async (triggers: readonly Trigger[], tag: string): Promise<boolean | null> => {
    if (composerRect === null) return null;
    await hands.click(pid, center(composerRect), 1);
    await hands.sleep(300);
    drafted = true;
    await hands.type(pid, PROBE);
    await hands.sleep(600);
    const before = await look(`${tag}-draft`);
    if (!readsProbe(await hands.ocr(before.path, { x: 0, y: 0, w: size.width, h: size.height }))) return null;
    for (const trigger of triggers) {
      if (trigger.kind === "keys") await hands.keys(pid, trigger.combo);
      else if (trigger.kind === "click") await hands.click(pid, trigger.point, 1);
      else if (trigger.kind === "wait") await hands.sleep(trigger.ms);
      else if (trigger.kind === "enter") await hands.keys(pid, "enter");
    }
    await hands.sleep(AFTER_TRIGGER_MS);
    const after = await look(`${tag}-after`);
    return !readsProbe(await hands.ocr(after.path, { x: 0, y: 0, w: size.width, h: size.height }));
  };
  const isAgentThread = async (tag: string) =>
    await judge(
      "Is this a new conversation with the AI coding agent, with an empty place to type the first message to it? A plain shell prompt, a settings page or a file view is not.",
      tag,
    );
  if (newThread !== null && typingWorks) {
    const gone = await probeGone(newThread, "new-thread");
    const works = gone === true ? (await isAgentThread("new-thread-check")).answer : gone;
    if (works === false) {
      notes.push("new thread by script did not open a new conversation with the agent");
      const result = await goal(
        `Open a new, empty conversation with the AI coding agent in the current project, so its message box is empty (the word ${PROBE} must not be in it). A plain shell terminal is not a conversation with the agent. Do not delete text to empty it. ${input.guide}`,
        "new-thread",
        6,
      );
      // Only a single click or shortcut becomes a timed trigger. A path of several steps would need waits between
      // them, and every wait would count inside the stopwatch (council, 2026-11-07).
      const steps = result.taken.map((action) => triggerFrom(action, scale)).filter((trigger) => trigger !== null);
      const learned: Trigger[] | null = result.done && steps.length === 1 ? [steps[0]!] : null;
      if (result.done && steps.length > 1) notes.push(`the agent needed ${steps.length} steps for a new thread; not used for timing`);
      // What the agent did once must work again before the stopwatch relies on it, and lead to the agent, not a shell.
      if (learned !== null && (await probeGone(learned, "learned")) === true && (await isAgentThread("learned-check")).answer) {
        newThread = learned;
        newThreadSource = "agent";
      } else {
        newThreadSource = "failed";
        notes.push(`the agent found no repeatable new-thread action: ${result.reason}`);
      }
    } else if (works === null) {
      notes.push("new thread not checked: the draft was not read");
    }
  }
  // 2026-11-08, Conductor (rehearse-06-new-thread-check.png): the check left the new-workspace modal open and LEDGERMARK
  // in the composer behind it, and the seed's cmd+n, paste and Enter ran on that state, so no seed reached the model.
  // Escape closes what the trigger opened, then the draft is cleared and read again.
  if (drafted && composerRect !== null) {
    await hands.keys(pid, "escape");
    await hands.sleep(400);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await hands.click(pid, center(composerRect), 1);
      await hands.sleep(300);
      for (const combo of input.clearKeys) await hands.keys(pid, combo);
      await hands.sleep(400);
      const left = await look(`new-thread-cleared-${attempt}`);
      probeLeft = readsProbe(await hands.ocr(left.path, { x: 0, y: 0, w: size.width, h: size.height }));
      if (!probeLeft) break;
    }
    if (probeLeft) notes.push("the new-thread draft is still on screen after Escape and clearing");
  }

  const rehearsal: Rehearsal = {
    cleared,
    composerRect,
    focusClick: composerRect === null ? null : center(composerRect),
    threadRect,
    composerSource,
    typingWorks,
    newThread,
    newThreadSource,
    probeLeft,
    notes,
  };
  writeFileSync(join(input.dir, "rehearsal.json"), `${JSON.stringify({ found, ...rehearsal }, null, 2)}\n`);
  ctx.log(`rehearsal ${input.appName}: composer ${composerSource}, typing ${typingWorks ? "ok" : "not read"}, new thread ${newThreadSource}`);
  return rehearsal;
}
