// B1 Hello Tax: tokens and $ the ADE spends on a new thread whose only message is "hi" (TESTS.md §3).
import { loadTask } from "../../core/tasks.ts";
import type { TestRunner } from "../../run/registry.ts";
import { captureFor, captureReceipt, readPrices, runPromptRep, storeRep, tokenRowSet, writeRepNotes } from "./shared.ts";

export const b1HelloTax: TestRunner = {
  id: "B1",
  track: "B",
  repeats: () => 3,
  maxExtraRuns: 1,
  needsExtraRun: (rows) => rows.some((row) => !row.valid),
  runRep: async (ctx, rep) => {
    const task = loadTask("B1-hello");
    const capture = captureFor(ctx);
    const repCapture = await runPromptRep(ctx, task, rep, capture);
    storeRep(ctx, "B1", repCapture);
    const log = writeRepNotes(ctx, "B1", rep, repCapture);
    const receipts = { samples: null, video: null, frames: null, capture: captureReceipt(ctx, capture), log };
    return tokenRowSet(ctx, "B1", rep, repCapture, readPrices(), receipts);
  },
};
