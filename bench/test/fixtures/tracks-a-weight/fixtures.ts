// Fixtures for the Track A weight runner tests: synthetic sampler CSVs, a calibrated ADE and a
// recording `Instruments` that hands every `sample` call a fixture CSV.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter, NativeLag, NativeProc, RunOptions } from "../../../core/contracts.ts";
import { SAMPLE_COLUMNS } from "../../../core/contracts.ts";
import type { Gates } from "../../../core/gates.ts";
import type { SampleOptions } from "../../../core/native.ts";
import { RunWriter } from "../../../core/results.ts";
import { createTestContext, type TestContext } from "../../../run/context.ts";
import { dryInstruments } from "../../../run/dry.ts";
import type { Instruments } from "../../../run/instruments.ts";
import { BYTES_PER_MB } from "../../../run/kit.ts";
import type { TrackLetter } from "../../../run/registry.ts";
import { makeFixtureAdapter, type FixtureAdapterOptions } from "../run/adapter.ts";

export const MIB = 1024 * 1024;
export const APP_EXE = "/Applications/Fixture.app/Contents/MacOS/Fixture";
export const HELPER_EXE = "/Applications/Fixture.app/Contents/Frameworks/Fixture Helper";
export const AGENT_EXE = "/usr/local/bin/claude";

export interface RowSpec {
  pid: number;
  ppid?: number;
  group: "app" | "agents" | "system";
  exe: string;
  bytes: number;
  /** Footprint growth in MB per minute of wall time. */
  mbPerMin?: number;
  /** Deterministic wobble in MB, so a fitted slope has residuals and a real interval. */
  noiseMb?: number;
  /** A per-minute offset in MB (0 is the first minute), for minute-level noise. */
  minuteMb?: (minute: number) => number;
  lifetimeMaxB?: number;
  /** Counters as a rate per second of wall time; the CSV carries the running total. */
  cpuNsPerS?: number;
  wakeupsPerS?: number;
  energyNjPerS?: number;
  /** A counter of -1 on every tick, the way the sampler reports it as unreadable (TESTS.md §1.2). */
  energyUnreadable?: boolean;
}

export interface SeriesSpec {
  seconds: number;
  hz?: number;
  t0Ns?: number;
  rows: RowSpec[];
}

