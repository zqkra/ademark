// The rehearsal inside a real block: once per app and run, after launch and before any test. What the agent finds
// replaces the profile's positions in memory for this run only, and every change is written to the run folder.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext, AdeProfile, Trigger } from "../core/contracts.ts";
import { ocr } from "../core/native.ts";
import { lastBrain } from "./eyes.ts";
import { agentEnabled, nativeHands } from "./goal.ts";
import { rehearse, type Rehearsal, type RehearsalHands } from "./rehearse.ts";

export function describeTriggers(triggers: readonly Trigger[]): string {
  return triggers
    .filter((trigger) => trigger.kind !== "wait")
    .map((trigger) => {
      if (trigger.kind === "keys") return `the shortcut ${trigger.combo}`;
      if (trigger.kind === "click") return `a click at ${trigger.point.x},${trigger.point.y}`;
      if (trigger.kind === "enter") return "Enter";
      if (trigger.kind === "type") return `typing ${JSON.stringify(trigger.text)}`;
      return trigger.kind;
    })
    .join(", then ");
}

/** What the agent is told about an app: its name and what its script does, so it starts from what worked before. */
export function guideFor(profile: AdeProfile): string {
  const parts = [`${profile.calibration.appName} is a macOS desktop app where AI coding agents (Claude Code) work in threads.`];
  if (profile.timed.newThread.length > 0) parts.push(`Its script opens a new thread with ${describeTriggers(profile.timed.newThread)}.`);
  if (profile.agentGuide !== undefined) parts.push(profile.agentGuide);
  return parts.join(" ");
}

export function nativeRehearsalHands(ctx: AdapterContext): RehearsalHands {
  return {
    ...nativeHands(ctx),
    ocr: async (image, region) => (await ocr({ image, region })).lines,
  };
}

/** Runs the rehearsal and applies it to the in-memory profile. Returns null when the agent is off or the run is dry. */
export async function stageProfile(
  ctx: AdapterContext,
  pid: number,
  profile: AdeProfile,
  dir: string,
  hands: RehearsalHands = nativeRehearsalHands(ctx),
): Promise<Rehearsal | null> {
  if (!agentEnabled() || ctx.dryRun) return null;
  let rehearsal: Rehearsal;
  try {
    rehearsal = await rehearse(ctx, {
      pid,
      appName: profile.calibration.appName,
      guide: guideFor(profile),
      dir,
      // launch() resizes the window to profile.window before this runs; the reference display is 1x.
      scale: 1,
      composerRect: profile.calibration.composerRect,
      threadRect: profile.calibration.threadRect,
      clearKeys: profile.calibration.clearKeys ?? ["cmd+a", "delete"],
      // 2026-11-08: the draft oracle said "failed" for apps whose new thread works (the old thread's draft stays visible
      // in a sidebar or title), and the agent's attempts left Synara and Claude desktop in a state where seeding failed.
      // Off unless ADEMARK_AGENT_NEWTHREAD=on.
      newThread: process.env.ADEMARK_AGENT_NEWTHREAD === "on" && profile.timed.newThread.length > 0 ? profile.timed.newThread : null,
      hands,
    });
  } catch (error) {
    ctx.log(`rehearsal ${profile.calibration.appName} skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (rehearsal.probeLeft) throw new Error(`rehearsal left its probe in the ${profile.calibration.appName} composer`);
  const changes: string[] = [];
  // The agent's box replaces the profile's only when a typed probe was read back in it.
  if (rehearsal.composerSource === "agent" && rehearsal.composerRect !== null && rehearsal.typingWorks) {
    profile.calibration.composerRect = rehearsal.composerRect;
    profile.calibration.focusClick = rehearsal.focusClick;
    changes.push(`composerRect ${JSON.stringify(rehearsal.composerRect)}`);
  }
  if (rehearsal.newThreadSource === "agent" && rehearsal.newThread !== null) {
    profile.timed.newThread = rehearsal.newThread;
    changes.push(`timed.newThread ${JSON.stringify(rehearsal.newThread)}`);
  }
  writeFileSync(join(dir, "applied.json"), `${JSON.stringify({ brain: lastBrain(), changes, notes: rehearsal.notes }, null, 2)}\n`);
  if (changes.length > 0) ctx.log(`agent changed for this run: ${changes.join("; ")}`);
  return rehearsal;
}
