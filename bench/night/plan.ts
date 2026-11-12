// The night's plan: how many minutes each track costs per ADE, the next occurrence of --until, and the printed plan.
import type { TrackLetter } from "../run/registry.ts";
import type { SkippedAde } from "./select.ts";

/** ADEMARK-20: the owner's estimate, used only for the expected end time. */
export const MINUTES_PER_ADE: Record<TrackLetter, number> = { A: 25, B: 7, C: 60 };

export const UNTIL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function estimateMinutes(count: number, tracks: readonly TrackLetter[]): number {
  let perAde = 0;
  for (const track of tracks) {
    perAde += MINUTES_PER_ADE[track];
  }
  return count * perAde;
}

/** The next local occurrence of `HH:MM`, today or tomorrow, as epoch ms. */
export function nextDeadline(until: string, now: number): number {
  const match = UNTIL_TIME.exec(until);
  if (match === null) throw new Error(`--until must be a HH:MM local time, got "${until}"`);
  const date = new Date(now);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-10-21 07:30`, in the local time of the machine running the night. */
export function formatLocal(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export interface PlanInput {
  order: readonly string[];
  skipped: readonly SkippedAde[];
  tracks: readonly TrackLetter[];
  now: number;
}

export function formatPlan(input: PlanInput): string {
  const minutes = estimateMinutes(input.order.length, input.tracks);
  const perTrack = input.tracks.map((track) => `${MINUTES_PER_ADE[track]} min per ADE for Track ${track}`);
  const lines: string[] = [
    `plan: ${input.order.length} ADE(s) chosen, ${input.skipped.length} skipped`,
    `chosen, in run order: ${input.order.length === 0 ? "none" : input.order.join(", ")}`,
  ];
  if (input.skipped.length > 0) {
    lines.push("skipped:");
    for (const skip of input.skipped) lines.push(`  ${skip.ade}: ${skip.reason}`);
  }
  lines.push(
    `estimate: ${minutes} min (${perTrack.join(", ")}; retries are not included)`,
    `expected end: ${formatLocal(input.now + minutes * 60_000)} (local)`,
  );
  return lines.join("\n");
}
