// Pre-block machine gates (RUNBOOK.md 8): swap, thermal, quiet CPU. Parsers are pure so tests can feed fixtures.
export interface Gates {
  swap_ok: boolean;
  swap_used_mb: number;
  thermal_ok: boolean;
  cpu_quiet_ok: boolean;
  cpu_cores_used: number;
  /** The busiest non-harness processes of the last sample, "<command> <percent>", for events.log (RUNBOOK.md 8). */
  cpu_top?: string[];
  /** Quiet-CPU samples taken before the gate passed or gave up. */
  cpu_samples?: number;
}

export interface SwapReading {
  total_mb: number;
  used_mb: number;
  free_mb: number;
}

const UNIT_TO_MB: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };

function toMb(amount: string, unit: string): number {
  const factor = UNIT_TO_MB[unit.toUpperCase()];
  if (factor === undefined) throw new Error(`unknown memory unit ${unit}`);
  return Number(amount) * factor;
}

export function parseSwap(text: string): SwapReading {
  const fields: Record<string, number> = {};
  for (const key of ["total", "used", "free"]) {
    const match = text.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT])`, "i"));
    if (!match) throw new Error(`vm.swapusage: missing ${key}`);
    fields[key] = toMb(match[1]!, match[2]!);
  }
  return { total_mb: fields.total!, used_mb: fields.used!, free_mb: fields.free! };
}

export interface ThermalReading {
  cpu_speed_limit: number;
  warning_recorded: boolean;
}

export function parseThermal(text: string): ThermalReading {
  const limit = text.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  const noWarning = /No thermal warning level has been recorded/i.test(text);
  const warning = /thermal warning level (?:has been|was) recorded/i.test(text) && !noWarning;
  return { cpu_speed_limit: limit ? Number(limit[1]) : 100, warning_recorded: warning };
}

// top prints two "CPU usage:" samples when run with -l 2; the second one is the quiet-CPU gate.
export function parseTopCpu(text: string): { user: number; sys: number; samples: number } {
  const matches = [...text.matchAll(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/gi)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error("top: no CPU usage line");
  return { user: Number(last[1]), sys: Number(last[2]), samples: matches.length };
}

export interface TopProcess {
  pid: number;
  ppid: number;
  cpu: number;
  command: string;
}

// `top -l 2 -stats pid,ppid,cpu,command`: the second table is the measured interval (the first has no delta).
export function parseTopProcesses(text: string): TopProcess[] {
  const tables = text.split(/^PID\s+PPID\s+%CPU\s+COMMAND.*$/m);
  const last = tables[tables.length - 1];
  if (tables.length < 2 || last === undefined) throw new Error("top: no process table");
  const procs: TopProcess[] = [];
  for (const line of last.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*?)\s*$/);
    if (match) procs.push({ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), command: match[4]! });
  }
  return procs;
}

// RUNBOOK.md 8: "coalition CPU of everything except the harness". The harness is this process and everything it
// started, `top` included; pilot 2026-10-20: counting them, and the whole system line, failed an idle machine at 0.13.
export function quietCpu(procs: readonly TopProcess[], harnessPid: number): { cores: number; top: string[] } {
  const harness = new Set([harnessPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of procs) {
      if (!harness.has(proc.pid) && harness.has(proc.ppid)) {
        harness.add(proc.pid);
        grew = true;
      }
    }
  }
  const others = procs.filter((proc) => !harness.has(proc.pid));
  const cores = Math.round((others.reduce((sum, proc) => sum + proc.cpu, 0) / 100) * 1e6) / 1e6;
  const top = [...others]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 5)
    .map((proc) => `${proc.command} ${proc.cpu}`);
  return { cores, top };
}

export function coresUsed(userPercent: number, sysPercent: number, ncpu: number): number {
  if (!Number.isFinite(ncpu) || ncpu < 1) throw new Error(`bad cpu count: ${ncpu}`);
  return Math.round(((userPercent + sysPercent) / 100) * ncpu * 1e6) / 1e6;
}

export function gatesFromReadings(
  swap: SwapReading,
  thermal: ThermalReading,
  cpu: { user: number; sys: number },
  ncpu: number,
): Gates {
  const cores = coresUsed(cpu.user, cpu.sys, ncpu);
  return {
    swap_ok: swap.used_mb === 0,
    swap_used_mb: swap.used_mb,
    thermal_ok: thermal.cpu_speed_limit === 100 && !thermal.warning_recorded,
    cpu_quiet_ok: cores < 0.1,
    cpu_cores_used: cores,
  };
}

function run(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`gate command failed (${result.exitCode}): ${argv.join(" ")}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

// RUNBOOK.md 8: the quiet-CPU gate and the idle waits after purge and quit share this threshold.
export const QUIET_LIMIT_CORES = 0.1;
// RUNBOOK.md 8: "Wait up to 5 min".
const QUIET_WAIT_MS = 5 * 60_000;

function sampleQuietCpu(): { cores: number; top: string[] } {
  const text = run(["top", "-l", "2", "-s", "5", "-n", "1000", "-stats", "pid,ppid,cpu,command"]);
  return quietCpu(parseTopProcesses(text), process.pid);
}

export function checkGates(o: { quietWaitMs?: number } = {}): Gates {
  const swap = parseSwap(run(["sysctl", "vm.swapusage"]));
  const thermal = parseThermal(run(["pmset", "-g", "therm"]));
  const started = Date.now();
  let samples = 1;
  let cpu = sampleQuietCpu();
  while (cpu.cores >= QUIET_LIMIT_CORES && Date.now() - started < (o.quietWaitMs ?? QUIET_WAIT_MS)) {
    cpu = sampleQuietCpu();
    samples += 1;
  }
  return {
    swap_ok: swap.used_mb === 0,
    swap_used_mb: swap.used_mb,
    thermal_ok: thermal.cpu_speed_limit === 100 && !thermal.warning_recorded,
    cpu_quiet_ok: cpu.cores < QUIET_LIMIT_CORES,
    cpu_cores_used: cpu.cores,
    cpu_top: cpu.top,
    cpu_samples: samples,
  };
}
