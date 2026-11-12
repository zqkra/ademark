// `ademark calibrate gate --ade <id> [--runs 5] [--dry-run]`: `runs` smoke runs of one ADE in a row, each from the
// adapter's own reset, then the gate record of bench/adapters/gates/<id>.json. The night only measures an ADE whose
// gate is `ok`, so this is the last step of a calibration day.
import { mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { gatesDir, writeGate } from "../adapters/gates.ts";
import { getAdapter } from "../adapters/registry.ts";
import type { Agent, CalibrationGate, TestId } from "../core/contracts.ts";
import { repoRoot, resultsRoot } from "../core/paths.ts";
import { RunWriter } from "../core/results.ts";
import { readRows } from "../core/summarize.ts";
import { dryInstruments } from "../run/dry.ts";
import type { Instruments } from "../run/instruments.ts";
import { runAll } from "../run/loop.ts";
import { realInstruments } from "../run/real.ts";
import { loadRunners, type TestRunner } from "../run/registry.ts";
import { passFailures } from "./pass.ts";

export const MEASURE_USER = "ademark";
export const GATE_RUNS = 5;

/** The message `ademark run` prints (bench/cli.ts cmdRun): a real measurement is only allowed in the ademark user. */
export function measurementRefusal(username: string): string {
  return (
    `refusing to measure as "${username}": a real run is only allowed as the dedicated "${MEASURE_USER}" macOS user ` +
    `(METHODOLOGY.md §5). Use --dry-run to exercise the loop without measuring.`
  );
}

function dirtyRefusal(ade: string, dirty: string[]): string {
  return (
    `calibrate gate: refusing to write a passing gate for ${ade}: ` +
    `${dirty.length} uncommitted file(s) in ${repoRoot}; a gate records the commit it measured with, ` +
    `so commit the harness and run the gate again`
  );
}

export interface GateGit {
  head(): string;
  dirty(): string[];
}

function gitOutput(argv: string[]): string[] {
  const result = Bun.spawnSync(["git", ...argv], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout.toString().split("\n").filter((line) => line.trim().length > 0);
}

export const systemGit: GateGit = {
  head: () => gitOutput(["rev-parse", "HEAD"])[0] ?? "",
  dirty: () => gitOutput(["status", "--porcelain"]),
};

export interface GateOptions {
  ade: string;
  runs?: number;
  dryRun?: boolean;
  agents?: readonly Agent[];
  username?: string;
  runners?: Map<TestId, TestRunner>;
  instruments?: (planPath: string) => Instruments;
  resultsRoot?: string;
  gatesDir?: string;
  /** A repair's own check: the record goes to a temp folder and cannot let the ADE into a night. */
  scratch?: boolean;
  git?: GateGit;
  out?: (line: string) => void;
}

export interface GateOutcome {
  gate: CalibrationGate;
  file: string;
  /** True when every requested run passed, so the written gate has `passed == runs`. */
  passed: boolean;
}

/** `2026-10-21T03-15-00Z`, a safe run-id segment. */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
}

export function gateOutputDir(options: Pick<GateOptions, "ade" | "gatesDir" | "scratch">, dryRun: boolean): string {
  if (options.gatesDir !== undefined) return options.gatesDir;
  if (dryRun || options.scratch === true) return mkdtempSync(join(tmpdir(), `ademark-gate-${options.ade}-`));
  return gatesDir();
}

export async function calibrateGate(options: GateOptions): Promise<GateOutcome> {
  const out = options.out ?? ((line: string) => console.log(line));
  const dryRun = options.dryRun === true;
  const username = options.username ?? userInfo().username;
  const runs = options.runs ?? GATE_RUNS;
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("calibrate gate: --runs must be a positive integer");
  }
  if (!dryRun && username !== MEASURE_USER) {
    throw new Error(`calibrate gate: ${measurementRefusal(username)}`);
  }

  const adapter = getAdapter(options.ade);
  const git = options.git ?? systemGit;
  // A real gate costs about 25 minutes, so an uncommitted tree stops it before the first run rather than after.
  const startHead = git.head();
  const dirtyAtStart = git.dirty();
  if (!dryRun && dirtyAtStart.length > 0) throw new Error(dirtyRefusal(options.ade, dirtyAtStart));
  const runners = options.runners ?? (await loadRunners());
  const instrumentsFor = options.instruments ?? ((planPath: string) => dryInstruments(planPath));
  const writersRoot = options.resultsRoot ?? resultsRoot();
  const stamp = utcStamp(new Date());
  const failures: string[] = [];
  let passed = 0;

  out(
    `calibrate gate ${options.ade}: ${dryRun ? "dry run, " : ""}${runs} smoke run(s) in a row ` +
      `(Track A, from the adapter's own reset)`,
  );
  // A dry run measures nothing: its rows are fixed values and A4 has no replay log to read. The gate then checks that
  // every block finished, and its record goes to a temp folder, never to bench/adapters/gates/.
  if (dryRun) out("dry run: every block must finish; row validity is not checked");
  if (dirtyAtStart.length > 0) {
    out("warning: the harness tree is not clean; a passing gate will not be written (commit first)");
  }

  for (let n = 1; n <= runs; n++) {
    const runId = `gate-${options.ade}-${stamp}-${n}`;
    out(`gate run ${n}/${runs}: ${runId}`);
    const writer = new RunWriter(writersRoot).open(runId);
    const instruments = dryRun ? instrumentsFor(join(writer.runDir, "plan.jsonl")) : realInstruments();
    const result = await runAll({
      ades: [options.ade],
      tracks: ["A"],
      runId,
      seed: runId,
      instruments,
      runners,
      writer,
      smoke: true,
      agents: options.agents,
    });
    const rows = dryRun ? [] : readRows(join(writer.runDir, "rows.jsonl"));
    const runFailures = passFailures(result.blocks, rows);
    if (runFailures.length > 0) {
      out(`gate run ${n}/${runs}: failed (${runFailures.length} failure(s))`);
      for (const failure of runFailures) out(`  ${failure}`);
      failures.push(...runFailures);
      break;
    }
    passed += 1;
    out(`gate run ${n}/${runs}: passed (${result.rows} rows)`);
  }

  const installed = await adapter.installCheck();
  const gate: CalibrationGate = {
    ade: options.ade,
    runs,
    passed,
    at: new Date().toISOString(),
    harnessCommit: startHead,
    version: installed.version ?? "unknown",
    bundleSha256: installed.binarySha256,
    failures,
  };

  if (passed === runs) {
    const dirty = git.dirty();
    if (dirty.length > 0) throw new Error(dirtyRefusal(options.ade, dirty));
    const endHead = git.head();
    if (endHead !== startHead) {
      throw new Error(
        `calibrate gate: refusing to write a passing gate for ${options.ade}: the harness changed while the gate ` +
          `ran (HEAD ${startHead} -> ${endHead}); run the gate again from the new commit`,
      );
    }
  }

  const dir = gateOutputDir(options, dryRun);
  const file = writeGate(gate, dir);
  const verdict = passed === runs ? "passed" : "failed";
  out(`gate ${verdict}: ${passed}/${runs} smoke run(s) in a row`);
  out(`wrote ${file}`);
  return { gate, file, passed: passed === runs };
}
