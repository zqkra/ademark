import { describe, expect, test } from "bun:test";
import type { SampleRow } from "../run/kit.ts";
import {
  appRates,
  firstWindowMinutes,
  isSettled,
  leakSlope,
  mbPerThread,
  medianMb,
  mergeSampleRows,
  minuteMedians,
  p95Mb,
  peakLifetimeMb,
  slopeMbPerMin,
  tailWindow,
  ticks,
  ticksWithAgents,
  type Tick,
} from "../tracks/a-weight/shared.ts";
import { AGENT_EXE, APP_EXE, MIB, HELPER_EXE } from "./fixtures/tracks-a-weight/fixtures.ts";

function sample(partial: Partial<SampleRow>): SampleRow {
  return {
    t_ns: 0,
    pid: 1,
    ppid: 0,
    group: "app",
    exe: APP_EXE,
    phys_footprint_b: 100 * MIB,
    lifetime_max_b: 120 * MIB,
    cpu_user_ns: 0,
    cpu_sys_ns: 0,
    wakeups_idle: 0,
    wakeups_irq: 0,
    energy_nj: 0,
    ...partial,
  };
}

function series(valuesMb: readonly number[]): Array<{ t_ns: number; bytes: number }> {
  return valuesMb.map((mb, index) => ({ t_ns: index * 250e6, bytes: mb * MIB }));
}

describe("settle slope", () => {
  test("a flat app series is settled at 0 MB/min", () => {
    const flat = series(Array.from({ length: 241 }, () => 300));
    expect(slopeMbPerMin(flat)).toBeCloseTo(0, 10);
    expect(isSettled(slopeMbPerMin(flat))).toBe(true);
  });

  test("a series that grows 10 MB in a minute has a slope of 10 MB/min", () => {
    const rising = Array.from({ length: 241 }, (_, index) => ({
      t_ns: index * 250e6,
      bytes: (300 + (10 * index) / 240) * MIB,
    }));
    expect(slopeMbPerMin(rising)).toBeCloseTo(10, 6);
    expect(isSettled(slopeMbPerMin(rising))).toBe(false);
  });

  test("the window keeps only the last 60 s", () => {
    const long = series(Array.from({ length: 961 }, () => 100));
    const window = tailWindow(long, 60e9);
    expect(long.length).toBe(961);
    expect(window.length).toBe(241);
    expect(window[0]!.t_ns).toBe(180_000_000_000);
  });

  test("one point has no slope, so it never counts as settled", () => {
    expect(Number.isNaN(slopeMbPerMin([{ t_ns: 0, bytes: 100 * MIB }]))).toBe(true);
    expect(isSettled(Number.NaN)).toBe(false);
  });

  test("a boundary tick shared by two chunks is not summed twice", () => {
    const first = [
      sample({ t_ns: 0, phys_footprint_b: 300 * MIB }),
      sample({ t_ns: 20e9, phys_footprint_b: 302 * MIB }),
    ];
    const second = [
      sample({ t_ns: 20e9, phys_footprint_b: 301 * MIB }),
      sample({ t_ns: 40e9, phys_footprint_b: 304 * MIB }),
    ];
    const merged = mergeSampleRows([first, second]);
    expect(merged.length).toBe(3);
    expect(merged.filter((row) => row.t_ns === 20e9)).toEqual([first[1]!]);
  });
});

