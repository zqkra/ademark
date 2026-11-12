// C6 App Restart: quit and relaunch the ADE mid-task, return to the thread, then Survival (TESTS.md §4, C6).
// The return is the adapter's returnToThread; without it the rows are invalid (shared.ts, restartAndReturn).
import { C6_TASK, faultTestRunner } from "./shared.ts";

export const c6 = faultTestRunner({
  testId: "C6",
  taskId: C6_TASK,
  variants: ["survival", "resumed", "manual-continue"],
  units: { survival: "survival", resumed: "0/1", "manual-continue": "0/1" },
});
