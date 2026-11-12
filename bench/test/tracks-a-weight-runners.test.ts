import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRow } from "../core/results.ts";
import { BYTES_PER_MB } from "../run/kit.ts";
import { weighIn } from "../tracks/a-weight/a5-weigh-in.ts";
import { idleBurn } from "../tracks/a-weight/a6-idle-burn.ts";
import { fightWeight } from "../tracks/a-weight/a7-fight-weight.ts";
import { typingLag } from "../tracks/a-weight/a8-typing-lag.ts";
import { ghostWeight } from "../tracks/a-weight/a9-ghost-weight.ts";
import { scale } from "../tracks/a-weight/a10-scale.ts";
import { leak } from "../tracks/a-weight/a12-leak.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";
import {
  AGENT_EXE,
  APP_EXE,
  HELPER_EXE,
  MIB,
  WINDOW_SERVER,
  fakeWeightInstruments,
  makeWeightContext,
  weightAdapter,
  writeSampleCsv,
} from "./fixtures/tracks-a-weight/fixtures.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-weight-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function expectValidRows(rows: Awaited<ReturnType<typeof weighIn.runRep>>): void {
  for (const row of rows) expect(() => validateRow(row)).not.toThrow();
}

describe("A5 Weigh-in", () => {
  function fixtures(): { settle: string; window: string } {
    return {
      settle: writeSampleCsv(join(dir, "settle.csv"), {
        seconds: 20,
        rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 300 * MIB }],
      }),
      window: writeSampleCsv(join(dir, "window.csv"), {
        seconds: 60,
        rows: [
          { pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB, lifetimeMaxB: 210 * MIB },
          { pid: 101, ppid: 100, group: "app", exe: HELPER_EXE, bytes: 100 * MIB, lifetimeMaxB: 130 * MIB },
          { pid: 300, ppid: 100, group: "agents", exe: AGENT_EXE, bytes: 50 * MIB },
        ],
      }),
    };
  }

  test("writes app, main, dedup, windowserver-delta, then the agents kept alive and the total", async () => {
    const { settle, window } = fixtures();
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      sampleCsv: (_index, o) => (o.durationS === 60 ? window : settle),
      footprintB: (index) => [111 * MIB, 300 * MIB, 113 * MIB][index] ?? 0,
      procs: [WINDOW_SERVER],
    });
    const state = new Map<string, unknown>([["launch_pid", 100]]);
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, state });

    const rows = await weighIn.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.map((row) => row.variant)).toEqual([
      "app", "main", "dedup", "windowserver-delta", "agents", "agent-count", "total",
    ]);
    expect(rows.map((row) => row.unit)).toEqual(["MB", "MB", "MB", "MB", "MB", "count", "MB"]);
    expect(rows[4]!.value).toBeCloseTo(50, 9);
    expect(rows[5]!.value).toBe(1);
    expect(rows[6]!.value).toBeCloseTo(350, 9);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[0]!.value).toBeCloseTo(300, 9);
    expect(rows[1]!.value).toBeCloseTo(200, 9);
    expect(rows[2]!.value).toBeCloseTo(300, 9);
    expect(rows[3]!.value).toBeCloseTo(2, 9);
    expect(rows[0]!.notes).toContain("settle 20 s");
    expect(rows[0]!.receipts.samples).toBe("fixture-ade/A5/rep-01/samples.csv");
    expect(state.get("A5.app_median_b")).toBe(300 * MIB);
    expect(state.get("A5.samples_csv")).toBe(join(ctx.runDir, "fixture-ade", "A5", "rep-01", "samples.csv"));
    // procs() listed WindowServer, so the pgrep fallback was not needed.
    expect(fake.calls.some((call) => call.call === "pidOf")).toBe(false);
  });

  test("finds WindowServer with pidOf when procs does not list it", async () => {
    const { settle, window } = fixtures();
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      sampleCsv: (_index, o) => (o.durationS === 60 ? window : settle),
      // Call order: WindowServer start, dedup, WindowServer end.
      footprintB: (index) => [300 * MIB, 111 * MIB, 302 * MIB][index] ?? 0,
      procs: [],
      pidOf: async () => 88,
    });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await weighIn.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[2]!.value).toBeCloseTo(111, 9);
    expect(rows[3]!.value).toBeCloseTo(2, 9);
    // One lookup per reading: before and after the window.
    expect(fake.calls.filter((call) => call.call === "pidOf").length).toBe(2);
  });

  test("a missing WindowServer reading invalidates the row instead of writing 0", async () => {
    const { settle, window } = fixtures();
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      sampleCsv: (_index, o) => (o.durationS === 60 ? window : settle),
      procs: [],
      pidOf: async () => null,
    });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await weighIn.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.slice(0, 3).every((row) => row.valid)).toBe(true);
    const delta = rows[3]!;
    expect(delta.variant).toBe("windowserver-delta");
    expect(delta.valid).toBe(false);
    expect(delta.value).toBeNull();
    expect(delta.invalid_reason).toBe(
      "windowserver not measured: procs and pgrep found no WindowServer",
    );
    expect(rows[0]!.notes).toContain("procs and pgrep found no WindowServer");
  });

  test("a growing app series never settles, and the run says so", async () => {
    const { window } = fixtures();
    const chunks = Array.from({ length: 30 }, (_, index) =>
      writeSampleCsv(join(dir, `rise-${index}.csv`), {
        seconds: 20,
        t0Ns: index * 20e9,
        rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: (300 + (5 * index * 20) / 60) * MIB, mbPerMin: 5 }],
      }),
    );
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      sampleCsv: (index, o) => (o.durationS === 60 ? window : chunks[index]!),
    });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await weighIn.runRep(ctx, 1);
    expect(rows[0]!.notes).toContain("did not settle");
    expect(rows[0]!.notes).toContain("600 s");
    expect(fake.calls.filter((call) => call.call === "sample").length).toBe(31);
  });

  test("swap that grows invalidates every row, and a dry run keeps its note", async () => {
    const { settle, window } = fixtures();
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      sampleCsv: (_index, o) => (o.durationS === 60 ? window : settle),
      gates: (index) => ({
        swap_ok: index === 0,
        swap_used_mb: index === 0 ? 0 : 2,
        thermal_ok: true,
        cpu_quiet_ok: true,
        cpu_cores_used: 0.01,
      }),
    });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await weighIn.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.length).toBe(7);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "swap grew")).toBe(true);
    // The dry marker keeps the runner's own diagnostic instead of hiding it.
    expect(rows[0]!.notes.startsWith("dry run; ")).toBe(true);
    expect(rows[0]!.notes).toContain("settle 20 s");
  });
});

