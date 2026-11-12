// The agent finds where things are on one window screenshot, the way a person would: the message box, the area where
// answers appear. The harness then measures there, so an app that moved its composer is still measured right.
import type { Rect } from "../core/contracts.ts";
import type { Ask } from "./eyes.ts";

export interface Wanted {
  name: string;
  description: string;
}

export const COMPOSER: Wanted = {
  name: "composer",
  description:
    "the text box, or the terminal prompt line of an AI agent running in a terminal, where the user types a message to the AI agent (not a search box, not a file list, not a tab title)",
};

export const ANSWERS: Wanted = {
  name: "answers",
  description: "the area where the conversation and the agent's answers are shown, above or around the message box",
};

export function locatePrompt(width: number, height: number, wanted: readonly Wanted[], guide: string): string {
  return [
    `This is a screenshot of one macOS app window, ${width} x ${height} pixels, origin at the top left.`,
    ...(guide.length > 0 ? [`About this app: ${guide}`] : []),
    "Find these elements and give each one's bounding box in screenshot pixels:",
    ...wanted.map((item) => `- "${item.name}": ${item.description}`),
    `Reply with only one JSON object, for example {"${wanted[0]?.name ?? "item"}":{"x":10,"y":20,"w":300,"h":40}}.`,
    "Use null for an element that is not visible. Do not guess an element that is not on screen.",
  ].join("\n");
}

function asRect(value: unknown, width: number, height: number): Rect | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, w, h } = value as Record<string, unknown>;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const rect = { x: Math.round(x as number), y: Math.round(y as number), w: Math.round(w as number), h: Math.round(h as number) };
  if (rect.w < 4 || rect.h < 4 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > width + 2 || rect.y + rect.h > height + 2) return null;
  return rect;
}

export function parseRects(text: string, wanted: readonly Wanted[], width: number, height: number): Record<string, Rect | null> {
  const out: Record<string, Rect | null> = Object.fromEntries(wanted.map((item) => [item.name, null]));
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return out;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    for (const item of wanted) out[item.name] = asRect(raw[item.name], width, height);
  } catch {
    return out;
  }
  return out;
}

export async function locate(
  ask: Ask,
  png: Uint8Array,
  size: { width: number; height: number },
  wanted: readonly Wanted[],
  guide = "",
): Promise<Record<string, Rect | null>> {
  const text = await ask(locatePrompt(size.width, size.height, wanted, guide), png);
  return parseRects(text, wanted, size.width, size.height);
}

/** Screenshot pixels to window points. */
export function toPoints(rect: Rect, scale: number): Rect {
  return { x: Math.round(rect.x / scale), y: Math.round(rect.y / scale), w: Math.round(rect.w / scale), h: Math.round(rect.h / scale) };
}

/** Intersection over union: how much two boxes agree, from 0 to 1. */
export function overlap(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

export function center(rect: Rect): { x: number; y: number } {
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
}