export function writeSampleCsv(path: string, spec: SeriesSpec): string {
  const hz = spec.hz ?? 4;
  const t0 = spec.t0Ns ?? 0;
  const step = 1e9 / hz;
  const ticks = Math.round(spec.seconds * hz) + 1;
  const lines = [SAMPLE_COLUMNS.join(",")];
  for (let tick = 0; tick < ticks; tick++) {
    const t = t0 + Math.round(tick * step);
    const elapsed = (t - t0) / 1e9;
    for (const row of spec.rows) {
      const wobble = row.noiseMb === undefined ? 0 : row.noiseMb * Math.sin(tick * 1.7);
      const minuteLevel = row.minuteMb?.(Math.floor(tick / (hz * 60))) ?? 0;
      const bytes = Math.round(
        row.bytes + (row.mbPerMin ?? 0) * BYTES_PER_MB * (elapsed / 60) + (wobble + minuteLevel) * BYTES_PER_MB,
      );
      const lifetime = Math.max(bytes, row.lifetimeMaxB ?? bytes);
      const cpuUser = Math.round((row.cpuNsPerS ?? 0) * elapsed);
      const wakeups = Math.round((row.wakeupsPerS ?? 0) * elapsed);
      const energy = row.energyUnreadable ? -1 : Math.round((row.energyNjPerS ?? 0) * elapsed);
      lines.push(
        [t, row.pid, row.ppid ?? 1, row.group, row.exe, bytes, lifetime, cpuUser, 0, wakeups, 0, energy].join(","),
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// A fixture ADE that is calibrated enough to drive A7, A8 and A10.
export function weightAdapter(options: FixtureAdapterOptions = {}): Adapter {
  const adapter = makeFixtureAdapter(options);
  adapter.calibration.composerRect = { x: 100, y: 800, w: 1200, h: 120 };
  adapter.calibration.threadRect = { x: 100, y: 100, w: 1200, h: 700 };
  adapter.timed.launch = [{ kind: "wait", ms: 0 }];
  adapter.timed.newThread = [{ kind: "enter" }];
  adapter.timed.send = [{ kind: "type", text: "hi" }];
  adapter.processes = () => ({
    bundlePaths: ["/Applications/Fixture.app"],
    vendorDirs: [],
    launchAgentLabels: [],
    teamId: null,
    agentExecutables: ["claude", "codex"],
  });
  return adapter;
}

export const WINDOW_SERVER: NativeProc = {
  pid: 88,
  ppid: 1,
  path: "/System/Library/PrivateFrameworks/SkyLight.framework/WindowServer",
  name: "WindowServer",
  responsible_pid: null,
};

export interface Call {
  call: string;
  args: Record<string, unknown>;
}

export interface FakeWeightOptions {
  /** The fixture CSV to copy over the requested `csv` path, or null to keep the dry one. */
  sampleCsv?: (index: number, options: SampleOptions) => string | null;
  /** `footprint` totals in bytes, per call. */
  footprintB?: (index: number, options: { pids: number[]; out: string }) => number;
  gates?: (index: number) => Gates;
  procs?: NativeProc[];
  /** Override the WindowServer lookup A5 uses when procs() does not list it. */
  pidOf?: (name: string) => Promise<number | null>;
  lag?: NativeLag;
  /** false keeps each runner's own notes instead of the dry-run note. */
  dryRun?: boolean;
}

export interface FakeWeight {
  instruments: Instruments;
  calls: Call[];
}

export function fakeWeightInstruments(planPath: string, options: FakeWeightOptions = {}): FakeWeight {
  const base = dryInstruments(planPath);
  const calls: Call[] = [];
  let sampleIndex = 0;
  let footprintIndex = 0;
  let gatesIndex = 0;
  const instruments: Instruments = {
    ...base,
    dryRun: options.dryRun ?? true,
    procs: async () => options.procs ?? [],
    pidOf: async (name) => {
      calls.push({ call: "pidOf", args: { name } });
      if (options.pidOf !== undefined) return options.pidOf(name);
      return base.pidOf(name);
    },
    sample: async (o) => {
      calls.push({ call: "sample", args: { ...o } });
      const result = await base.sample(o);
      const fixture = options.sampleCsv?.(sampleIndex++, o) ?? null;
      if (fixture !== null) copyFileSync(fixture, o.csv);
      return result;
    },
    footprint: async (o) => {
      calls.push({ call: "footprint", args: { ...o } });
      const result = await base.footprint(o);
      const total = options.footprintB?.(footprintIndex++, o);
      return total === undefined ? result : { total_b: total };
    },
    gates: async () => {
      calls.push({ call: "gates", args: {} });
      if (options.gates !== undefined) return options.gates(gatesIndex++);
      return base.gates();
    },
    lag: async (o) => {
      calls.push({ call: "lag", args: { ...o } });
      if (options.lag !== undefined) return options.lag;
      return base.lag(o);
    },
    cover: async (o) => {
      calls.push({ call: "cover", args: { ...o } });
      return base.cover(o);
    },
  };
  return { instruments, calls };
}

export interface WeightContextOptions {
  root: string;
  instruments: Instruments;
  adapter?: Adapter;
  track?: TrackLetter;
  state?: Map<string, unknown>;
  options?: RunOptions;
  smoke?: boolean;
}

export function makeWeightContext(o: WeightContextOptions): { ctx: TestContext; runDir: string } {
  const writer = new RunWriter(o.root).open("weight-run");
  const adapter = o.adapter ?? weightAdapter();
  const ctx = createTestContext({
    runId: "weight-run",
    runDir: writer.runDir,
    machineId: "machine-1",
    adapter,
    rowAde: adapter.id,
    track: o.track ?? "A",
    options: o.options ?? { model: null, effort: null, server: "replay", agent: "claude" },
    instruments: o.instruments,
    writer,
    adapterCtx: {
      runDir: writer.runDir,
      arenaPath: o.root,
      worktree: o.root,
      home: o.root,
      env: {},
      dryRun: true,
      log: () => {},
    },
    installed: { installed: true, version: "1.0.0", path: null, binarySha256: null },
    freshArena: async () => o.root,
    state: o.state ?? new Map(),
    smoke: o.smoke === true,
  });
  return { ctx, runDir: writer.runDir };
}
