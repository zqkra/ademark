// The smoke-run pass rule (ADEMARK-20). The calibration gate and the night's rehearsal both use it, so an ADE is
// measured at night only after the same runs that gate it passed here.
import type { ResultRow } from "../core/contracts.ts";

// A row whose ADE cannot run the test says so in its invalid_reason; that is a fact about the ADE, not a failure.
export const NOT_SUPPORTED = "not supported";

export interface PassBlock {
  ade: string;
  track: string;
  finished: boolean;
  error: string | null;
}

export type PassRow = Pick<ResultRow, "ade" | "test_id" | "variant" | "valid" | "invalid_reason">;

function rowFailure(row: PassRow): string | null {
  if (row.valid) return null;
  const reason = row.invalid_reason ?? "invalid";
  if (reason.startsWith(NOT_SUPPORTED)) return null;
  const label = row.variant.length > 0 ? `${row.ade} ${row.test_id} ${row.variant}` : `${row.ade} ${row.test_id}`;
  return `${label}: ${reason}`;
}

/** One line per distinct failure: `<ade> <test_id> <variant>: <reason>` or `<ade> <track> block: <error>`. */
export function passFailures(blocks: readonly PassBlock[], rows: readonly PassRow[]): string[] {
  const failures: string[] = [];
  for (const block of blocks) {
    if (block.finished) continue;
    failures.push(`${block.ade} ${block.track} block: ${block.error ?? "did not finish"}`);
  }
  for (const row of rows) {
    const failure = rowFailure(row);
    if (failure !== null) failures.push(failure);
  }
  return [...new Set(failures)];
}
