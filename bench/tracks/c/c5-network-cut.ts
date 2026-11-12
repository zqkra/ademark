// C5 Network Cut: the model API hosts blocked for 30 s, then Survival (TESTS.md §4, C5).
import { C5_TASK, faultTestRunner } from "./shared.ts";

export const c5 = faultTestRunner({
  testId: "C5",
  taskId: C5_TASK,
  variants: ["survival", "resumed", "manual-continue"],
  units: { survival: "survival", resumed: "0/1", "manual-continue": "0/1" },
});
