// Runs the steps of an ADE profile (bench/core/contracts.ts, ProfileStep) through the macOS helpers.
// Untimed setup only: the echo timer executes `timed` triggers for timing.
import type { AdapterContext, ProfileStep } from "../core/contracts.ts";
import { join } from "node:path";
import { achieveGoal } from "../agent/goal.ts";
import { withoutAgentSession } from "../core/env.ts";
import {
  click,
  isRealRun,
  openBundle,
  paste,
  pause,
  press,
  runTool,
  typeText,
  utcStamp,
  waitForText,
} from "./macos.ts";
import { planMessage } from "./support.ts";

export interface StepVars {
  worktree: string;
  home: string;
  model: string | null;
  effort: string | null;
  agent: string;
}

const PLACEHOLDER = /\$\{(worktree|home|model|effort|agent)\}/g;

function placeholderValue(name: string, vars: StepVars): string {
  if (name === "worktree") return vars.worktree;
  if (name === "home") return vars.home;
  if (name === "agent") return vars.agent;
  const value = name === "model" ? vars.model : vars.effort;
  if (value === null) throw new Error(`\${${name}} is not set`);
  return value;
}

export function replacePlaceholders(text: string, vars: StepVars): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => placeholderValue(name, vars));
}

function expand(value: unknown, vars: StepVars): unknown {
  if (typeof value === "string") return replacePlaceholders(value, vars);
  if (Array.isArray(value)) return value.map((item) => expand(item, vars));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = expand(item, vars);
    return out;
  }
  return value;
}

function runCommand(ctx: AdapterContext, argv: string[], timeoutMs: number): void {
  if (ctx.dryRun) {
    ctx.log(planMessage("run", [...argv, `timeoutMs=${timeoutMs}`]));
    return;
  }
  isRealRun(ctx);
  const result = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    env: withoutAgentSession(),
  });
  if (result.exitCode === null) throw new Error(`${argv.join(" ")} timed out after ${timeoutMs} ms`);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim() || "no output";
    throw new Error(`${argv.join(" ")} failed (exit ${result.exitCode}): ${detail}`);
  }
}

async function runStep(ctx: AdapterContext, pid: number, step: ProfileStep): Promise<void> {
  switch (step.kind) {
    case "keys":
      await press(ctx, pid, step.combo);
      return;
    case "type":
      await typeText(ctx, pid, step.text);
      return;
    case "enter":
      await press(ctx, pid, "enter");
      return;
    case "click":
      await click(ctx, pid, step.point);
      return;
    case "wait":
      await pause(ctx, step.ms);
      return;
    case "open":
      if (step.bundleId !== undefined) openBundle(ctx, step.bundleId);
      else if (step.appPath !== undefined) runTool(ctx, ["open", step.appPath, ...(step.args ?? [])]);
      else throw new Error("open needs a bundleId or an appPath");
      return;
    case "paste":
      await paste(ctx, pid, step.text);
      return;
    case "expectText":
      await waitForText(ctx, pid, step.region, step.texts ?? step.text, step.timeoutMs / 1000);
      return;
    case "clickIfText":
      await clickIfText(ctx, pid, step);
      return;
    case "run":
      runCommand(ctx, step.argv, step.timeoutMs);
      return;
    case "goal": {
      const result = await achieveGoal(ctx, pid, { goal: step.goal, dir: agentDir(ctx, "goal"), maxActions: step.maxActions, allowKeys: step.allowKeys });
      if (!result.done) throw new Error(`goal not reached: ${result.reason} (${result.log})`);
      return;
    }
  }
}

type ClickIfText = Extract<ProfileStep, { kind: "clickIfText" }>;

// Time for a closed banner to leave the screen before confirmGone reads the region again.
const CONFIRM_GONE_SETTLE_MS = 1000;

// A dry run cannot read the screen, so it plans the read and the click as one line and clicks nothing.
async function clickIfText(ctx: AdapterContext, pid: number, step: ClickIfText): Promise<void> {
  const { region, point, texts } = step;
  const where = `region=${region.x},${region.y},${region.w},${region.h}`;
  const at = `at=${point.x},${point.y}`;
  if (ctx.dryRun) {
    const args = [`pid=${pid}`, `texts=${texts.join("|")}`, where, at, `timeoutMs=${step.timeoutMs}`];
    if (step.confirmGone === true) args.push("confirmGone");
    ctx.log(planMessage("clickIfText", args));
    return;
  }
  const seconds = step.timeoutMs / 1000;
  if (!(await waitForText(ctx, pid, region, texts, seconds, { optional: true }))) {
    ctx.log(`clickIfText: none of ${texts.join(" | ")} read in ${where} within ${seconds} s; no click`);
    return;
  }
  ctx.log(`clickIfText: read one of ${texts.join(" | ")} in ${where}; click ${at}`);
  await click(ctx, pid, point);
  if (step.confirmGone !== true) return;
  await pause(ctx, CONFIRM_GONE_SETTLE_MS);
  if (await waitForText(ctx, pid, region, texts, seconds, { optional: true })) {
    ctx.log(`clickIfText: one of ${texts.join(" | ")} is still read in ${where} after the click at ${point.x},${point.y}; it did not close (no second click)`);
  } else {
    ctx.log(`clickIfText: ${where} shows none of the texts after the click; it closed`);
  }
}

let agentRuns = 0;

// One folder per agent run inside the run, so every look and action of a heal is a receipt.
export function agentDir(ctx: AdapterContext, label: string): string {
  agentRuns += 1;
  return join(ctx.runDir, "agent", `${utcStamp(Date.now())}-${String(agentRuns).padStart(3, "0")}-${label}`);
}

// `label` names the list in the error, so the night log says exactly which step broke.
export async function runSteps(
  ctx: AdapterContext,
  pid: number,
  steps: readonly ProfileStep[],
  vars: StepVars,
  label = "steps",
): Promise<void> {
  for (const [index, raw] of steps.entries()) {
    const kind = raw.kind;
    try {
      const step = expand(raw, vars) as ProfileStep;
      await runStep(ctx, pid, step);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`step ${label}[${index}] (${kind}): ${reason}`);
    }
  }
}
