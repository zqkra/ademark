// C4 Agent Killed: kill -9 on the agent process of the thread, then Survival (TESTS.md §4, C4).
import { C4_TASK, faultTestRunner } from "./shared.ts";

export const c4 = faultTestRunner({
  testId: "C4",
  taskId: C4_TASK,
  variants: ["survival", "resumed", "manual-continue"],
  units: { survival: "survival", resumed: "0/1", "manual-continue": "0/1" },
});