describe("A6 Idle Burn", () => {
  test("front and covered CPU, wakeups and energy, with a -1 counter skipped", async () => {
    const front = writeSampleCsv(join(dir, "front.csv"), {
      seconds: 60,
      rows: [
        { pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB, cpuNsPerS: 1e9, wakeupsPerS: 10, energyNjPerS: 2e6 },
        { pid: 101, group: "app", exe: HELPER_EXE, bytes: 100 * MIB, cpuNsPerS: 0.5e9, wakeupsPerS: 5, energyUnreadable: true },
      ],
    });
    const covered = writeSampleCsv(join(dir, "covered.csv"), {
      seconds: 60,
      rows: [
        { pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB, cpuNsPerS: 0.25e9, wakeupsPerS: 2, energyNjPerS: 1e6 },
      ],
    });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      sampleCsv: () => covered,
    });
    const state = new Map<string, unknown>([
      ["launch_pid", 100],
      ["A5.samples_csv", front],
      ["A5.samples_rel", "fixture-ade/A5/rep-01/samples.csv"],
    ]);
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, state });

    const rows = await idleBurn.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.map((row) => row.variant)).toEqual([
      "front",
      "covered",
      "front-wakeups",
      "covered-wakeups",
      "front-energy",
      "covered-energy",
    ]);
    expect(rows.map((row) => row.unit)).toEqual(["%", "%", "per s", "per s", "mW", "mW"]);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[0]!.value).toBeCloseTo(150, 9);
    expect(rows[1]!.value).toBeCloseTo(25, 9);
    expect(rows[2]!.value).toBeCloseTo(15, 9);
    expect(rows[3]!.value).toBeCloseTo(2, 9);
    expect(rows[4]!.value).toBeCloseTo(2, 9);
    expect(rows[5]!.value).toBeCloseTo(1, 9);
    expect(rows[0]!.notes).toContain("energy_nj -1 on 1/2 pids");
    expect(rows[0]!.receipts.samples).toBe("fixture-ade/A5/rep-01/samples.csv");
    expect(rows[1]!.receipts.samples).toBe("fixture-ade/A6/rep-01/samples.csv");
    expect(fake.calls.filter((call) => call.call === "cover").length).toBe(1);
  });

  test("without A5 samples every row is invalid and nothing is measured", async () => {
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments });

    const rows = await idleBurn.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.length).toBe(6);
    expect(rows.every((row) => row.invalid_reason === "no A5 samples")).toBe(true);
    expect(fake.calls.filter((call) => call.call === "sample").length).toBe(0);
  });
});

