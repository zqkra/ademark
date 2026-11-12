// Fixture runner for the run-core tests: one valid A5 row per repetition, three repetitions.
import type { TestRunner } from "../../../../../run/registry.ts";

const receipts = { samples: null, video: null, frames: null, capture: null, log: null };

export const runners: TestRunner[] = [
  {
    id: "A5",
    track: "A",
    repeats: () => 3,
    maxExtraRuns: 1,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => [
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
    ],
  },
];
