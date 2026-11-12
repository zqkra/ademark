// `ademark night`: machine on, doctor, a short rehearsal, the run, and always machine off with one report
// (results/<run-id>/night.md). Stop it with Ctrl-C and it still puts the machine back and says why it stopped.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MEASURE_USER, measurementRefusal } from "../calibrate/gate.ts";
import { passFailures } from "../calibrate/pass.ts";
import type { Agent } from "../core/contracts.ts";
import { shuffle } from "../core/order.ts";
import { RunWriter } from "../core/results.ts";
import { formatDoctorTable } from "../ops/doctor.ts";
import { summarizeRun } from "../core/summarize.ts";
import { runAll, type BlockResult } from "../run/loop.ts";
import type { TrackLetter } from "../run/registry.ts";
import { defaultNightDeps, type CaffeinateHandle, type NightDeps } from "./deps.ts";
import { formatLocal, formatPlan, nextDeadline } from "./plan.ts";
import { DEFAULT_REPAIR_MINUTES, failuresOf, repairNight, repairTemplate, unfinishedBlocks, type RepairAttempt } from "./repair.ts";
import { buildNightReport, readRunRows, writeNightReport, type NightState } from "./report.ts";
import { selectAdes } from "./select.ts";
import { PrintingWriter } from "./writer.ts";

export interface NightOptions {
  tracks: readonly TrackLetter[];
  agents?: readonly Agent[];
  /** Measure ADEs without a passed calibration gate (bench/night/select.ts). */
  ungated?: boolean;
  /** Adapter ids left out of the night. */
  skip?: readonly string[];
  /** The whole night with smoke runs (one repetition, short windows): a dress rehearsal, never published. */
  smoke?: boolean;
  seed?: string;
  /** `HH:MM` local: no ADE starts after its next occurrence. */
  until?: string;
  /** False leaves failed ADEs failed: no repair agent starts. */
  repair?: boolean;
  /** Total budget for all repairs of this night. */
  repairMinutes?: number;
  /** Skip `Start the night? [y/N]`. */
  yes?: boolean;
  dryRun?: boolean;
  runId?: string;
  deps?: Partial<NightDeps>;
}

export interface NightOutcome {
  runId: string;
  runDir: string;
  reportPath: string;
  exitCode: number;
  state: NightState;
}