describe("A7 Fight Weight", () => {
  test("app, agents and total p95 plus app-peak over a 3 minute window", async () => {
    const csv = writeSampleCsv(join(dir, "fight.csv"), {
      seconds: 180,
      rows: [
        { pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB, lifetimeMaxB: 210 * MIB },
        { pid: 101, group: "app", exe: HELPER_EXE, bytes: 100 * MIB, lifetimeMaxB: 130 * MIB },
        ...Array.from({ length: 5 }, (_, index) => ({
          pid: 300 + index,
          ppid: 100,
          group: "agents" as const,
          exe: AGENT_EXE,
          bytes: 50 * MIB,
        })),
      ],
    });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      sampleCsv: () => csv,
    });
    const adapter = weightAdapter();
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await fightWeight.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.map((row) => row.variant)).toEqual([
      "app-p95", "agents-p95", "total-p95", "app-peak", "per-agent-p95", "agent-count",
    ]);
    expect(rows.map((row) => row.unit)).toEqual(["MB", "MB", "MB", "MB", "MB", "count"]);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[0]!.value).toBeCloseTo(300, 9);
    expect(rows[1]!.value).toBeCloseTo(250, 9);
    expect(rows[2]!.value).toBeCloseTo(550, 9);
    expect(rows[3]!.value).toBeCloseTo(340, 9);
    expect(rows[4]!.value).toBeCloseTo(50, 9);
    expect(rows[5]!.value).toBe(5);
    expect(rows[0]!.notes).toContain("721 ticks with >= 5 agents");
    expect(rows[0]!.notes).toContain(`agent executables: ${AGENT_EXE}`);
    expect(fake.calls.filter((call) => call.call === "footprint").length).toBe(1);
  });

  test("fewer than 5 agents for 150 s invalidates the rows", async () => {
    const csv = writeSampleCsv(join(dir, "fight.csv"), {
      seconds: 180,
      rows: [
        { pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB },
        ...Array.from({ length: 4 }, (_, index) => ({
          pid: 300 + index,
          group: "agents" as const,
          exe: AGENT_EXE,
          bytes: 50 * MIB,
        })),
      ],
    });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false, sampleCsv: () => csv });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter: weightAdapter(),
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await fightWeight.runRep(ctx, 1);
    expect(rows.length).toBe(6);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "fewer than 5 agents for 150 s")).toBe(true);
  });

  test("a missing newThread calibration gives invalid rows and no measurement", async () => {
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, adapter: makeFixtureAdapter() });

    const rows = await fightWeight.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.length).toBe(6);
    expect(rows.every((row) => row.invalid_reason === "not calibrated: newThread")).toBe(true);
    expect(fake.calls.length).toBe(0);
  });
});

describe("A8 Typing Lag", () => {
  test("writes p50, p95, max and missed from the lag probes", async () => {
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      lag: { samples_ms: [10, 12, 40, 8], p50: 11, p95: 40, lost: 1 },
    });
    const adapter = weightAdapter();
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await typingLag.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.map((row) => row.variant)).toEqual(["p50", "p95", "max", "missed"]);
    expect(rows.map((row) => row.unit)).toEqual(["ms", "ms", "ms", "count"]);
    expect(rows.map((row) => row.value)).toEqual([11, 40, 40, 1]);
    expect(rows[0]!.receipts.frames).toBe("fixture-ade/A8/rep-01/frames.json");

    const lag = fake.calls.find((call) => call.call === "lag");
    expect(lag?.args.count).toBe(60);
    expect(lag?.args.intervalMs).toBe(250);
    expect(lag?.args.region).toEqual(adapter.calibration.composerRect!);
  });

  test("a missing composerRect gives invalid rows and no lag probe", async () => {
    const adapter = weightAdapter();
    adapter.calibration.composerRect = null;
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, adapter });

    const rows = await typingLag.runRep(ctx, 1);
    expect(rows.length).toBe(4);
    expect(rows.every((row) => row.invalid_reason === "not calibrated: composerRect")).toBe(true);
    expect(fake.calls.length).toBe(0);
  });
});

