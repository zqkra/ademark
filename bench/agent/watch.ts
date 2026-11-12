// Between repetitions, never inside one: the agent looks at the app like a person would and puts it right before the
// next repetition, and after a failed one it repairs what it sees so the repetition can run again. While a repetition
// runs, the agent is not running at all, so its screenshots and its thinking never land in a measurement.
import { join } from "node:path";
import type { TestId } from "../core/contracts.ts";
import { mainPid } from "../adapters/macos.ts";
import type { TestContext } from "../run/context.ts";
import type { Decide } from "./eyes.ts";
import { achieveGoal, agentEnabled, clearGoal, type Hands } from "./goal.ts";

// The app is quit inside these repetitions, so there is no window to look at before them.
const QUIT_INSIDE = new Set<TestId>(["A1", "A2", "A9"]);
// One look per test before its first repetition, then only after a failure: a look costs about 5 s.
const RECOVER_ACTIONS = 5;

export interface RepWatch {
  before(testId: TestId, rep: number): Promise<void>;
  /** After a failed repetition. True when the agent changed something, so one more repetition is worth it. */
  recover(testId: TestId, rep: number, reason: string): Promise<boolean>;
}

export interface RepWatchOptions {
  pidOf?: () => Promise<number | null>;
  decide?: Decide;
  hands?: Hands;
}

export function recoverGoal(appName: string, reason: string): string {
  return [
    `The last measurement in ${appName} failed (${reason}).`,
    `Put ${appName} back in a normal state like a person would: its main window shows the current project's conversation`,
    "with the AI agent, nothing covers it (no dialog, popup, menu or banner), and the message box is visible.",
    "Do not send any message, do not type into the message box, and answer done as soon as this is true.",
  ].join(" ");
}

export function repWatch(ctx: TestContext, o: RepWatchOptions = {}): RepWatch | null {
  if (!agentEnabled() || ctx.adapterCtx.dryRun) return null;
  const appName = ctx.adapter.calibration.appName;
  const pidOf = o.pidOf ?? (async () => await mainPid(ctx.adapterCtx, { bundlePaths: ctx.adapter.processes().bundlePaths }));
  const looked = new Set<TestId>();
  let runs = 0;
  const dir = (testId: TestId, rep: number, label: string): string => {
    runs += 1;
    return join(ctx.runDir, ctx.rowAde, "agent", `${testId}-rep-${String(rep).padStart(2, "0")}-${String(runs).padStart(3, "0")}-${label}`);
  };
  const run = async (testId: TestId, rep: number, label: string, goal: string, maxActions: number) => {
    const pid = await pidOf().catch(() => null);
    if (pid === null) return null;
    try {
      return await achieveGoal(ctx.adapterCtx, pid, { goal, dir: dir(testId, rep, label), maxActions, decide: o.decide, hands: o.hands });
    } catch (error) {
      ctx.log(`agent ${testId} rep ${rep} ${label} skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  return {
    async before(testId, rep) {
      if (QUIT_INSIDE.has(testId) || looked.has(testId)) return;
      looked.add(testId);
      await run(testId, rep, "before", clearGoal(appName), 4);
    },
    async recover(testId, rep, reason) {
      const result = await run(testId, rep, "recover", recoverGoal(appName, reason), RECOVER_ACTIONS);
      if (result === null) return false;
      ctx.log(`agent recover ${testId} rep ${rep}: ${result.done ? "done" : "not done"} after ${result.actions} actions: ${result.reason}`);
      return result.done && result.actions > 0;
    },
  };
}
