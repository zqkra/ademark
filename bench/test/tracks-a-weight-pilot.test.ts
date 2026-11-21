import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeProc } from "../core/contracts.ts";
import { loadRunners } from "../run/registry.ts";
import { focusIdle } from "../tracks/a-weight/a13-focus-idle.ts";
import { backgroundStreams } from "../tracks/a-weight/a14-background-streams.ts";
import { firstStreamEndNs } from "../tracks/a-weight/shared.ts";
import { AGENT_EXE, APP_EXE, MIB, fakeWeightInstruments, makeWeightContext, weightAdapter, writeSampleCsv } from "./fixtures/tracks-a-weight/fixtures.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-pilot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const APP_PROC: NativeProc = { pid: 100, ppid: 1, path: APP_EXE, name: "Example", responsible_pid: null };

function plan(file: string): Array<{ call: string; args: Record<string, unknown> }> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { call: string; args: Record<string, unknown> });
}

function idleCsv(name: string, cpuNsPerS: number, wakeupsPerS: number): string {
  return writeSampleCsv(join(dir, name), {
    seconds: 60,
    rows: [{ pid: 100, group: "app", exe: APP_EXE, bytes: 300 * MIB, cpuNsPerS, wakeupsPerS, energyNjPerS: 1e6 }],
  });
}

describe("pilot tests", () => {
  test("load only when asked, so nights, gates and Control never run them", async () => {
    const plain = await loadRunners();
    expect(plain.has("A13")).toBe(false);
    expect(plain.has("A14")).toBe(false);
    const pilot = await loadRunners(undefined, { pilot: true });
    expect(pilot.get("A13")?.track).toBe("A");
    expect(pilot.get("A14")?.track).toBe("A");
  });
});

describe("A13 Focus Idle", () => {
  function run(blurClick: { x: number; y: number } | null) {
    const settle = idleCsv("settle.csv", 0, 0);
    const focused = idleCsv("focused.csv", 0.08e9, 30);
    const blurred = idleCsv("blurred.csv", 0.01e9, 4);
    const planPath = join(dir, "plan.jsonl");
    const fake = fakeWeightInstruments(planPath, {
      dryRun: false,
      procs: [APP_PROC],
      sampleCsv: (_index, o) => (o.csv.endsWith("samples-focused.csv") ? focused : o.csv.endsWith("samples-blurred.csv") ? blurred : settle),
    });
    const adapter = weightAdapter();
    adapter.calibration.blurClick = blurClick;
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, adapter, state: new Map([["launch_pid", 100]]) });
    return { ctx, planPath, fake };
  }

  test("focused and blurred CPU, wakeups and energy, each from its own window", async () => {
    const { ctx, planPath } = run({ x: 40, y: 500 });
    const rows = await focusIdle.runRep(ctx, 1);
    expect(rows.map((row) => row.variant)).toEqual([
      "focused-cpu", "focused-wakeups", "focused-energy", "blurred-cpu", "blurred-wakeups", "blurred-energy",
    ]);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows.map((row) => row.value)).toEqual([
      expect.closeTo(8, 6), expect.closeTo(30, 6), expect.closeTo(1, 6),
      expect.closeTo(1, 6), expect.closeTo(4, 6), expect.closeTo(1, 6),
    ]);
    // The app was still running, so it was not launched again; the composer centre is the focus point without focusClick.
    const steps = plan(planPath).filter((entry) => ["click", "echo", "sample"].includes(entry.call) && entry.args.durationS !== 20);
    expect(steps.map((entry) => `${entry.call}${entry.call === "click" ? ` ${JSON.stringify(entry.args.at)}` : ""}`)).toEqual([
      'click {"x":700,"y":860}',
      "echo",
      "sample",
      'click {"x":40,"y":500}',
      "sample",
      'click {"x":700,"y":860}',
    ]);
    expect(rows[0]!.notes).toContain("app already running");
  });

  test("without blurClick only the focused rows are written", async () => {
    const { ctx } = run(null);
    const rows = await focusIdle.runRep(ctx, 1);
    expect(rows.map((row) => row.variant)).toEqual(["focused-cpu", "focused-wakeups", "focused-energy"]);
    expect(rows[0]!.notes).toContain("blurred: not calibrated: blurClick");
  });

  test("a composer that never shows the probe gives no focused window", async () => {
    const { ctx, fake } = run(null);
    ctx.instruments.echo = async () => ({ t0_ns: 0, ready_ns: null, ready_ms: null, settled_ms: null, frames: 0, timed_out: true });
    const rows = await focusIdle.runRep(ctx, 1);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "the composer did not show typing after the focus click")).toBe(true);
    expect(fake.calls.filter((call) => call.call === "sample" && String(call.args.csv).endsWith("samples-focused.csv"))).toHaveLength(0);
  });
});