describe("A9 Ghost Weight", () => {
  test("measures the total after quit, lists the processes and relaunches", async () => {
    const ghost = writeSampleCsv(join(dir, "ghost.csv"), {
      seconds: 1,
      rows: [
        { pid: 500, group: "app", exe: APP_EXE, bytes: 100 * MIB },
        { pid: 501, group: "app", exe: "/usr/local/bin/fixture-daemon", bytes: 20 * MIB },
      ],
    });
    const calls: string[] = [];
    const adapter = weightAdapter({ onCall: (call) => calls.push(call) });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false, sampleCsv: () => ghost });
    const state = new Map<string, unknown>([["launch_pid", 4242]]);
    const { ctx, runDir } = makeWeightContext({ root: dir, instruments: fake.instruments, adapter, state });

    const rows = await ghostWeight.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.map((row) => row.variant)).toEqual(["no-sessions", "sessions-kept"]);
    expect(rows.every((row) => row.unit === "MB" && row.valid)).toBe(true);
    expect(rows[0]!.value).toBeCloseTo(120, 9);
    expect(rows[1]!.value).toBeCloseTo(120, 9);
    expect(rows[0]!.receipts.samples).toBe("fixture-ade/A9/rep-01/samples-no-sessions.csv");
    expect(rows[1]!.receipts.samples).toBe("fixture-ade/A9/rep-01/samples-sessions-kept.csv");
    expect(state.get("launch_pid")).toBe(4242);
    expect(calls.filter((call) => call === "adapter.quit").length).toBe(2);
    expect(calls.filter((call) => call === "adapter.launch").length).toBe(2);
    expect(calls).toContain("adapter.send");

    const listed: unknown = JSON.parse(readFileSync(join(runDir, "fixture-ade/A9/rep-01/processes-no-sessions.json"), "utf8"));
    expect(listed).toEqual([
      { pid: 500, name: "Fixture" },
      { pid: 501, name: "fixture-daemon" },
    ]);

    const second = await ghostWeight.runRep(ctx, 2);
    expect(second.map((row) => row.variant)).toEqual(["no-sessions"]);
  });

  test("the sessions-kept variant needs a calibrated newThread", async () => {
    const ghost = writeSampleCsv(join(dir, "ghost.csv"), {
      seconds: 1,
      rows: [{ pid: 500, group: "app", exe: APP_EXE, bytes: 100 * MIB }],
    });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false, sampleCsv: () => ghost });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter: makeFixtureAdapter(),
      state: new Map<string, unknown>([["launch_pid", 4242]]),
    });

    const rows = await ghostWeight.runRep(ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.value).toBeCloseTo(100, 9);
    expect(rows[1]!.variant).toBe("sessions-kept");
    expect(rows[1]!.valid).toBe(false);
    expect(rows[1]!.invalid_reason).toBe("not calibrated: newThread");
  });
});

describe("A10 Scale", () => {
  test("rest median, MB per thread and lag p95 with 20 threads", async () => {
    const rest = writeSampleCsv(join(dir, "rest.csv"), {
      seconds: 60,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 400 * MIB }],
    });
    const calls: string[] = [];
    const adapter = weightAdapter({
      onCall: (call, args) => calls.push(call === "adapter.send" ? `send:${String(args.text)}` : call),
    });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), {
      dryRun: false,
      sampleCsv: () => rest,
      lag: { samples_ms: [20, 30, 33], p50: 25, p95: 33, lost: 0 },
    });
    const state = new Map<string, unknown>([
      ["launch_pid", 100],
      ["A5.app_median_b", 280 * MIB],
    ]);
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, adapter, state });

    const rows = await scale.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.map((row) => row.variant)).toEqual(["rest-20", "mb-per-thread", "lag-p95-20"]);
    expect(rows.map((row) => row.unit)).toEqual(["MB", "MB", "ms"]);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[0]!.value).toBeCloseTo(400, 9);
    expect(rows[1]!.value).toBeCloseTo(8, 9);
    expect(rows[2]!.value).toBeCloseTo(33, 9);
    expect(rows[2]!.receipts.frames).toBe("fixture-ade/A10/rep-01/frames.json");
    expect(calls.filter((call) => call === "adapter.newThread").length).toBe(20);
    expect(calls.filter((call) => call === "send:replay:seed").length).toBe(15);
    expect(calls.filter((call) => call.startsWith("send:replay:stream-")).length).toBe(5);
    expect(calls).toContain("send:replay:stream-1");
  });

  test("a missing composerRect gives invalid rows and calls no instrument", async () => {
    const adapter = weightAdapter();
    adapter.calibration.composerRect = null;
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, adapter });

    const rows = await scale.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.length).toBe(3);
    expect(rows.map((row) => row.unit)).toEqual(["MB", "MB", "ms"]);
    expect(rows.every((row) => row.invalid_reason === "not calibrated: composerRect")).toBe(true);
    expect(fake.calls.length).toBe(0);
  });

  test("without an A5 value only mb-per-thread is invalid", async () => {
    const rest = writeSampleCsv(join(dir, "rest.csv"), {
      seconds: 60,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 400 * MIB }],
    });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false, sampleCsv: () => rest });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter: weightAdapter(),
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await scale.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[1]!.valid).toBe(false);
    expect(rows[1]!.value).toBeNull();
    expect(rows[1]!.invalid_reason).toBe("no A5 value");
    expect(rows[2]!.valid).toBe(true);
  });
});

