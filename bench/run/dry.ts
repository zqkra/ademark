// The deterministic dry implementation of Instruments: it measures nothing and appends every call to a plan file.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nowNs } from "../core/clock.ts";
import type { CaptureRow, NativeSample, SampleRules } from "../core/contracts.ts";
import { SAMPLE_COLUMNS } from "../core/contracts.ts";
import type { Gates } from "../core/gates.ts";
import { median, quantile } from "../core/stats.ts";
import { loadTask } from "../core/tasks.ts";
import type {
  CaptureControl,
  ContaminationResult,
  FaultOutcome,
  GradeResult,
  Instruments,
  ReplayControl,
  SampleHandle,
} from "./instruments.ts";

const MIB = 1024 * 1024;
const APP_B = 300 * MIB;
// A5 reads WindowServer's memory through pidOf() when procs() does not list it; the dry pid never runs.
const DRY_PID = 88;
const AGENTS_B = 150 * MIB;
const DRY_BODY_SHA256 = "0123456789abcdef".repeat(4);

// The dry sampler writes a real CSV: 1 row per root pid, 2 helpers and 5 agents on every tick. App memory grows
// 0.5 MB per minute, so the A5 settle phase finishes and every counter stays positive and monotonic.
const APP_EXE = "/Applications/Example.app/Contents/MacOS/Example";
const HELPER_EXE = "/Applications/Example.app/Contents/Frameworks/Example Helper";
const AGENT_EXE = "/usr/local/bin/claude";
const AGENTS_PER_PID_B = AGENTS_B / 5;
const APP_ROOT_BASE_B = APP_B - 2 * 20 * MIB;
const HELPER_B = 20 * MIB;
const APP_MB_PER_MIN = 0.5;
const CPU_USER_NS_PER_S = 0.01e9;
const CPU_SYS_NS_PER_S = 0.002e9;
const WAKEUPS_PER_S = 5;
const ENERGY_NJ_PER_S = 1e6;
// A12 needs more than 3 full minutes; the background sampler stops after 4 minutes of dry ticks.
const DRY_SAMPLE_START_S = 240;

function record(planPath: string, call: string, args: Record<string, unknown>): void {
  const path = resolve(planPath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ call, args })}\n`);
}

function csvValue(value: string): string {
  return value.includes(",") || value.includes('"') ? `"${value.replaceAll('"', '""')}"` : value;
}

interface SampleLayout {
  rootPids: number[];
  helperPids: number[];
  agentPids: number[];
  parentPid: number;
}

function nextFreePids(used: Set<number>, count: number): number[] {
  const pids: number[] = [];
  let candidate = Math.max(1000, ...used) + 1;
  while (pids.length < count) {
    if (!used.has(candidate)) {
      pids.push(candidate);
      used.add(candidate);
    }
    candidate += 1;
  }
  return pids;
}

function sampleLayout(rootPids: readonly number[]): SampleLayout {
  const used = new Set(rootPids);
  return {
    rootPids: [...rootPids],
    helperPids: nextFreePids(used, 2),
    agentPids: nextFreePids(used, 5),
    parentPid: rootPids[0] ?? 1,
  };
}

