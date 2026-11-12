// Fixture runner for the run-core tests: one valid C1 row.
import type { TestRunner } from "../../../../../run/registry.ts";

const receipts = { samples: null, video: null, frames: null, capture: null, log: null };

export const runners: TestRunner[] = [
  {
    id: "C1",
    track: "C",
    repeats: () => 1,
    maxExtraRuns: 1,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => [
      ctx.row({
        test_id: "C1",
        variant: "completed",
        rep,
        server: "live",
        value: 1,
        unit: "bool",
        duration_ms: 1000,
        valid: true,
        invalid_reason: null,
        receipts,
        notes: "",
      }),
    ],
  },
];