describe("A12 Leak", () => {
  function line(
    minutes: number,
    mbPerHour: number,
    options: { noiseMb?: number; minuteMb?: (minute: number) => number } = {},
  ): string {
    return writeSampleCsv(join(dir, `leak-${minutes}-${mbPerHour}.csv`), {
      seconds: minutes * 60,
      rows: [
        {
          pid: 100,
          group: "app",
          exe: APP_EXE,
          bytes: 300 * MIB,
          mbPerMin: mbPerHour / 60,
          noiseMb: options.noiseMb ?? 0.4,
          minuteMb: options.minuteMb,
        },
      ],
    });
  }

  test("writes the MB/h slope with an interval fitted on one point per minute", async () => {
    const csv = line(45, 120, { noiseMb: 4 });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      track: "C",
      options: { model: "claude-opus-5-5", effort: "high", server: "live", agent: "claude" },
      state: new Map<string, unknown>([["C.samples_csv", csv]]),
    });

    const rows = await leak.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.length).toBe(1);
    expect(rows[0]!.variant).toBe("slope");
    expect(rows[0]!.unit).toBe("MB/h");
    expect(rows[0]!.server).toBe("live");
    expect(rows[0]!.valid).toBe(true);
    expect(Math.abs(rows[0]!.value! - 120)).toBeLessThan(6);
    const notes = JSON.parse(rows[0]!.notes) as {
      lo: number;
      hi: number;
      minutes: number;
      ticks: number;
      points: number;
      window?: string;
    };
    expect(notes.minutes).toBe(30);
    expect(notes.ticks).toBe(7201);
    expect(notes.points).toBe(30);
    expect(notes.lo).toBeGreaterThan(0);
    expect(notes.hi).toBeGreaterThan(rows[0]!.value!);
    expect(notes.window).toBeUndefined();
  });

  test("a flat series with large tick-level noise gives an interval that contains 0", async () => {
    const csv = line(30, 0, { noiseMb: 6, minuteMb: (minute) => (minute % 2 === 0 ? 6 : -6) });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      track: "C",
      state: new Map<string, unknown>([["C.samples_csv", csv]]),
    });

    const rows = await leak.runRep(ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    const notes = JSON.parse(rows[0]!.notes) as { lo: number; hi: number; points: number };
    expect(notes.points).toBe(30);
    expect(notes.lo).toBeLessThanOrEqual(0);
    expect(notes.hi).toBeGreaterThanOrEqual(0);
  });

  test("a block shorter than 30 minutes notes its window", async () => {
    const csv = line(10, 5);
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      track: "C",
      state: new Map<string, unknown>([["C.samples_csv", csv]]),
    });

    const rows = await leak.runRep(ctx, 1);
    const notes = JSON.parse(rows[0]!.notes) as { minutes: number; points: number; window?: string };
    expect(rows[0]!.valid).toBe(true);
    expect(notes.minutes).toBe(10);
    expect(notes.points).toBe(10);
    expect(notes.window).toBe("10 min");
  });

  test("two minutes are fewer than the three the interval needs", async () => {
    const csv = line(2, 5);
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      track: "C",
      state: new Map<string, unknown>([["C.samples_csv", csv]]),
    });

    const rows = await leak.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.length).toBe(1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.value).toBeNull();
    expect(rows[0]!.invalid_reason).toBe("fewer than 3 minutes of samples");
  });

  test("no Track C samples is invalid and calls no instrument", async () => {
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, track: "C" });

    const rows = await leak.runRep(ctx, 1);
    expectValidRows(rows);
    expect(rows.length).toBe(1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.value).toBeNull();
    expect(rows[0]!.invalid_reason).toBe("no Track C samples");
    expect(fake.calls.length).toBe(0);
  });

  test("a single tick is no window", async () => {
    const csv = writeSampleCsv(join(dir, "one-tick.csv"), {
      seconds: 0,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 300 * MIB }],
    });
    const fake = fakeWeightInstruments(join(dir, "plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      track: "C",
      state: new Map<string, unknown>([["C.samples_csv", csv]]),
    });

    const rows = await leak.runRep(ctx, 1);
    expect(rows[0]!.invalid_reason).toBe("no Track C samples");
  });
});

