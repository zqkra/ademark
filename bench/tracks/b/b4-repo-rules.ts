// B4 Repo Rules: is the arena's canary in the requests, and did the answers end with ledger-ok (TESTS.md §3).
import { writeFileSync } from "node:fs";
import { invalidRow, receipt } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import {
  captureFor,
  captureReceipt,
  containsCanary,
  lastNonEmptyLine,
  readBodyText,
  REPO_RULES_CANARY,
  repProblem,
  repsFor,
  soundReps,
  type RepCapture,
} from "./shared.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const b4RepoRules: TestRunner = {
  id: "B4",
  track: "B",
  repeats: () => 1,
  maxExtraRuns: 0,
  needsExtraRun: () => false,
  runRep: async (ctx, rep) => {
    const capture = captureFor(ctx);
    // Only reps that passed their checks are evidence: a rep on another model, or with a main thread in doubt, says
    // nothing about this app at the pinned model.
    const allB1 = repsFor(ctx, "B1");
    const allB3 = repsFor(ctx, "B3");
    const b1 = soundReps(allB1);
    const all = [...b1, ...soundReps(allB3)];
    const firstFault = (reps: readonly RepCapture[]): string | null =>
      reps.map((entry) => repProblem(entry)).find((problem): problem is string => problem !== null) ?? null;
    const receiptsFor = (log: string | null) => ({
      samples: null,
      video: null,
      frames: null,
      capture: captureReceipt(ctx, capture),
      log,
    });

    const bodyFiles: string[] = [];
    for (const captureRep of all) {
      for (const row of captureRep.main) {
        if (row.body_file !== null) bodyFiles.push(row.body_file);
      }
    }

    const scanNotes: string[] = [];
    const canaryBodies: string[] = [];
    let found = false;
    for (const bodyFile of bodyFiles) {
      try {
        if (containsCanary(readBodyText(capture, bodyFile))) {
          found = true;
          canaryBodies.push(bodyFile);
          break;
        }
      } catch (error) {
        scanNotes.push(`cannot read ${bodyFile}: ${messageOf(error)}`);
      }
    }

    const lines = b1.map((captureRep) => ({ rep: captureRep.rep, line: lastNonEmptyLine(captureRep.lastText) }));
    // A missing log is missing evidence: obeyed is never a "did not obey" zero, and never a valid null either, because
    // a valid row counts as measured (Conductor and super.engineering B4, 2026-11-07).
    const missingText = b1.filter((captureRep) => captureRep.lastText === null);
    const b1Fault = b1.length === 0 ? firstFault(allB1) : null;
    const obeyedProblem =
      b1Fault !== null ? `no valid B1 repetition: ${b1Fault}` : b1.length === 0 || missingText.length > 0 ? "no session log" : null;
    const obeyed = obeyedProblem !== null ? null : lines.every((entry) => entry.line === "ledger-ok") ? 1 : 0;
    const obeyNotes =
      obeyedProblem !== null
        ? missingText.length === 0
          ? obeyedProblem
          : `no session log (reps ${missingText.map((captureRep) => captureRep.rep).join(", ")})`
        : lines.map((entry) => `rep ${entry.rep}: ${entry.line ?? "no text"}`).join("; ");
    const canaryNotes = found ? `canary in ${canaryBodies.join(", ")}` : "canary absent";
    const inRequestNotes = [canaryNotes, ...scanNotes].join("; ");

    const canaryFile = receipt(ctx, "B4", rep, "canary.json");
    writeFileSync(
      canaryFile.abs,
      `${JSON.stringify({ canary: REPO_RULES_CANARY, found, bodies: canaryBodies, notes: scanNotes }, null, 2)}\n`,
    );
    const logFile = receipt(ctx, "B4", rep, "notes.md");
    writeFileSync(
      logFile.abs,
      `${["# B4", `in-request: ${bodyFiles.length === 0 ? "no evidence" : found ? "yes" : "no"}`, `obeyed: ${obeyed === null ? "unknown" : obeyed === 1 ? "yes" : "no"}`, canaryNotes, obeyNotes, ...scanNotes].join("\n")}\n`,
    );
    const receipts = receiptsFor(logFile.rel);

    const inRequest =
      bodyFiles.length === 0
        ? invalidRow(
            ctx,
            {
              test_id: "B4",
              variant: "in-request",
              rep,
              server: "live",
              unit: "bool",
              duration_ms: 0,
              receipts,
              notes: inRequestNotes,
            },
            all.length === 0 && firstFault([...allB1, ...allB3]) !== null
              ? `no valid B1 or B3 repetition: ${firstFault([...allB1, ...allB3])}`
              : "no main-thread request captured",
          )
        : ctx.row({
            test_id: "B4",
            variant: "in-request",
            rep,
            server: "live",
            value: found ? 1 : 0,
            unit: "bool",
            duration_ms: 0,
            valid: true,
            invalid_reason: null,
            receipts,
            notes: inRequestNotes,
          });

    const obeyedBase = { test_id: "B4" as const, variant: "obeyed", rep, server: "live" as const, unit: "bool", duration_ms: 0, receipts, notes: obeyNotes };
    return [
      inRequest,
      obeyedProblem !== null
        ? invalidRow(ctx, obeyedBase, obeyedProblem)
        : ctx.row({ ...obeyedBase, value: obeyed, valid: true, invalid_reason: null }),
    ];
  },
};
