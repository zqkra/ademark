// Fixture runner in a folder whose name is not a track letter: the registry loads every folder.
import type { TestRunner } from "../../../../../run/registry.ts";

export const runners: TestRunner[] = [
  {
    id: "B1",
    track: "B",
    repeats: () => 1,
    maxExtraRuns: 1,
    needsExtraRun: () => false,
    runRep: async () => [],
  },
];
