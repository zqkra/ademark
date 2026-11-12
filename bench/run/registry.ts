// The TestRunner contract and its registry; wave 2b adds bench/tracks/<folder>/index.ts.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResultRow, TestId } from "../core/contracts.ts";
import { benchRoot } from "../core/paths.ts";
import type { TestContext } from "./context.ts";

export type TrackLetter = "A" | "B" | "C";

export interface AdaptiveRuns {
  /** The row variant the stop rule follows: A1 `cold`, A2 `relaunch`, A3 `default-mode`, A4 `total`. */
  variant: string;
  /** Valid rows of `variant` before the stop rule may fire (TESTS.md §1.3: at least 6). */
  min: number;
  /** Absolute half-width tolerance, in the unit of the rows (seconds for A1 and A2, ms for A3 and A4). */
  absTol: number;
}

export interface TestRunner {
  id: TestId;
  track: TrackLetter;
  /** Runs per TESTS.md, before any extra run. */
  repeats(ctx: TestContext): number;
  /** 3 for A1-A4, 1 for A5-A11, 1 for C1 and C4-C6, 0 otherwise. */
  maxExtraRuns: number;
  /** A1-A4 stop between `min` and `repeats()` when the median is stable (TESTS.md §1.3). */
  adaptive?: AdaptiveRuns;
  /** Repetitions in a smoke run, 1 by default. A test whose second repetition depends on the first needs 2. */
  smokeRepeats?: number;
  /** True when the written rows need one more run, for example on any invalid row. */
  needsExtraRun(rows: ResultRow[]): boolean;
  runRep(ctx: TestContext, rep: number): Promise<ResultRow[]>;
}

export const TRACK_ORDER: Record<TrackLetter, TestId[]> = {
  A: ["A5", "A6", "A7", "A8", "A10", "A11", "A3", "A4", "A9", "A2", "A1"],
  B: ["B1", "B3", "B2", "B4"],
  C: ["C1", "C2", "C3", "C4", "C5", "C6", "A12"],
};

async function importRunners(indexPath: string): Promise<TestRunner[]> {
  const module = (await import(pathToFileURL(indexPath).href)) as { runners?: unknown };
  if (!Array.isArray(module.runners)) {
    throw new Error(`${indexPath} must export runners: TestRunner[]`);
  }
  for (const runner of module.runners) {
    if (typeof runner !== "object" || runner === null || typeof (runner as TestRunner).id !== "string") {
      throw new Error(`${indexPath}: every runner needs a string id`);
    }
  }
  return module.runners as TestRunner[];
}

// Every folder under tracks/ is a group of runners, whatever its name: each runner's own track decides its block.
export async function loadRunners(dir: string = resolve(benchRoot, "tracks")): Promise<Map<TestId, TestRunner>> {
  const root = resolve(dir);
  const runners = new Map<TestId, TestRunner>();
  if (!existsSync(root)) return runners;
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const indexPath = join(root, folder, "index.ts");
    if (!existsSync(indexPath)) continue;
    for (const runner of await importRunners(indexPath)) {
      if (runners.has(runner.id)) throw new Error(`duplicate test runner id ${runner.id} (from ${indexPath})`);
      runners.set(runner.id, runner);
    }
  }
  return runners;
}