// A repaired ADE was measured again, so its old stopped blocks no longer count.
function unrepairedBlocks(blocks: readonly BlockResult[], repairs: readonly RepairAttempt[]): BlockResult[] {
  const repaired = repairs.filter((entry) => entry.result === "repaired").map((entry) => entry.ade);
  return blocks.filter((block) => !repaired.some((ade) => block.ade === ade || block.ade.startsWith(`${ade}-`)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `night-2026-10-21T22-00Z-3f9c2a1`: UTC start and the harness commit, like `ademark run`. */
export function defaultNightRunId(now: number, commit: string): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `night-${day}T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}Z-${commit.slice(0, 7)}`;
}

export async function runNight(options: NightOptions): Promise<NightOutcome> {
  const deps: NightDeps = { ...defaultNightDeps(), ...options.deps };
  const out = deps.out;
  const dryRun = options.dryRun === true;
  const started = deps.now();
  const git = deps.git();
  const baseRunId = options.runId ?? defaultNightRunId(started, git.commit);
  const runId = `${baseRunId}${dryRun ? "-dry" : ""}${options.smoke === true ? "-smoke" : ""}`;
  const seed = options.seed ?? baseRunId;
  const tracks = [...options.tracks];
  const repair = options.repair !== false;
  const ungated = options.ungated === true;
  const deadline = options.until === undefined ? null : nextDeadline(options.until, started);

  const state: NightState = {
    runId,
    seed,
    dryRun,
    tracks,
    startedAt: new Date(started).toISOString(),
    endedAt: null,
    stopReason: null,
    warnings: [],
    knownAdes: deps.adapters().map((adapter) => adapter.id),
    chosen: [],
    order: [],
    skipped: [],
    plan: null,
    doctor: null,
    doctorTable: null,
    machine: [],
    rehearsal: null,
    result: null,
    repairs: [],
    runDir: join(deps.resultsRoot(), runId),
    harnessCommit: git.commit.length > 0 ? git.commit : null,
  };

  // Step 1: a real night is only allowed as the ademark user; the message is the one `run` prints.
  const username = deps.username();
  if (!dryRun && username !== MEASURE_USER) {
    throw new Error(`night: ${measurementRefusal(username)}`);
  }

  let cleaned = false;
  let caffeinate: CaffeinateHandle | null = null;
  const reportPath = join(state.runDir, "night.md");
  const recordMachine = (line: string): void => {
    state.machine.push(line);
    out(line);
  };

  // Step 9: always put the machine back, release caffeinate, and write night.md with whatever is known.
  const cleanup = (reason: string | null, exitCode: number): NightOutcome => {
    if (!cleaned) {
      cleaned = true;
      if (reason !== null) state.stopReason = reason;
      state.endedAt = new Date(deps.now()).toISOString();
      out(dryRun ? "machine off (dry run):" : "machine off:");
      try {
        deps.machine("off", !dryRun, recordMachine);
      } catch (error) {
        const message = `machine off failed: ${messageOf(error)}`;
        state.warnings.push(message);
        out(message);
      }
      if (caffeinate !== null) {
        caffeinate.kill();
        caffeinate = null;
        out("caffeinate: released");
      }
      mkdirSync(state.runDir, { recursive: true });
      writeNightReport(reportPath, buildNightReport(state, readRunRows(state.runDir)));
      out(`wrote ${reportPath}`);
    }
    return { runId, runDir: state.runDir, reportPath, exitCode, state };
  };

  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    const outcome = cleanup(`stopped by ${signal}`, signal === "SIGINT" ? 130 : 143);
    process.exit(outcome.exitCode);
  };
  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  try {
    out(
      `night ${runId}: ${dryRun ? "dry run, " : ""}tracks ${tracks.join(",")}` +
        `${deadline === null ? "" : `, until ${formatLocal(deadline)}`}`,
    );

    // Step 2: hold the Mac awake for the whole command.
    if (dryRun) {
      out(`plan: caffeinate -dimsu -w ${process.pid}`);
    } else {
      caffeinate = deps.caffeinate();
      if (caffeinate === null) throw new Error("night: caffeinate did not start");
      out(`caffeinate: holding the Mac awake (pid ${caffeinate.pid})`);
    }

    // Step 3: machine on.
    out(dryRun ? "machine on (dry run):" : "machine on:");
    deps.machine("on", !dryRun, recordMachine);
    deps.pruneAside(!dryRun, out);

    // Step 4: doctor. A real night stops on a blocking failure; a dry run reports it and goes on, so the owner can
    // rehearse the whole night before the ademark account exists.
    // Only tracks that read memory or time need swap at 0.
    const doctor = await deps.doctor(options.agents, { ignoreSwap: !tracks.includes("A") && !tracks.includes("C") });
    state.doctor = doctor.results;
    state.doctorTable = formatDoctorTable(doctor.results);
    out(state.doctorTable);
    const blocking = doctor.results.filter((entry) => entry.blocking && entry.status === "fail");
    if (blocking.length > 0) {
      const names = blocking.map((entry) => entry.name).join(", ");
      if (!dryRun) {
        return cleanup(`doctor: ${blocking.length} blocking check(s) failed: ${names}`, 1);
      }
      const warning = `dry run: ${blocking.length} blocking check(s) failed (${names}); a real night would stop here`;
      state.warnings.push(warning);
      out(warning);
    }

    // Step 5: every adapter in the registry, with the reason it is skipped.
    const agents = options.agents;
    const skipIds = options.skip ?? [];
    const runnable = deps
      .adapters()
      .filter((adapter) => agents === undefined || adapter.agents.some((agent) => agents.includes(agent)))
      .filter((adapter) => !skipIds.includes(adapter.id));
    const selection = await selectAdes({
      adapters: runnable,
      ungated: options.ungated,
      readGate: deps.readGate,
      exists: deps.exists,
      home: deps.home(),
    });
    state.chosen = selection.chosen.map((adapter) => adapter.id);
    state.skipped = [
      ...deps
        .adapters()
        .filter((adapter) => !runnable.includes(adapter))
        .map((adapter) => ({
          ade: adapter.id,
          reason: skipIds.includes(adapter.id) ? "--skip" : `runs none of --agent ${agents?.join(",")}`,
        })),
      ...selection.skipped,
    ];
    // runAll shuffles with the seed, so the plan's order is the run's order.
    state.order = shuffle(state.chosen, seed);
    out(`ADEs: ${state.chosen.length} chosen, ${state.skipped.length} skipped`);
    for (const skip of state.skipped) out(`  skip ${skip.ade}: ${skip.reason}`);

    // Step 6: rehearsal, a smoke run of the Bare CLI and the first chosen ADE in the run order.
    const rehearsalRunId = `${runId}-rehearsal`;
    // An ungated night rehearses the control alone and stops only on a block that cannot finish: an ADE that fails is
    // retried at the end of the night and then skipped, so it must not stop the others before they start.
    const first = state.order[0];
    const rehearsalAdes = ungated || first === undefined || first === "bare-cli" ? ["bare-cli"] : ["bare-cli", first];
    const rehearsalWriter = new PrintingWriter(deps.resultsRoot(), out).open(rehearsalRunId);
    out(`rehearsal: smoke run of ${rehearsalAdes.join(", ")} (${rehearsalRunId})`);
    const runners = await deps.runners();
    const rehearsal = await runAll({
      ades: rehearsalAdes,
      tracks: ["A"],
      runId: rehearsalRunId,
      seed,
      instruments: deps.instruments(dryRun, join(rehearsalWriter.runDir, "plan.jsonl")),
      runners,
      writer: rehearsalWriter,
      smoke: true,
      agents,
    });
    const rehearsalRows = readRunRows(rehearsalWriter.runDir);
    // A dry run measures nothing (its A4 rows have no replay log to read), so it only checks that blocks finished.
    const rehearsalFailures = passFailures(rehearsal.blocks, dryRun || ungated ? [] : rehearsalRows);
    if (ungated && !dryRun) {
      for (const failure of passFailures([], rehearsalRows)) out(`rehearsal warning: ${failure}`);
    }
    state.rehearsal = {
      runId: rehearsalRunId,
      runDir: rehearsalWriter.runDir,
      ades: rehearsalAdes,
      rows: rehearsalRows.length,
      failures: rehearsalFailures,
      passed: rehearsalFailures.length === 0,
    };
    if (dryRun) out("dry run: the rehearsal checks that every block finished, not row validity");
    if (rehearsalFailures.length > 0) {
      out("rehearsal failed:");
      for (const failure of rehearsalFailures) out(`  ${failure}`);
      // An unattended night goes on: a failed ADE gets its repair, and stopping here would measure nothing.
      if (!repair) return cleanup(`rehearsal failed: ${rehearsalFailures[0]!}`, 1);
      state.warnings.push(`rehearsal failed, the night went on: ${rehearsalFailures[0]!}`);
    } else {
      out(`rehearsal passed: ${rehearsalRows.length} rows in ${rehearsal.blocks.length} block(s)`);
    }

    state.plan = formatPlan({ order: state.order, skipped: selection.skipped, tracks, now: deps.now() });
    out(state.plan);

    if (dryRun) {
      out("dry run: answering yes");
    } else if (options.yes !== true) {
      out("Start the night? [y/N]");
      if (!(await deps.ask())) return cleanup("not started: the owner answered no", 0);
    }

    // Step 7: the night itself, with the deadline from --until.
    const writer = new RunWriter(deps.resultsRoot()).open(runId);
    state.runDir = writer.runDir;
    out(
      `night: measuring ${state.order.length} ADE(s)` +
        `${deadline === null ? "" : `, no ADE starts after ${formatLocal(deadline)}`}`,
    );
    const result = await runAll({
      ades: state.chosen,
      tracks,
      runId,
      seed,
      instruments: deps.instruments(dryRun, join(writer.runDir, "plan.jsonl")),
      runners,
      writer,
      deadline: deadline ?? undefined,
      agents,
      smoke: options.smoke === true,
      // One Traycer copy is 2.6 GB, so the moved-aside data would fill the disk during a long night.
      betweenAdes: dryRun ? undefined : () => deps.pruneAside(true, out),
    });
    state.result = result;
    out(
      `night ${runId}: ${result.rows} rows in ${result.blocks.length} block(s), ` +
        `${result.retried.length} retried, ${result.skippedForTime.length} skipped for time`,
    );

    // Step 7b: self-repair, after every block has ended, so no agent runs while anything is measured.
    if (dryRun || !repair || options.smoke === true) {
      out(`repair: ${repair && options.smoke !== true ? "dry run, no agent starts" : "off"}`);
    } else {
      await repairNight({
        onAttempt: (attempt) => {
          state.repairs?.push(attempt);
          deps.pruneAside(true, out);
        },
        runDir: writer.runDir,
        runId,
        seed,
        tracks,
        agents,
        order: result.order.filter((ade) => state.chosen.includes(ade)),
        blocks: result.blocks,
        deadline,
        budgetMs: (options.repairMinutes ?? DEFAULT_REPAIR_MINUTES) * 60_000,
        template: repairTemplate(),
        deps: deps.repair(out),
      });
      summarizeRun(writer.runDir);
    }

    // Step 8 and 9: the report and the machine are handled by cleanup.
    const rows = readRunRows(writer.runDir);
    const failed = !dryRun && repair
      ? unfinishedBlocks(unrepairedBlocks(result.blocks, state.repairs ?? [])).length > 0 ||
        result.order.some((ade) => failuresOf(ade, unrepairedBlocks(result.blocks, state.repairs ?? []), rows).length > 0)
      : result.stopped;
    return cleanup(failed ? "an ADE still fails after the retry and the repairs" : null, failed ? 1 : 0);
  } catch (error) {
    const message = messageOf(error);
    out(`night stopped: ${message}`);
    return cleanup(message, 1);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
