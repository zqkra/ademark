// Fixture runner for the retry check: one row and one receipt per repetition, and the first block of each row ade
// stops after rep 1, so the end-of-run retry pass has a stopped block with rows and receipts to supersede.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultRow } from "../../../../../core/contracts.ts";
import type { TestRunner } from "../../../../../run/registry.ts";

const receipts = { samples: null, video: null, frames: null, capture: null, log: null };
const failed = new Set<string>();

export const runners: TestRunner[] = [
  {
    id: "A5",
    track: "A",
    repeats: () => 2,
    maxExtraRuns: 0,
    needsExtraRun: () => false,
    runRep: async (ctx, rep): Promise<ResultRow[]> => {
      writeFileSync(join(ctx.receiptDir("A5", rep), "note.md"), `rep ${rep}\n`);
      if (rep === 2 && !failed.has(ctx.rowAde)) {
        failed.add(ctx.rowAde);
        throw new Error("fixture stop");
      }
      return [
        ctx.row({
          test_id: "A5",
          variant: "",
          rep,
          server: "replay",
          value: 300,
          unit: "MB",
          duration_ms: 1000,
          valid: true,
          invalid_reason: null,
          receipts,
          notes: "",
        }),
      ];
    },
  },
];
