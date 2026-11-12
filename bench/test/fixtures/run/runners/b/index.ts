// Fixture runner for the run-core tests: one valid B1 row per repetition, three repetitions.
import type { TestRunner } from "../../../../../run/registry.ts";

const receipts = { samples: null, video: null, frames: null, capture: null, log: null };

export const runners: TestRunner[] = [
  {
    id: "B1",
    track: "B",
    repeats: () => 3,
    maxExtraRuns: 1,
    needsExtraRun: () => false,
    runRep: async (ctx, rep) => [
      ctx.row({
        test_id: "B1",
        variant: "fresh-input",
        rep,
        server: "live",
        value: 42,
        unit: "tokens",
        duration_ms: 1000,
        valid: true,
        invalid_reason: null,
        receipts,
        notes: "",
      }),
    ],
  },
];
