// `ademark prepare`: the day before a night. For each ADE: prove every track on the real app, and if it fails, the repair
// agent fixes how the ADE is driven and the proof runs again. Nothing here is ever published: it only decides which
// ADEs the night may measure, through the gate files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../core/contracts.ts";
import type { TrackLetter } from "../run/registry.ts";
import { runRepairAgent, withRecovery, type RepairDeps } from "./repair.ts";

export const DEFAULT_ROUNDS = 3;

export interface PrepareResult {
  ade: string;
  ready: boolean;
  rounds: number;
  /** Why the ADE is not ready, or empty when it is. */
  reason: string;
}

export interface PrepareDeps {
  repair: RepairDeps;
  /** Proves one track on the real app. Returns the failures, empty when it passed. */
  check(o: { ade: string; track: TrackLetter; agents: readonly Agent[]; round: number; runId: string }): Promise<string[]>;
  /** Commits the gate file, so the next gate starts from a clean tree. */
  commitGate(ade: string): void;
  /** A passed Track A gate must not let the night in when a later track failed. */
  revokeGate(ade: string, reason: string): void;
}

export interface PrepareOptions {
  ades: readonly string[];
  tracks: readonly TrackLetter[];
  agents: readonly Agent[];
  rounds?: number;
  runId: string;
  runDir: string;
  template: string;
  deps: PrepareDeps;
  onResult?: (result: PrepareResult) => void;
  /** True once a person pressed Stop: no new proof or agent starts. */
  cancelled?: () => boolean;
}

async function checkAll(o: PrepareOptions, ade: string, round: number): Promise<string[]> {
  const failures: string[] = [];
  // The gate is what lets an ADE into a night, so Track A goes last: a Ctrl-C or a failed Track B cannot leave it passed.
  const ordered = [...o.tracks.filter((track) => track !== "A"), ...o.tracks.filter((track) => track === "A")];
  for (const track of ordered) {
    if (o.cancelled?.() === true) return [`${ade}: stopped`];
    let found: string[];
    try {
      found = await o.deps.check({ ade, track, agents: o.agents, round, runId: o.runId });
    } catch (error) {
      found = [`${ade} ${track}: the proof failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (track === "A") o.deps.commitGate(ade);
    failures.push(...found);
    // A later track would fail on the same broken driving, and each one costs real minutes.
    if (found.length > 0) break;
  }
  return failures;
}

async function prepareAde(o: PrepareOptions, ade: string): Promise<PrepareResult> {
  const rounds = o.rounds ?? DEFAULT_ROUNDS;
  let failures: string[] = [];
  if (o.tracks.includes("A")) o.deps.revokeGate(ade, "prepare started again");
  for (let round = 1; round <= rounds; round++) {
    if (o.cancelled?.() === true) return { ade, ready: false, rounds: round, reason: "stopped" };
    failures = await checkAll(o, ade, round);
    if (failures.length === 0) return { ade, ready: true, rounds: round, reason: "" };
    if (round === rounds) break;
    if (o.cancelled?.() === true) return { ade, ready: false, rounds: round, reason: "stopped" };
    let agent: Awaited<ReturnType<typeof runRepairAgent>>;
    try {
      agent = await withRecovery(o.deps.repair, ade, () =>
        runRepairAgent({
          runDir: o.runDir,
          runId: o.runId,
          ade,
          attempt: round,
          tracks: o.tracks,
          agents: o.agents,
          failures,
          template: o.template,
          deps: o.deps.repair,
          cancelled: o.cancelled,
        }),
      );
    } catch (error) {
      return { ade, ready: false, rounds: round, reason: `repair failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    // The next round proves the repair. Until then nothing the agent wrote may let the ADE in.
    if (o.tracks.includes("A")) o.deps.revokeGate(ade, "repaired, not proven yet");
    if (agent.kind === "ended" && agent.attempt.result === "needs a human") {
      return { ade, ready: false, rounds: round, reason: `needs a human: ${agent.attempt.note}` };
    }
    if (agent.kind === "ended" && ["not clean", "plan limit", "tampered"].includes(agent.attempt.result)) {
      return { ade, ready: false, rounds: round, reason: `${agent.attempt.result}: ${agent.attempt.note}` };
    }
    if (agent.kind === "changed") agent.finish("repaired", "the next round proves it", agent.after, agent.diff);
  }
  return { ade, ready: false, rounds, reason: failures[0] ?? "unknown failure" };
}

export function prepareReport(runId: string, tracks: readonly TrackLetter[], results: readonly PrepareResult[]): string {
  const ready = results.filter((result) => result.ready);
  const lines = [
    `# Prepare ${runId}`,
    "",
    `- tracks: ${tracks.join(",")}`,
    `- ready: ${ready.length} of ${results.length}`,
    "",
    "| ade | ready | rounds | reason |",
    "| --- | --- | --- | --- |",
    ...results.map((result) => `| ${result.ade} | ${result.ready ? "yes" : "no"} | ${result.rounds} | ${result.reason.replaceAll("|", "/")} |`),
    "",
    "Nothing in this folder is a result. A night measures only the ADEs marked yes.",
    "",
  ];
  return lines.join("\n");
}

export async function prepareAll(o: PrepareOptions): Promise<PrepareResult[]> {
  mkdirSync(o.runDir, { recursive: true });
  const results: PrepareResult[] = [];
  const write = (): void => writeFileSync(join(o.runDir, "prepare.md"), prepareReport(o.runId, o.tracks, results));
  for (const ade of o.ades) {
    o.deps.repair.out(`prepare ${ade}: start`);
    const result = await prepareAde(o, ade);
    if (!result.ready) o.deps.revokeGate(ade, result.reason);
    results.push(result);
    o.onResult?.(result);
    o.deps.repair.out(`prepare ${ade}: ${result.ready ? "ready" : `not ready (${result.reason})`}`);
    // Written after each ADE, so a Ctrl-C keeps what is already proven.
    write();
    // Git cannot restore these files, so every later proof would run on a changed timer or snapshot.
    if (result.reason.startsWith("tampered")) {
      o.deps.repair.out("prepare: stopped. Restore bench/native/bin and snapshots before any other proof.");
      break;
    }
  }
  write();
  return results;
}
