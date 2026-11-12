// Where each step of a Control run writes, and how a reader in any account finds those folders again. One place, so
// the night, the rehearsal, QA and the morning report never disagree on a name.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const REHEARSAL_PREFIX = "rehearsal-";

/** A rehearsal is a run of its own kind: its rows are smoke rows and never count as a measurement (ADEMARK-44). */
export function isRehearsalId(runId: string): boolean {
  return runId.startsWith(REHEARSAL_PREFIX);
}

export const adeRunId = (runId: string, ade: string, attempt: number): string => `${runId}-${ade}-${attempt}`;
export const topUpRunId = (runId: string, ade: string, attempt: number): string => `${runId}-${ade}-topup-${attempt}`;
/** ADEMARK-49: `<run>-<ade>-tokens-<n>` and `<run>-<ade>-orchestration-<n>`, apart from the measure. */
export const lateRunId = (runId: string, ade: string, step: "tokens" | "orchestration", attempt: number): string => `${runId}-${ade}-${step}-${attempt}`;

/** The measure folder of one attempt. A dry run adds `-dry`, as `run --dry-run` does. */
export function attemptDir(root: string, runId: string, ade: string, attempt: number, dry: boolean): string {
  const id = adeRunId(runId, ade, attempt);
  return join(root, dry ? `${id}-dry` : id);
}

export function topUpDir(root: string, runId: string, ade: string, attempt: number, dry: boolean): string {
  const id = topUpRunId(runId, ade, attempt);
  return join(root, dry ? `${id}-dry` : id);
}

export function lateDir(root: string, runId: string, ade: string, step: "tokens" | "orchestration", attempt: number, dry: boolean): string {
  const id = lateRunId(runId, ade, step, attempt);
  return join(root, dry ? `${id}-dry` : id);
}

/** A rehearsal child runs `run --smoke`, which adds `-smoke` (and `-dry` before it). */
export function rehearsalDir(root: string, runId: string, ade: string, attempt: number, dry: boolean): string {
  return join(root, `${adeRunId(runId, ade, attempt)}${dry ? "-dry" : ""}-smoke`);
}

/** The folder of the run itself: rehearsal.md and report.md go there. */
export function runDir(root: string, runId: string, dry: boolean): string {
  return join(root, dry ? `${runId}-dry` : runId);
}

export interface FoundFolders {
  /** Measure attempts by number. */
  attempts: Map<number, string>;
  /** Top-up attempts by number. */
  topUps: Map<number, string>;
}

// A folder moved aside after a cut (`-cut-<time>`) or a superseded attempt never counts.
export function foldersOf(root: string, runId: string, ade: string): FoundFolders {
  const found: FoundFolders = { attempts: new Map(), topUps: new Map() };
  if (!existsSync(root)) return found;
  const prefix = `${runId}-${ade}-`;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length).replace(/-dry$/, "");
    const path = join(root, name);
    if (!statSync(path).isDirectory()) continue;
    const plain = /^(\d+)$/.exec(rest);
    const topUp = /^topup-(\d+)$/.exec(rest);
    if (plain !== null) found.attempts.set(Number(plain[1]), path);
    else if (topUp !== null) found.topUps.set(Number(topUp[1]), path);
  }
  return found;
}