describe("idle rates", () => {
  function tick(t_ns: number, rows: SampleRow[]): Tick {
    return { t_ns, rows };
  }

  test("CPU, wakeups and energy over the pids present in both ticks", () => {
    const first = tick(0, [
      sample({ pid: 10, cpu_user_ns: 1e9, cpu_sys_ns: 0.5e9, wakeups_idle: 10, wakeups_irq: 2, energy_nj: 1e6 }),
      sample({ pid: 11, cpu_user_ns: 0, cpu_sys_ns: 0, wakeups_idle: 0, wakeups_irq: 0, energy_nj: 1e6 }),
    ]);
    const last = tick(2e9, [
      sample({ pid: 10, cpu_user_ns: 3e9, cpu_sys_ns: 0.5e9, wakeups_idle: 30, wakeups_irq: 4, energy_nj: 5e6 }),
      sample({ pid: 11, cpu_user_ns: 0, cpu_sys_ns: 0, wakeups_idle: 0, wakeups_irq: 0, energy_nj: -1 }),
    ]);
    const rates = appRates(first, last);
    expect(rates.pids).toBe(2);
    expect(rates.dt_ns).toBe(2e9);
    expect(rates.cpu_percent).toBeCloseTo(100, 9);
    expect(rates.wakeups_per_s).toBeCloseTo(11, 9);
    expect(rates.energy_mw).toBeCloseTo(2, 9);
    expect(rates.skipped).toEqual({ cpu: 0, wakeups: 0, energy: 1 });
  });

  test("a counter that is -1 everywhere is skipped instead of counted as zero", () => {
    const first = tick(0, [sample({ pid: 10, energy_nj: -1, wakeups_idle: -1 })]);
    const last = tick(1e9, [sample({ pid: 10, energy_nj: -1, wakeups_idle: -1 })]);
    const rates = appRates(first, last);
    expect(rates.energy_mw).toBeNull();
    expect(rates.wakeups_per_s).toBeNull();
    expect(rates.cpu_percent).toBeCloseTo(0, 9);
    expect(rates.skipped.energy).toBe(1);
    expect(rates.skipped.wakeups).toBe(1);
  });

  test("only app pids present in both ticks count", () => {
    const first = tick(0, [sample({ pid: 10 }), sample({ pid: 99, group: "agents", exe: AGENT_EXE })]);
    const last = tick(1e9, [sample({ pid: 10 }), sample({ pid: 11 }), sample({ pid: 99, group: "agents" })]);
    expect(appRates(first, last).pids).toBe(1);
  });
});

describe("p95 and peak", () => {
  test("p95 uses the R-7 quantile", () => {
    expect(p95Mb(series([100, 200, 300, 400, 500]))).toBeCloseTo(480, 9);
  });

  test("median of an app series", () => {
    expect(medianMb(series([100, 300, 200]))).toBeCloseTo(200, 9);
  });

  test("app-peak sums the app group at each tick and leaves agents out", () => {
    const rows = [
      sample({ pid: 10, lifetime_max_b: 500 * MIB }),
      sample({ pid: 11, exe: HELPER_EXE, lifetime_max_b: 300 * MIB }),
      sample({ pid: 12, group: "agents", exe: AGENT_EXE, lifetime_max_b: 900 * MIB }),
    ];
    expect(peakLifetimeMb(rows)).toBeCloseTo(800, 9);
  });
});

describe("the 5-agents rule", () => {
  function agentRows(ticksCount: number, perTick: number): SampleRow[] {
    const rows: SampleRow[] = [];
    for (let tick = 0; tick < ticksCount; tick++) {
      for (let agent = 0; agent < perTick; agent++) {
        rows.push(sample({ t_ns: tick * 250e6, pid: 100 + agent, group: "agents", exe: AGENT_EXE }));
      }
    }
    return rows;
  }

  test("600 ticks with 5 live agents pass, 599 fail", () => {
    const rows = agentRows(600, 5);
    expect(ticksWithAgents(rows, ["claude", "codex"], 5)).toBe(600);
    expect(ticksWithAgents(rows.slice(0, -1), ["claude", "codex"], 5)).toBe(599);
  });

  test("a tick with 4 agents does not count, and neither does a foreign executable", () => {
    expect(ticksWithAgents(agentRows(10, 4), ["claude"], 5)).toBe(0);
    expect(ticksWithAgents(agentRows(10, 5), ["codex"], 5)).toBe(0);
  });

  test("ticks groups rows by their timestamp", () => {
    expect(ticks(agentRows(3, 2)).length).toBe(3);
  });
});