describe("A14 Background Streams", () => {
  function streamCsv(name: string, appCpu: number): string {
    return writeSampleCsv(join(dir, name), {
      seconds: 45,
      rows: [
        { pid: 100, group: "app", exe: APP_EXE, bytes: 300 * MIB, cpuNsPerS: appCpu, wakeupsPerS: 10, energyNjPerS: 1e6 },
        ...Array.from({ length: 5 }, (_, index) => ({
          pid: 300 + index,
          ppid: 100,
          group: "agents" as const,
          exe: AGENT_EXE,
          bytes: 50 * MIB,
          cpuNsPerS: 0.1e9,
        })),
      ],
    });
  }

  function run() {
    const front = streamCsv("front.csv", 0.6e9);
    const background = streamCsv("background.csv", 0.05e9);
    const planPath = join(dir, "plan.jsonl");
    const fake = fakeWeightInstruments(planPath, {
      dryRun: false,
      procs: [APP_PROC],
      sampleCsv: (_index, o) => (o.csv.endsWith("samples-front.csv") ? front : background),
    });
    const adapter = weightAdapter();
    adapter.timed.shortThread = [{ kind: "keys", combo: "cmd+1" }];
    const { ctx } = makeWeightContext({ root: dir, instruments: fake.instruments, adapter, state: new Map([["launch_pid", 100]]) });
    return { ctx, planPath };
  }

  test("app CPU with a streaming thread in front, then with a seeded thread in front", async () => {
    const { ctx, planPath } = run();
    const rows = await backgroundStreams.runRep(ctx, 1);
    const value = (variant: string) => rows.find((row) => row.variant === variant)!.value;
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(value("front-cpu")).toBeCloseTo(60, 6);
    expect(value("background-cpu")).toBeCloseTo(5, 6);
    // The agents carried the same load in both windows, so the drop is the app's own.
    expect(value("front-agents-cpu")).toBeCloseTo(50, 6);
    expect(value("background-agents-cpu")).toBeCloseTo(50, 6);
    expect(value("agent-count")).toBe(5);
    const watch = plan(planPath).find((entry) => entry.call === "watch")!;
    expect(watch.args.text).toBe("unchanged");
    expect(watch.args.triggers).toEqual([{ kind: "keys", combo: "cmd+1" }]);
  });

  test("a seeded thread that never shows leaves the background rows invalid", async () => {
    const { ctx } = run();
    ctx.instruments.watch = async () => ({ t0_ns: 0, seen_ns: null, ms: null, timed_out: true, seen_text: null });
    const rows = await backgroundStreams.runRep(ctx, 1);
    const background = rows.filter((row) => row.variant.startsWith("background-"));
    expect(background).toHaveLength(4);
    expect(background.every((row) => row.invalid_reason === "no seeded thread came to the front")).toBe(true);
    expect(rows.filter((row) => row.variant.startsWith("front-")).every((row) => row.valid)).toBe(true);
  });

  test("the first stream to start is the first to end", () => {
    const s = 1e9;
    // Streams 2 to 5 and 1 started at 100, 104, 108, 112 and 116 s; an earlier block's stream at 10 s does not count.
    const log = [JSON.stringify({ t_ns: 10 * s, session: "stream-1" })]
      .concat([2, 3, 4, 5, 1].map((stream, index) => JSON.stringify({ t_ns: (100 + 4 * index) * s, session: `stream-${stream}` })))
      .join("\n");
    expect(firstStreamEndNs(log, 50 * s)).toBe(280 * s);
    expect(firstStreamEndNs(log, 105 * s)).toBeNull();
  });
});
