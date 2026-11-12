// A result row for the Control tests, valid unless a test says otherwise.
import type { ResultRow } from "../core/contracts.ts";

export function row(over: Partial<ResultRow>): ResultRow {
  return {
    run_id: "control-x-orca-1",
    machine_id: "ref-mac-mini-m4-16gb",
    ade: "orca",
    ade_version: "1",
    ade_build_sha256: "aaa",
    family: "electron",
    test_id: "A2",
    variant: "relaunch",
    rep: 1,
    model: null,
    effort: null,
    server: "replay",
    value: 1,
    unit: "s",
    started_at: "2026-11-10T00:00:00.000Z",
    duration_ms: 1000,
    valid: true,
    invalid_reason: null,
    drive: "keys",
    receipts: { samples: null, video: null, frames: null, capture: null, log: null },
    notes: "",
    ...over,
  } as ResultRow;
}
