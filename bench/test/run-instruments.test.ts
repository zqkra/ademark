import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowFields } from "../run/context.ts";
import { createTestContext, sampleRulesFor } from "../run/context.ts";
import { dryInstruments } from "../run/dry.ts";
import { RunWriter } from "../core/results.ts";
import { validateRow } from "../core/results.ts";
import { median } from "../core/stats.ts";
import { groupSeries, readSamples } from "../run/kit.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const MIB = 1024 * 1024;
const REGION = { x: 0, y: 0, w: 1600, h: 1000 };

function planLines(path: string): Array<{ call: string; args: Record<string, unknown> }> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { call: string; args: Record<string, unknown> });
}

describe("dryInstruments", () => {
  test("implements every Instruments member", () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-dry-"));
    try {
      const instruments = dryInstruments(join(dir, "plan.jsonl")) as unknown as Record<string, unknown>;
      const members = [
        "now", "sleep", "procs", "pidOf", "idle", "sample", "sampleStart", "window", "keys", "echo", "watch", "lag",
        "scroll", "cover", "screenshot", "prepareArena", "startReplay", "startCapture", "fault", "grade",
        "footprint", "purge", "gates", "contamination",
      ];
      for (const member of members) expect(typeof instruments[member]).toBe("function");
      expect(instruments.dryRun).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns fixed plausible values and records every call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-dry-"));
    try {
      const plan = join(dir, "plan.jsonl");
      const instruments = dryInstruments(plan);
      expect(instruments.dryRun).toBe(true);

      expect(await instruments.gates()).toEqual({
        swap_ok: true,
        swap_used_mb: 0,
        thermal_ok: true,
        cpu_quiet_ok: true,
        cpu_cores_used: 0.01,
      });
      const echo = await instruments.echo({
        pid: 1,
        triggers: [],
        region: REGION,
        probe: "ademarkqz",
        intervalMs: 50,
        timeoutS: 20,
        frames: join(dir, "frames.json"),
      });
      expect(echo.ready_ms).toBe(1200);
      expect(echo.settled_ms).toBe(1800);
      const watch = await instruments.watch({
        pid: 1,
        text: "LEDGERMARK",
        region: REGION,
        triggers: [],
        timeoutS: 20,
        frames: join(dir, "frames.json"),
      });
      expect(watch.ms).toBe(900);
      const lag = await instruments.lag({ pid: 1, region: REGION, count: 30, intervalMs: 250, frames: join(dir, "frames.json") });
      expect(lag.samples_ms.length).toBe(30);
      expect(lag.samples_ms.every((value) => value === 12)).toBe(true);
      expect({ p50: lag.p50, p95: lag.p95, lost: lag.lost }).toEqual({ p50: 12, p95: 12, lost: 0 });
      // Every probe keeps its slot in order, all measured (TESTS.md §1.3).
      expect(lag.probes_ms?.length).toBe(30);
      expect(lag.probes_ms?.every((value) => value === 12)).toBe(true);
      const sample = await instruments.sample({
        rules: { rootPids: [101], bundlePaths: [], vendorDirs: [], agentExecutables: [], excludeNames: [] },
        hz: 4,
        durationS: 3,
        csv: join(dir, "samples.csv"),
      });
      expect(sample.ticks).toBe(13);
      expect(sample.pids).toBe(8);
      const sampleRows = readSamples(join(dir, "samples.csv"));
      expect(sampleRows.length).toBe(sample.rows);
      expect(sampleRows.filter((row) => row.pid === 101 && row.group === "app").length).toBe(13);
      expect(sampleRows.filter((row) => row.group === "agents").length).toBe(65);
      const app = groupSeries(sampleRows, "app");
      expect(sample.app_median_b).toBe(Math.round(median(app.map((point) => point.bytes))));
      expect(sample.agents_median_b).toBe(150 * MIB);
      expect(sample.app_median_b).toBeGreaterThan(300 * MIB);
      expect(sample.app_median_b).toBeLessThan(300 * MIB + MIB);
      const scroll = await instruments.scroll({ pid: 1, region: REGION, count: 20, hz: 60, lines: 3, frames: join(dir, "frames.json") });
      expect({ gaps: scroll.gaps_over_33ms, max: scroll.max_gap_ms }).toEqual({ gaps: 0, max: 0 });
      const cover = await instruments.cover({ pid: 1, durationS: 20 });
      expect(Number(cover.closed_ns - cover.shown_ns)).toBe(20_000_000_000);
      const grade = await instruments.grade({ taskId: "C1-orchestrated-build", worktree: dir, out: join(dir, "grade.json"), handoffSeed: null });
      expect(grade.valid).toBe(true);
      expect(grade.groups.length).toBeGreaterThan(0);
      expect(grade.groups.every((group) => group.passed === group.total && group.failed.length === 0)).toBe(true);
      const contamination = await instruments.contamination({ replayPort: 8787, workdir: dir });
      expect(contamination.body_sha256).toMatch(/^[0-9a-f]{64}$/);
      await instruments.sleep(1000);

      const calls = planLines(plan).map((line) => line.call);
      for (const call of ["gates", "echo", "watch", "lag", "sample", "scroll", "cover", "grade", "contamination", "sleep"]) {
        expect(calls).toContain(call);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sampleStart writes 4 minutes and stop() returns the summary of those rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-dry-"));
    try {
      const csv = join(dir, "background.csv");
      const instruments = dryInstruments(join(dir, "plan.jsonl"));
      const handle = await instruments.sampleStart({
        rules: { rootPids: [7], bundlePaths: [], vendorDirs: [], agentExecutables: [], excludeNames: [] },
        hz: 4,
        csv,
      });
      const summary = await handle.stop();
      expect(summary.ticks).toBe(961);
      expect(summary.rows).toBe(7688);
      const app = groupSeries(readSamples(csv), "app");
      expect(app.length).toBe(961);
      // More than 3 full minutes, so A12 can publish its slope.
      expect(app[app.length - 1]!.t_ns - app[0]!.t_ns).toBeGreaterThan(3 * 60 * 1e9);
      expect(summary.app_median_b).toBe(Math.round(median(app.map((point) => point.bytes))));
      expect(summary.app_median_b).toBeGreaterThan(300 * MIB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idle and pidOf return their fixed values and appear in the plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-dry-"));
    try {
      const plan = join(dir, "plan.jsonl");
      const instruments = dryInstruments(plan);
      expect(await instruments.idle({ cpuCores: 0.1, quietMs: 2000, capS: 10 })).toEqual({
        waited_ms: 0,
        quiet: true,
        cores_last: 0,
      });
      expect(await instruments.pidOf("WindowServer")).toBe(88);
      const calls = planLines(plan).map((line) => line.call);
      expect(calls).toEqual(["idle", "pidOf"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same inputs give the same plan bytes, except now", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-dry-"));
    try {
      const run = async (plan: string): Promise<string[]> => {
        const instruments = dryInstruments(plan);
        await instruments.gates();
        await instruments.contamination({ replayPort: 8787, workdir: dir });
        await instruments.purge();
        return readFileSync(plan, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .filter((line) => !line.includes('"call":"now"'));
      };
      const first = await run(join(dir, "one.jsonl"));
      const second = await run(join(dir, "two.jsonl"));
      expect(second).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("now reads the real host clock and records it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-dry-"));
    try {
      const plan = join(dir, "plan.jsonl");
      const instruments = dryInstruments(plan);
      const now = instruments.now();
      expect(typeof now).toBe("bigint");
      expect(now).toBeGreaterThan(0n);
      const line = planLines(plan).find((entry) => entry.call === "now");
      expect(line?.args.t_ns).toBe(now.toString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TestContext", () => {
  test("row() fills the shared fields, dry run notes and a real receipt folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-ctx-"));
    try {
      const instruments = dryInstruments(join(dir, "plan.jsonl"));
      const writer = new RunWriter(dir).open("ctx-run");
      const adapter = makeFixtureAdapter();
      const ctx = createTestContext({
        runId: "ctx-run",
        runDir: writer.runDir,
        machineId: "machine-1",
        adapter,
        rowAde: adapter.id,
        track: "A",
        options: { model: null, effort: null, server: "replay", agent: "claude" },
        instruments,
        writer,
        adapterCtx: { runDir: writer.runDir, arenaPath: dir, worktree: dir, home: dir, env: {}, dryRun: true, log: () => {} },
        installed: { installed: true, version: "1.0.0", path: "/Applications/Fixture.app", binarySha256: "a".repeat(64) },
        freshArena: (label) =>
          instruments.prepareArena({ dest: join(dir, "arena", `${adapter.id}-${label}`), ref: "arena-v1" }),
        state: new Map(),
      });
      const fields: RowFields = {
        test_id: "A5",
        variant: "",
        rep: 1,
        server: "replay",
        value: 300,
        unit: "MB",
        duration_ms: 1000,
        valid: true,
        invalid_reason: null,
        receipts: { samples: null, video: null, frames: null, capture: null, log: null },
        notes: "",
      };
      const row = ctx.row(fields);
      expect(validateRow(row)).toEqual(row);
      expect(ctx.row({ ...fields, notes: "settle 20 s" }).notes).toBe("dry run; settle 20 s");
      expect(row.run_id).toBe("ctx-run");
      expect(row.machine_id).toBe("machine-1");
      expect(row.ade).toBe("fixture-ade");
      expect(row.ade_version).toBe("1.0.0");
      expect(row.ade_build_sha256).toBe("a".repeat(64));
      expect(row.family).toBe("EL-SDK");
      expect(row.drive).toBe("cdp");
      expect(row.model).toBeNull();
      // An empty runner note is just the dry marker; a non-empty one keeps its diagnostic after it.
      expect(row.notes).toBe("dry run");
      expect(ctx.receiptDir("A5", 1).endsWith("fixture-ade/A5/rep-01")).toBe(true);
      expect(row.valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a smoke row says so first, and keeps its own notes after the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-ctx-"));
    try {
      const instruments = { ...dryInstruments(join(dir, "plan.jsonl")), dryRun: false };
      const writer = new RunWriter(dir).open("ctx-smoke");
      const adapter = makeFixtureAdapter();
      const ctx = createTestContext({
        runId: "ctx-smoke",
        runDir: writer.runDir,
        machineId: "machine-1",
        adapter,
        rowAde: adapter.id,
        track: "A",
        options: { model: null, effort: null, server: "replay", agent: "claude" },
        instruments,
        writer,
        adapterCtx: { runDir: writer.runDir, arenaPath: dir, worktree: dir, home: dir, env: {}, dryRun: false, log: () => {} },
        installed: { installed: true, version: "1.0.0", path: null, binarySha256: null },
        freshArena: async () => dir,
        state: new Map(),
        smoke: true,
      });
      const fields: RowFields = {
        test_id: "A5",
        variant: "",
        rep: 1,
        server: "replay",
        value: 300,
        unit: "MB",
        duration_ms: 1000,
        valid: true,
        invalid_reason: null,
        receipts: { samples: null, video: null, frames: null, capture: null, log: null },
        notes: "settle 20 s",
      };
      expect(ctx.smoke).toBe(true);
      expect(ctx.row(fields).notes).toBe("smoke; settle 20 s");
      expect(ctx.row({ ...fields, notes: "" }).notes).toBe("smoke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Track B receipts add the agent before the repetition", () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-ctx-"));
    try {
      const instruments = dryInstruments(join(dir, "plan.jsonl"));
      const writer = new RunWriter(dir).open("ctx-b");
      const adapter = makeFixtureAdapter({ id: "bare-cli" });
      const ctx = createTestContext({
        runId: "ctx-b",
        runDir: writer.runDir,
        machineId: "machine-1",
        adapter,
        rowAde: "bare-cli-codex",
        track: "B",
        options: { model: "gpt-6.1-sol", effort: "high", server: "live", agent: "codex" },
        instruments,
        writer,
        adapterCtx: { runDir: writer.runDir, arenaPath: dir, worktree: dir, home: dir, env: {}, dryRun: true, log: () => {} },
        installed: { installed: true, version: "1.0.0", path: null, binarySha256: null },
        freshArena: async () => dir,
        state: new Map(),
      });
      expect(ctx.receiptDir("B1", 2).endsWith("bare-cli-codex/B1/codex/rep-02")).toBe(true);
      expect(ctx.receiptDir("B1", 3).endsWith("bare-cli-codex/B1/codex/rep-03")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("freshArena prepares a sibling arena through the instruments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-ctx-"));
    try {
      const plan = join(dir, "plan.jsonl");
      const instruments = dryInstruments(plan);
      const writer = new RunWriter(dir).open("ctx-arena");
      const adapter = makeFixtureAdapter();
      const ctx = createTestContext({
        runId: "ctx-arena",
        runDir: writer.runDir,
        machineId: "machine-1",
        adapter,
        rowAde: adapter.id,
        track: "C",
        options: { model: "claude-opus-5-5", effort: "high", server: "live", agent: "claude" },
        instruments,
        writer,
        adapterCtx: { runDir: writer.runDir, arenaPath: dir, worktree: dir, home: dir, env: {}, dryRun: true, log: () => {} },
        installed: { installed: true, version: "1.0.0", path: null, binarySha256: null },
        freshArena: (label) =>
          instruments.prepareArena({ dest: join(dir, "arena", `${adapter.id}-${label}`), ref: "arena-v1" }),
        state: new Map(),
      });
      const dest = await ctx.freshArena("C1");
      expect(dest.endsWith("fixture-ade-C1")).toBe(true);
      expect(planLines(plan).some((entry) => entry.call === "prepareArena" && entry.args.dest === dest)).toBe(true);
      await expect(ctx.freshArena("../escape")).rejects.toThrow(/unsafe label/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sampleRulesFor", () => {
  test("takes the roots and the adapter's process hints", () => {
    const adapter = makeFixtureAdapter();
    adapter.processes = () => ({
      bundlePaths: ["/Applications/One.app", "/Applications/Two.app"],
      vendorDirs: ["~/.fixture-vendor"],
      launchAgentLabels: [],
      teamId: null,
      agentExecutables: ["claude", "codex"],
    });
    const rules = sampleRulesFor(adapter, [77, 78]);
    expect(rules).toEqual({
      rootPids: [77, 78],
      bundlePaths: ["/Applications/One.app", "/Applications/Two.app"],
      vendorDirs: ["~/.fixture-vendor"],
      agentExecutables: ["claude", "codex"],
      excludeNames: [],
      harnessPids: [process.pid],
    });
  });
});
