// B3 Real Prompt Tax: the B1 split for one read-only real prompt, plus request and tool-call counts (TESTS.md §3).
import { loadTask } from "../../core/tasks.ts";
import type { ResultRow } from "../../core/contracts.ts";
import { invalidRow } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import {
  captureFor,
  captureReceipt,
  noteLine,
  readPrices,
  repProblem,
  runPromptRep,
  storeRep,
  tokenRowSet,
  writeRepNotes,
} from "./shared.ts";

export const b3RealPromptTax: TestRunner = {
  id: "B3",
  track: "B",
  repeats: () => 1,
  maxExtraRuns: 0,
  needsExtraRun: () => false,
  runRep: async (ctx, rep) => {
    const task = loadTask("B3-real-prompt");
    const capture = captureFor(ctx);
    const repCapture = await runPromptRep(ctx, task, rep, capture);
    storeRep(ctx, "B3", repCapture);
    const log = writeRepNotes(ctx, "B3", rep, repCapture);
    const receipts = { samples: null, video: null, frames: null, capture: captureReceipt(ctx, capture), log };
    const rows: ResultRow[] = tokenRowSet(ctx, "B3", rep, repCapture, readPrices(), receipts);
    const notes = noteLine(repCapture.notes);
    const base = {
      test_id: "B3" as const,
      rep,
      server: "live" as const,
      unit: "count",
      duration_ms: repCapture.durationMs,
      receipts,
      notes,
    };
    // No captured request is never a zero, for the counts either (TESTS.md B1/B3 validity).
    const empty = repCapture.main.length === 0;
    const problem = repProblem(repCapture);
    const requestsProblem = problem ?? (empty ? "no main-thread request captured" : null);
    // The tool count comes only from the session log. Without it the count is unknown, and a valid null counted as
    // measured (Conductor B3, 2026-11-07).
    const toolsProblem =
      problem ??
      (empty && repCapture.logUsage === null ? "no main-thread request captured" : repCapture.toolCalls === null ? "no session log" : null);
    rows.push(
      requestsProblem !== null
        ? invalidRow(ctx, { ...base, variant: "requests" }, requestsProblem)
        : ctx.row({ ...base, variant: "requests", value: repCapture.main.length, valid: true, invalid_reason: null }),
    );
    rows.push(
      toolsProblem !== null
        ? invalidRow(ctx, { ...base, variant: "tool-calls" }, toolsProblem)
        : ctx.row({ ...base, variant: "tool-calls", value: repCapture.toolCalls, valid: true, invalid_reason: null }),
    );
    return rows;
  },
};
