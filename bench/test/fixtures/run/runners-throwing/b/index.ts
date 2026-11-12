// Fixture runner that throws, for the failure path of the run loop.
import type { TestRunner } from "../../../../../run/registry.ts";

export const runners: TestRunner[] = [
  {
    id: "B1",
    track: "B",
    repeats: () => 3,
    maxExtraRuns: 1,
    needsExtraRun: () => false,
    runRep: async () => {
      throw new Error("boom");
    },
  },
];
