// ADEMARK-37: a measure that finished but was never marked done must not be measured again. On 2026-11-09 Bare CLI's
// attempt 1 had 89 rows and its block marker (results/control-2026-11-09T04-18-06Z-bare-cli-1/bare-cli-claude/
// A-claude.done), Control died before it marked the step, and Continue started attempt 2 from zero.
import { existsSync, readFileSync } from "node:fs";
import { getAdapter } from "../adapters/registry.ts";
import type { Agent } from "../core/contracts.ts";
import { blocksFor, rowAdeFor } from "../run/models.ts";
import type { TrackLetter } from "../run/registry.ts";
import { blockIsDone } from "../run/retry.ts";

export function rowCount(runDir: string): number {
  const path = `${runDir}/rows.jsonl`;
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
}

/** Every block of the requested tracks and agents wrote its marker: the run loop writes one only after a block ends. */
export function everyBlockDone(runDir: string, ade: string, tracks: readonly TrackLetter[], agents: readonly Agent[]): boolean {
  const adapter = getAdapter(ade);
  let blocks = 0;
  for (const track of tracks) {
    for (const options of blocksFor(adapter, track)) {
      if (!agents.includes(options.agent)) continue;
      blocks += 1;
      if (!blockIsDone(runDir, rowAdeFor(adapter, options.agent), track, options.agent)) return false;
    }
  }
  return blocks > 0;
}

/**
 * The newest attempt, from `attempts` down to 1, whose folder has every block marker and at least one row. A folder
 * with 0 rows or a missing marker is never adopted: that would publish a measurement nobody finished.
 */
export function finishedAttempt(o: {
  ade: string;
  attempts: number;
  dirOf: (attempt: number) => string;
  tracks: readonly TrackLetter[];
  agents: readonly Agent[];
  only?: number;
}): { attempt: number; rows: number } | null {
  for (let attempt = o.attempts; attempt >= 1; attempt--) {
    if (o.only !== undefined && attempt !== o.only) continue;
    const dir = o.dirOf(attempt);
    const rows = rowCount(dir);
    if (rows > 0 && everyBlockDone(dir, o.ade, o.tracks, o.agents)) return { attempt, rows };
  }
  return null;
}
