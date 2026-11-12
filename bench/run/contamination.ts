// RUNBOOK.md §7.1 step 6: the first replay request of the run is the control; every later block must match it.
import type { ContaminationResult } from "./instruments.ts";

export interface ContaminationReference {
  body_sha256: string | null;
}

export interface ContaminationCheck {
  ok: boolean;
  reference: string | null;
  actual: string;
  /** "reference" for the first result, then "matches reference" or the mismatch. */
  message: string;
}

export function checkContamination(reference: ContaminationReference, result: ContaminationResult): ContaminationCheck {
  if (reference.body_sha256 === null) {
    reference.body_sha256 = result.body_sha256;
    return { ok: true, reference: result.body_sha256, actual: result.body_sha256, message: "reference" };
  }
  const ok = result.body_sha256 === reference.body_sha256;
  return {
    ok,
    reference: reference.body_sha256,
    actual: result.body_sha256,
    message: ok
      ? "matches reference"
      : `body_sha256 ${result.body_sha256} != reference ${reference.body_sha256}`,
  };
}
