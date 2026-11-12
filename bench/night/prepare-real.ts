// The real side of `ademark prepare`: each proof is a child process, so a repaired profile loads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readGate, writeGate } from "../adapters/gates.ts";
import type { ResultRow } from "../core/contracts.ts";
import { repoRoot, resultsRoot } from "../core/paths.ts";
import type { PrepareDeps } from "./prepare.ts";
import { failuresOf } from "./repair.ts";
import { realRepairDeps, supervised } from "./repair-real.ts";

// Track B is short and runs whole. Track C runs its shortest test: the proof is that the app can be driven, not that
// C1 orchestration works.
const C_PROOF_TESTS = "C6";
// A normal proof takes 10 to 20 minutes. A hung app must not stop the other ADEs.
const CHILD_TIMEOUT_MS = 90 * 60_000;

const child = (args: readonly string[]): Promise<number> =>
  supervised(["bun", "bench/cli.ts", ...args], CHILD_TIMEOUT_MS, repoRoot);

function rowsOf(runDir: string): ResultRow[] {
  const path = join(runDir, "rows.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ResultRow);
}

export function realPrepareDeps(out: (line: string) => void): PrepareDeps {
  const repair = realRepairDeps(out);
  const gatePath = (ade: string): string => `bench/adapters/gates/${ade}.json`;
  return {
    repair,
    commitGate: (ade) => repair.commit([gatePath(ade)], `gate: ${ade} in prepare`),
    revokeGate: (ade, reason) => {
      const gate = readGate(ade);
      if (gate === null || gate.passed < gate.runs) return;
      writeGate({ ...gate, passed: 0, failures: [`prepare: ${reason}`] });
      repair.commit([gatePath(ade)], `gate: ${ade} not ready in prepare`);
    },
    check: async ({ ade, track, agents, round, runId }) => {
      if (track === "A") {
        const code = await child(["calibrate", "gate", "--ade", ade, "--runs", "1", "--agent", agents.join(",")]);
        if (code === 0) return [];
        const failures = readGate(ade)?.failures ?? [];
        return failures.length > 0 ? failures : [`${ade} A: the gate exited with code ${code}`];
      }
      const proofId = `${runId}-${ade}-${track}-${round}`;
      const args = ["run", "--ade", ade, "--tracks", track, "--agent", agents.join(","), "--run-id", proofId];
      if (track === "C") args.push("--tests", C_PROOF_TESTS);
      const code = await child(args);
      const runDir = join(resultsRoot(), proofId);
      const rows = rowsOf(runDir);
      const failures = failuresOf(ade, [], rows);
      // No rows is not a pass: the block may never have run.
      if (rows.length === 0) failures.push(`${ade} ${track}: the proof wrote no rows`);
      if (code !== 0 && failures.length === 0) failures.push(`${ade} ${track}: the block stopped with code ${code}`);
      return failures.length === 0 ? [] : [...failures, `receipts: ${runDir}`];
    },
  };
}