describe("repeats and extra runs", () => {
  test("the seven runners declare the runs of TESTS.md", () => {
    expect([weighIn, idleBurn, fightWeight, typingLag, ghostWeight, scale, leak].map((runner) => runner.id)).toEqual([
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "A10",
      "A12",
    ]);
    expect(ghostWeight.repeats({} as never)).toBe(3);
    expect([weighIn, idleBurn, fightWeight, typingLag, scale].map((runner) => runner.repeats({} as never))).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(leak.track).toBe("C");
    expect(leak.maxExtraRuns).toBe(0);
  });

  test("BYTES_PER_MB is the MB unit every RAM row uses", () => {
    expect(BYTES_PER_MB).toBe(1_048_576);
  });
});

describe("smoke mode durations", () => {
  function plan(file: string): Array<{ call: string; args: Record<string, unknown> }> {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { call: string; args: Record<string, unknown> });
  }

  test("A5 samples a 20 s settle cap and a 5 s window", async () => {
    const planPath = join(dir, "a5-plan.jsonl");
    const settle = writeSampleCsv(join(dir, "a5-settle.csv"), {
      seconds: 20,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 300 * MIB }],
    });
    const window = writeSampleCsv(join(dir, "a5-window.csv"), {
      seconds: 5,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 300 * MIB }],
    });
    const fake = fakeWeightInstruments(planPath, {
      dryRun: false,
      sampleCsv: (_index, o) => (o.durationS === 5 ? window : settle),
    });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      smoke: true,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await weighIn.runRep(ctx, 1);
    expect(rows.map((row) => row.variant)).toEqual([
      "app", "main", "dedup", "windowserver-delta", "agents", "agent-count", "total",
    ]);
    const durations = fake.calls.filter((call) => call.call === "sample").map((call) => call.args.durationS);
    expect(durations).toEqual([20, 5]);
  });

  test("A6 covers for 7 s, waits 2 s and samples for 5 s", async () => {
    const planPath = join(dir, "a6-plan.jsonl");
    const front = writeSampleCsv(join(dir, "a6-front.csv"), {
      seconds: 5,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB }],
    });
    const covered = writeSampleCsv(join(dir, "a6-covered.csv"), {
      seconds: 5,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB }],
    });
    const fake = fakeWeightInstruments(planPath, { dryRun: false, sampleCsv: () => covered });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      smoke: true,
      state: new Map<string, unknown>([
        ["launch_pid", 100],
        ["A5.samples_csv", front],
        ["A5.samples_rel", "fixture-ade/A5/rep-01/samples.csv"],
      ]),
    });

    await idleBurn.runRep(ctx, 1);
    const cover = fake.calls.find((call) => call.call === "cover");
    expect(cover?.args.durationS).toBe(7);
    expect(fake.calls.filter((call) => call.call === "sample").map((call) => call.args.durationS)).toEqual([5]);
    expect(plan(planPath).some((entry) => entry.call === "sleep" && entry.args.ms === 2000)).toBe(true);
  });

  test("A7 uses a 20 s window and scales the 150 s agent threshold with it", async () => {
    const csv = writeSampleCsv(join(dir, "a7-smoke.csv"), {
      seconds: 20,
      rows: [
        { pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB },
        ...Array.from({ length: 5 }, (_, index) => ({
          pid: 300 + index,
          group: "agents" as const,
          exe: AGENT_EXE,
          bytes: 50 * MIB,
        })),
      ],
    });
    const fake = fakeWeightInstruments(join(dir, "a7-plan.jsonl"), { dryRun: false, sampleCsv: () => csv });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter: weightAdapter(),
      smoke: true,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await fightWeight.runRep(ctx, 1);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(fake.calls.find((call) => call.call === "sample")?.args.durationS).toBe(20);
    expect(rows[0]!.notes).toContain("81 ticks with >= 5 agents");
    // The five stream gaps shrink with the window, so the whole smoke test stays quick.
    const gaps = plan(join(dir, "a7-plan.jsonl")).filter((entry) => entry.call === "sleep" && entry.args.ms === 500);
    expect(gaps.length).toBe(5);
  });

  test("A7 invalidates a 20 s smoke window with too few agents for 17 s", async () => {
    const csv = writeSampleCsv(join(dir, "a7-short.csv"), {
      seconds: 20,
      rows: [
        { pid: 100, group: "app", exe: APP_EXE, bytes: 200 * MIB },
        ...Array.from({ length: 4 }, (_, index) => ({
          pid: 300 + index,
          group: "agents" as const,
          exe: AGENT_EXE,
          bytes: 50 * MIB,
        })),
      ],
    });
    const fake = fakeWeightInstruments(join(dir, "a7-plan.jsonl"), { dryRun: false, sampleCsv: () => csv });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter: weightAdapter(),
      smoke: true,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    const rows = await fightWeight.runRep(ctx, 1);
    expect(rows.every((row) => row.invalid_reason === "fewer than 5 agents for 17 s")).toBe(true);
  });

  test("A8 probes ten times at the same cadence", async () => {
    const fake = fakeWeightInstruments(join(dir, "a8-plan.jsonl"), { dryRun: false });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter: weightAdapter(),
      smoke: true,
      state: new Map<string, unknown>([["launch_pid", 100]]),
    });

    await typingLag.runRep(ctx, 1);
    const lag = fake.calls.find((call) => call.call === "lag");
    expect(lag?.args.count).toBe(10);
    expect(lag?.args.intervalMs).toBe(250);
  });

  test("A9 waits 5 s after quit", async () => {
    const planPath = join(dir, "a9-plan.jsonl");
    const ghost = writeSampleCsv(join(dir, "a9-ghost.csv"), {
      seconds: 1,
      rows: [{ pid: 500, group: "app", exe: APP_EXE, bytes: 100 * MIB }],
    });
    const fake = fakeWeightInstruments(planPath, { dryRun: false, sampleCsv: () => ghost });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter: weightAdapter(),
      smoke: true,
      state: new Map<string, unknown>([["launch_pid", 4242]]),
    });

    const rows = await ghostWeight.runRep(ctx, 1);
    expect(rows.map((row) => row.variant)).toEqual(["no-sessions", "sessions-kept"]);
    expect(rows.every((row) => row.notes.includes("5 s after quit"))).toBe(true);
    const waits = plan(planPath).filter((entry) => entry.call === "sleep").map((entry) => entry.args.ms);
    // Two 5 s ghost waits and the 5 s session lead of the sessions-kept variant.
    expect(waits.filter((ms) => ms === 5000).length).toBe(3);
  });

  test("A10 adds 3 threads and samples a 5 s window", async () => {
    const planPath = join(dir, "a10-plan.jsonl");
    const rest = writeSampleCsv(join(dir, "a10-rest.csv"), {
      seconds: 5,
      rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 400 * MIB }],
    });
    const calls: string[] = [];
    const adapter = weightAdapter({
      onCall: (call, args) => calls.push(call === "adapter.send" ? `send:${String(args.text)}` : call),
    });
    const fake = fakeWeightInstruments(planPath, { dryRun: false, sampleCsv: () => rest });
    const { ctx } = makeWeightContext({
      root: dir,
      instruments: fake.instruments,
      adapter,
      smoke: true,
      state: new Map<string, unknown>([
        ["launch_pid", 100],
        ["A5.app_median_b", 280 * MIB],
      ]),
    });

    await scale.runRep(ctx, 1);
    expect(fake.calls.find((call) => call.call === "sample")?.args.durationS).toBe(5);
    expect(calls.filter((call) => call === "send:replay:seed").length).toBe(3);
    expect(calls.filter((call) => call === "adapter.newThread").length).toBe(8);
  });
});
