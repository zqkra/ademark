// ADEMARK-44: rehearsal.md. Its first line is the NEW count, and its last section compares with the last lap.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRehearsal, changes, previousRehearsal, writeRehearsal, type RehearsalApp } from "../control/rehearsal.ts";
import { row } from "./control-rows.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-rehearsal-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const app = (over: Partial<RehearsalApp>): RehearsalApp => ({ ade: "orca", label: "Orca", status: "done", note: "", minutes: 9, rows: [], expected: [], ...over });

describe("rehearsal.md", () => {
  test("names each test valid or invalid with its reason, the minutes, and a missing test", () => {
    const built = buildRehearsal({
      runId: "rehearsal-b",
      dry: false,
      ended: false,
      previous: null,
      apps: [
        app({ rows: [row({ test_id: "A1", variant: "cold" }), row({ test_id: "A4", variant: "total", valid: false, invalid_reason: "timed_out" })], expected: ["A1", "A4", "A11"] }),
        app({ ade: "paseo", label: "Paseo", status: "pending", minutes: null }),
      ],
    });
    const lines = built.markdown.split("\n");
    expect(lines[0]).toBe("2 invalid rows that are not accepted limits (NEW)");
    expect(built.markdown).toContain("- time: 9 min");
    expect(built.markdown).toContain("| A1 | valid |");
    expect(built.markdown).toContain("| A4 | invalid (NEW): timed_out |");
    expect(built.markdown).toContain("| A11 | invalid (NEW): no row: the block stopped before it |");
    expect(built.markdown).toContain("## Paseo (paseo)\n\n- step: pending\n- time: -\n\nNot run yet.");
    expect(lines.at(-2)).toBe("No earlier rehearsal to compare with.");
  });

  test("compares with the newest older lap of the same kind, for the apps of this lap", () => {
    const old = buildRehearsal({ runId: "rehearsal-a", dry: false, ended: true, previous: null, apps: [app({ rows: [row({ test_id: "A1", variant: "cold" }), row({ test_id: "A9", variant: "x" })] }), app({ ade: "paseo", label: "Paseo", rows: [row({ ade: "paseo", test_id: "A1", variant: "cold" })] })] });
    writeRehearsal(join(root, "rehearsal-a"), old);
    writeRehearsal(join(root, "rehearsal-0-dry"), buildRehearsal({ runId: "rehearsal-0", dry: true, ended: true, previous: null, apps: [] }));
    writeRehearsal(join(root, "rehearsal-c"), buildRehearsal({ runId: "rehearsal-c", dry: false, ended: true, previous: null, apps: [] }));
    const previous = previousRehearsal(root, "rehearsal-b", false);
    expect(previous?.run_id).toBe("rehearsal-a");
    expect(previousRehearsal(root, "rehearsal-b", true)?.run_id).toBe("rehearsal-0");
    const now = buildRehearsal({ runId: "rehearsal-b", dry: false, ended: true, previous, apps: [app({ rows: [row({ test_id: "A1", variant: "cold", valid: false, invalid_reason: "timed_out" }), row({ test_id: "A3", variant: "default-mode" })] })] });
    const section = now.markdown.slice(now.markdown.indexOf("## Changed since the last rehearsal"));
    expect(section).toContain("- orca A1: valid -> invalid (NEW): timed_out");
    expect(section).toContain("- orca A3: new, valid");
    expect(section).toContain("- orca A9: gone (was valid)");
    expect(section).not.toContain("paseo");
  });

  test("nothing changed says so", () => {
    expect(changes({ "orca A1": "valid" }, { "orca A1": "valid" }, ["orca"])).toEqual(["Nothing changed."]);
  });
});
