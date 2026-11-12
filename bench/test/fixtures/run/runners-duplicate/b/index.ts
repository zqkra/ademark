import type { TestRunner } from "../../../../../run/registry.ts";

export const runners: TestRunner[] = [
  {
    id: "A5",
    track: "A",
    repeats: () => 1,
    maxExtraRuns: 0,
    needsExtraRun: () => false,
    runRep: async () => [],
  },
];
