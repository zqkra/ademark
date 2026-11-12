// The rehearsal's writer: every row is printed as it is written, so the owner sees the rehearsal happen.
import type { ResultRow } from "../core/contracts.ts";
import { RunWriter } from "../core/results.ts";

export function formatRowLine(row: ResultRow): string {
  const variant = row.variant.length > 0 ? ` ${row.variant}` : "";
  const value = row.value === null ? "-" : String(row.value);
  const verdict = row.valid ? "valid" : `invalid: ${row.invalid_reason ?? ""}`;
  return `${row.ade} ${row.test_id}${variant} rep ${row.rep}: ${value} ${row.unit} (${verdict})`;
}

export class PrintingWriter extends RunWriter {
  private readonly print: (line: string) => void;

  constructor(root: string, print: (line: string) => void) {
    super(root);
    this.print = print;
  }

  override appendRow(row: ResultRow): void {
    super.appendRow(row);
    this.print(`  row ${formatRowLine(row)}`);
  }
}