describe("A12 slope and interval", () => {
  // One tick every 250 ms, `tickNoise` wobbling inside each minute and `level` shifting the whole minute.
  function noisySeries(
    minutes: number,
    mbPerHour: number,
    tickNoise = 4,
    level: (minute: number) => number = () => 0,
  ): Array<{ t_ns: number; bytes: number }> {
    const ticksCount = minutes * 60 * 4 + 1;
    return Array.from({ length: ticksCount }, (_, index) => {
      const t_ns = index * 250e6;
      const hours = t_ns / 3.6e12;
      const minute = Math.floor(index / 240);
      const noise = tickNoise * Math.sin(index * 1.7);
      return { t_ns, bytes: (300 + mbPerHour * hours + level(minute) + noise) * MIB };
    });
  }

  test("one point per full minute at the minute's midpoint", () => {
    const series = noisySeries(3, 0, 0);
    const points = minuteMedians(series);
    expect(points.map((point) => point.t_ns)).toEqual([30e9, 90e9, 150e9]);
    expect(points.every((point) => Math.abs(point.bytes / MIB - 300) < 1e-9)).toBe(true);
  });

  test("a trailing minute that does not reach its end is dropped", () => {
    const series = noisySeries(3, 0, 0);
    const partial = [...series, { t_ns: 190e9, bytes: 300 * MIB }];
    expect(minuteMedians(partial).length).toBe(3);
    expect(minuteMedians([]).length).toBe(0);
  });

  test("a flat series with large tick-level noise gives an interval that contains 0", () => {
    // Alternating minute levels cancel in the fit: each minute's level is the negative of its mirror minute.
    const flat = noisySeries(30, 0, 6, (minute) => (minute % 2 === 0 ? 6 : -6));
    const slope = leakSlope(minuteMedians(flat));
    expect(slope.ticks).toBe(30);
    expect(slope.se).toBeGreaterThan(0);
    expect(slope.lo).toBeLessThanOrEqual(0);
    expect(slope.hi).toBeGreaterThanOrEqual(0);
  });

  test("a series that grows 120 MB/h gives a slope within 5 % and an interval that excludes 0", () => {
    const growing = noisySeries(30, 120, 4, (minute) => 3 * Math.sin(minute * 1.7));
    const slope = leakSlope(minuteMedians(growing));
    expect(Math.abs(slope.slope_mb_per_h - 120)).toBeLessThan(6);
    expect(slope.lo).toBeGreaterThan(0);
    expect(slope.hi).toBeGreaterThan(slope.slope_mb_per_h);
  });

  test("two minutes are not enough for a published interval", () => {
    expect(minuteMedians(noisySeries(2, 0, 0)).length).toBe(2);
    expect(minuteMedians(noisySeries(3, 0, 0)).length).toBe(3);
  });

  test("the first 30 minutes of a longer block are the window", () => {
    const line = noisySeries(45, 6, 1);
    const window = firstWindowMinutes(line, 30);
    expect(window.length).toBe(7201);
    expect(minuteMedians(window).length).toBe(30);
  });

  test("two points fit exactly, so the interval collapses onto the slope", () => {
    const slope = leakSlope([
      { t_ns: 0, bytes: 300 * MIB },
      { t_ns: 3.6e12 / 2, bytes: 306 * MIB },
    ]);
    expect(slope.slope_mb_per_h).toBeCloseTo(12, 9);
    expect(slope.se).toBe(0);
    expect(slope.lo).toBeCloseTo(12, 9);
    expect(slope.hi).toBeCloseTo(12, 9);
  });

  test("fewer than two ticks has no slope", () => {
    expect(() => leakSlope([{ t_ns: 0, bytes: 300 * MIB }])).toThrow(/at least 2/);
  });
});

describe("mb per thread", () => {
  test("15 extra threads divide the growth by 15", () => {
    expect(mbPerThread(400, 280)).toBe(8);
    expect(mbPerThread(400, 280, 15)).toBe(8);
  });
});
