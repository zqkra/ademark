// Everything the night touches outside its own logic, so a test can replace it: the user, the registry, the gate
// records, doctor, the machine step and the process that holds the Mac awake.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { readGate } from "../adapters/gates.ts";
import { listAdapters } from "../adapters/registry.ts";
import { systemGit } from "../calibrate/gate.ts";
import type { Adapter, Agent, CalibrationGate, TestId } from "../core/contracts.ts";
import { resultsRoot } from "../core/paths.ts";
import { runDoctor, type CheckResult } from "../ops/doctor.ts";
import { machineCommand } from "../ops/machine.ts";
import { dryInstruments } from "../run/dry.ts";
import type { Instruments } from "../run/instruments.ts";
import { realInstruments } from "../run/real.ts";
import { loadRunners, type TestRunner } from "../run/registry.ts";

import { realRepairDeps, supervised } from "./repair-real.ts";
import type { RepairDeps } from "./repair.ts";

export interface CaffeinateHandle {
  pid: number;
  kill(): void;
}

export interface NightDeps {
  username(): string;
  home(): string;
  adapters(): readonly Adapter[];
  readGate(id: string): CalibrationGate | null;
  exists(path: string): boolean;
  /** `apply` false prints the plan for the machine step and changes nothing. */
  machine(action: "on" | "off", apply: boolean, out: (line: string) => void): void;
  /** Delete all but the newest moved-aside copy of each ADE's data (~/ademark-aside/<adapter>/<UTC stamp>/). */
  pruneAside(apply: boolean, out: (line: string) => void): void;
  doctor(agents?: readonly Agent[], options?: { ignoreSwap?: boolean }): Promise<{ results: CheckResult[]; exitCode: number }>;
  runners(): Promise<Map<TestId, TestRunner>>;
  instruments(dryRun: boolean, planPath: string): Instruments;
  caffeinate(): CaffeinateHandle | null;
  ask(): Promise<boolean>;
  out(line: string): void;
  now(): number;
  git(): { commit: string; dirty: string[] };
  resultsRoot(): string;
  repair(out: (line: string) => void): RepairDeps;
}

export const ASIDE_ROOT = join(homedir(), "ademark-aside");
// A copy is up to 2.6 GB (Traycer). 10 minutes means the disk is stuck, not busy.
const PRUNE_TIMEOUT_MS = 10 * 60_000;

/** All but the newest moved-aside copy of each ADE: older ones are runs the harness itself made in this account. */
export function asideToPrune(root: string = ASIDE_ROOT): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((adapter) => readdirSync(join(root, adapter)).sort().slice(0, -1).map((stamp) => join(root, adapter, stamp)));
}

/**
 * The same delete as a child with a time limit, for Control. A sync rmSync of gigabytes froze its thread, so no
 * heartbeat was written and the watchdog could restart a healthy Control (review, 2026-11-10).
 */
export async function pruneAsideInChild(out: (line: string) => void, root: string = ASIDE_ROOT, timeoutMs: number = PRUNE_TIMEOUT_MS): Promise<void> {
  const paths = asideToPrune(root);
  if (paths.length === 0) return;
  const code = await supervised(["/bin/rm", "-rf", "--", ...paths], timeoutMs);
  if (code === 0) for (const path of paths) out(`removed ${path}`);
  else out(`removing ${paths.length} moved-aside copies ended with ${code === 124 ? "the time limit" : `code ${code}`}; going on`);
}

async function askStdin(): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question("> ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

export function defaultNightDeps(): NightDeps {
  return {
    username: () => userInfo().username,
    home: () => homedir(),
    adapters: () => listAdapters(),
    readGate: (id) => readGate(id),
    exists: (path) => existsSync(path),
    // 2026-10-24: a calibration day left 15 GB of moved-aside app data (Conductor and Paseo about 700 MB per reset).
    // The newest copy per ADE is kept; older ones are runs the harness itself made in this account.
    pruneAside: (apply, out) => {
      for (const path of asideToPrune()) {
        if (!apply) {
          out(`plan: remove ${path}`);
          continue;
        }
        rmSync(path, { recursive: true, force: true });
        out(`removed ${path}`);
      }
    },
    machine: (action, apply, out) => {
      // A dry night never runs the machine command: sudo, displayplacer and the analyzers stay untouched.
      if (!apply) {
        out(`plan: ademark machine ${action} --apply`);
        return;
      }
      machineCommand(action, { apply: true, out });
    },
    // RUNBOOK.md 8: wait up to 5 min. `machine on` itself wakes softwareupdated, so a first sample is never quiet.
    doctor: (agents, options) => runDoctor({ agents, ignoreSwap: options?.ignoreSwap, quietWaitMs: 5 * 60_000 }),
    runners: () => loadRunners(),
    instruments: (dryRun, planPath) => (dryRun ? dryInstruments(planPath) : realInstruments()),
    caffeinate: () => {
      const proc = Bun.spawn(["caffeinate", "-dimsu", "-w", String(process.pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return { pid: proc.pid, kill: () => proc.kill() };
    },
    ask: askStdin,
    out: (line) => console.log(line),
    now: () => Date.now(),
    git: () => ({ commit: systemGit.head(), dirty: systemGit.dirty() }),
    resultsRoot: () => resultsRoot(),
    repair: (out) => realRepairDeps(out),
  };
}