// One CSV for `durationS` at `hz`, plus the NativeSample summary over the same rows.
function drySample(rules: SampleRules, hz: number, durationS: number, csvPath: string): NativeSample {
  const layout = sampleLayout(rules.rootPids);
  const ticks = Math.max(1, Math.round(durationS * hz) + 1);
  const lines: string[] = [SAMPLE_COLUMNS.join(",")];
  const appSums: number[] = [];
  const agentSums: number[] = [];
  const totalSums: number[] = [];
  const seen = new Set<number>();
  let rows = 0;

  for (let tick = 0; tick < ticks; tick++) {
    const t_ns = Math.round((tick * 1e9) / hz);
    const seconds = t_ns / 1e9;
    const cpuUser = Math.round(CPU_USER_NS_PER_S * seconds);
    const cpuSys = Math.round(CPU_SYS_NS_PER_S * seconds);
    const wakeups = Math.round(WAKEUPS_PER_S * seconds);
    const energy = Math.round(ENERGY_NJ_PER_S * seconds);
    let appSum = 0;
    let agentSum = 0;
    const push = (pid: number, ppid: number, group: "app" | "agents", exe: string, bytes: number): void => {
      lines.push(
        [
          t_ns, pid, ppid, group, csvValue(exe), bytes, bytes,
          cpuUser, cpuSys, wakeups, 0, energy,
        ].join(","),
      );
      rows += 1;
      seen.add(pid);
      if (group === "app") appSum += bytes;
      else agentSum += bytes;
    };

    const rootTotal = Math.round(APP_ROOT_BASE_B + APP_MB_PER_MIN * MIB * (seconds / 60));
    const rootCount = layout.rootPids.length;
    const perRoot = rootCount === 0 ? 0 : Math.floor(rootTotal / rootCount);
    layout.rootPids.forEach((pid, index) => {
      const bytes = index === rootCount - 1 ? rootTotal - perRoot * (rootCount - 1) : perRoot;
      push(pid, 1, "app", APP_EXE, bytes);
    });
    for (const pid of layout.helperPids) push(pid, layout.parentPid, "app", HELPER_EXE, HELPER_B);
    for (const pid of layout.agentPids) push(pid, layout.parentPid, "agents", AGENT_EXE, AGENTS_PER_PID_B);

    appSums.push(appSum);
    agentSums.push(agentSum);
    totalSums.push(appSum + agentSum);
  }

  const path = resolve(csvPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return {
    ticks,
    rows,
    pids: seen.size,
    app_median_b: Math.round(median(appSums)),
    app_p95_b: Math.round(quantile(appSums, 0.95)),
    agents_median_b: Math.round(median(agentSums)),
    total_median_b: Math.round(median(totalSums)),
    total_p95_b: Math.round(quantile(totalSums, 0.95)),
  };
}

export function dryInstruments(planPath: string): Instruments {
  const clock = (): bigint => nowNs();

  return {
    dryRun: true,
    now: () => {
      const t = clock();
      record(planPath, "now", { t_ns: t.toString() });
      return t;
    },
    sleep: async (ms) => {
      record(planPath, "sleep", { ms });
    },
    procs: async () => [],
    pidOf: async (name) => {
      record(planPath, "pidOf", { name });
      return DRY_PID;
    },
    idle: async (o) => {
      record(planPath, "idle", { ...o });
      return { waited_ms: 0, quiet: true, cores_last: 0 };
    },
    sample: async (o) => {
      record(planPath, "sample", { rules: o.rules, hz: o.hz, durationS: o.durationS, csv: o.csv });
      return drySample(o.rules, o.hz, o.durationS, o.csv);
    },
    sampleStart: async (o): Promise<SampleHandle> => {
      record(planPath, "sampleStart", { rules: o.rules, hz: o.hz, csv: o.csv });
      const sample = drySample(o.rules, o.hz, DRY_SAMPLE_START_S, o.csv);
      return {
        stop: async () => {
          record(planPath, "sampleStart.stop", {});
          return sample;
        },
      };
    },
    window: async (o) => {
      record(planPath, "window", { ...o });
      return { window_id: 1, frame: { x: 0, y: 0, w: 1600, h: 1000 } };
    },
    keys: async (o) => {
      record(planPath, "keys", { ...o });
      return { t_ns: Number(clock()) };
    },
    echo: async (o) => {
      record(planPath, "echo", { ...o });
      const t0 = Number(clock());
      const result = { t0_ns: t0, ready_ns: t0 + 1_200_000_000, ready_ms: 1200, settled_ms: 1800, frames: 72, timed_out: false };
      return o.absent !== undefined && o.absentRegion !== undefined ? { ...result, absent_seen: false, absent_checked: true } : result;
    },
    watch: async (o) => {
      record(planPath, "watch", { ...o });
      const t0 = Number(clock());
      return { t0_ns: t0, seen_ns: t0 + 900_000_000, ms: 900, timed_out: false, seen_text: typeof o.text === "string" ? o.text : o.text[0]! };
    },
    lag: async (o) => {
      record(planPath, "lag", { ...o });
      const samples = Array.from({ length: o.count }, () => 12);
      return { samples_ms: samples, p50: 12, p95: 12, lost: 0, probes_ms: [...samples] };
    },
    scroll: async (o) => {
      record(planPath, "scroll", { ...o });
      const t0 = Number(clock());
      return {
        t0_ns: t0,
        t_end_ns: t0 + Math.ceil((o.count / o.hz) * 1_000_000_000),
        posted: o.count,
        frames: o.count + 1,
        gaps_over_33ms: 0,
        max_gap_ms: 0,
      };
    },
    cover: async (o) => {
      record(planPath, "cover", { ...o });
      const shown = clock();
      return {
        window_id: 1,
        frame: { x: 0, y: 0, w: 1600, h: 1000 },
        shown_ns: Number(shown),
        closed_ns: Number(shown + BigInt(o.durationS) * 1_000_000_000n),
      };
    },
    screenshot: async (o) => {
      record(planPath, "screenshot", { ...o });
      return { path: o.out };
    },
    ocr: async (o) => {
      record(planPath, "ocr", { ...o });
      return { lines: [] };
    },
    prepareArena: async (o) => {
      record(planPath, "prepareArena", { ...o });
      return o.dest;
    },
    startReplay: async (o): Promise<ReplayControl> => {
      record(planPath, "startReplay", { ...o });
      return {
        port: o.port,
        logPath: o.log,
        stats: async () => ({ requests: 0, by_session: {}, unknown: 0, rewrite_misses: 0 }),
        reset: async () => {},
        stop: async () => {},
      };
    },
    startCapture: async (o): Promise<CaptureControl> => {
      record(planPath, "startCapture", { ...o });
      return { outPath: o.out, rows: (): CaptureRow[] => [], stop: async () => {} };
    },
    fault: async (f, o): Promise<FaultOutcome> => {
      record(planPath, "fault", {
        fault: f,
        worktree: o.worktree,
        appName: o.appName,
        agentExecutables: o.agentExecutables,
      });
      const started = clock();
      return {
        kind: f.kind,
        applied: true,
        started_ns: started,
        ended_ns: started + BigInt(Math.max(1, f.duration_s ?? 1)) * 1_000_000_000n,
        detail: "dry run",
      };
    },
    grade: async (o): Promise<GradeResult> => {
      record(planPath, "grade", { ...o });
      const task = loadTask(o.taskId);
      return {
        task: o.taskId,
        groups: task.grade_groups.map((id) => ({ id, passed: 1, total: 1, failed: [] })),
        valid: true,
        reasons: [],
      };
    },
    footprint: async (o) => {
      record(planPath, "footprint", { ...o });
      return { total_b: APP_B };
    },
    purge: async () => {
      record(planPath, "purge", {});
    },
    gates: async (o = {}): Promise<Gates> => {
      record(planPath, "gates", { ...o });
      return { swap_ok: true, swap_used_mb: 0, thermal_ok: true, cpu_quiet_ok: true, cpu_cores_used: 0.01 };
    },
    contamination: async (o): Promise<ContaminationResult> => {
      record(planPath, "contamination", { ...o });
      return { bytes: 1024, body_sha256: DRY_BODY_SHA256 };
    },
  };
}
