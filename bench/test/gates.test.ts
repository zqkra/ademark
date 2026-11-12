import { describe, expect, test } from "bun:test";
import {
  coresUsed,
  parseTopProcesses,
  quietCpu,
  gatesFromReadings,
  parseSwap,
  parseThermal,
  parseTopCpu,
} from "../core/gates.ts";

const SWAP_CLEAN = "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)";
const SWAP_USED = "vm.swapusage: total = 3072.00M  used = 1986.25M  free = 1085.75M  (encrypted)";
const THERMAL_OK = `Note: No thermal warning level has been recorded
Note: No performance warning level has been recorded
Note: No CPU power status has been recorded`;
const THERMAL_LIMITED = `Note: No thermal warning level has been recorded
CPU_Speed_Limit = 82`;
const THERMAL_WARNING = `Note: thermal warning level has been recorded
CPU_Speed_Limit = 100`;

const TOP_TWO_SAMPLES = `Processes: 693 total, 7 running, 686 sleeping, 4159 threads
CPU usage: 99.00% user, 0.00% sys, 1.0% idle
Processes: 693 total, 7 running, 686 sleeping, 4159 threads
CPU usage: 2.00% user, 1.00% sys, 97.0% idle`;

describe("parseSwap", () => {
  test("parses a clean swap", () => {
    expect(parseSwap(SWAP_CLEAN)).toEqual({ total_mb: 0, used_mb: 0, free_mb: 0 });
  });

  test("parses a used swap in MB", () => {
    expect(parseSwap(SWAP_USED).used_mb).toBeCloseTo(1986.25, 5);
  });

  test("converts GB to MB", () => {
    expect(parseSwap("vm.swapusage: total = 2.00G used = 1.50G free = 0.50G").used_mb).toBeCloseTo(1536, 5);
  });

  test("throws on a malformed line", () => {
    expect(() => parseSwap("nothing here")).toThrow(/missing total/);
  });
});

describe("parseThermal", () => {
  test("accepts a nominal machine", () => {
    expect(parseThermal(THERMAL_OK)).toEqual({ cpu_speed_limit: 100, warning_recorded: false });
  });

  test("reports a reduced speed limit", () => {
    expect(parseThermal(THERMAL_LIMITED)).toEqual({ cpu_speed_limit: 82, warning_recorded: false });
  });

  test("reports a recorded thermal warning", () => {
    expect(parseThermal(THERMAL_WARNING).warning_recorded).toBe(true);
  });

  test("does not treat 'No thermal warning' as a warning", () => {
    expect(parseThermal(THERMAL_OK).warning_recorded).toBe(false);
  });
});

describe("parseTopCpu", () => {
  test("takes the second sample, not the first", () => {
    expect(parseTopCpu(TOP_TWO_SAMPLES)).toEqual({ user: 2, sys: 1, samples: 2 });
  });

  test("counts a single sample", () => {
    expect(parseTopCpu("CPU usage: 5.46% user, 7.50% sys, 87.2% idle")).toEqual({ user: 5.46, sys: 7.5, samples: 1 });
  });

  test("throws when there is no CPU line", () => {
    expect(() => parseTopCpu("Processes: 1 total")).toThrow(/no CPU usage line/);
  });
});

describe("coresUsed", () => {
  test("converts percentages on 10 cores", () => {
    expect(coresUsed(2, 1, 10)).toBeCloseTo(0.3, 10);
    expect(coresUsed(0.5, 0.5, 10)).toBeCloseTo(0.1, 10);
  });

  test("rejects a bad core count", () => {
    expect(() => coresUsed(1, 1, 0)).toThrow(/cpu count/);
  });
});

describe("gatesFromReadings", () => {
  test("all gates pass on a clean machine", () => {
    const gates = gatesFromReadings(parseSwap(SWAP_CLEAN), parseThermal(THERMAL_OK), { user: 0.2, sys: 0.1 }, 10);
    expect(gates).toEqual({
      swap_ok: true,
      swap_used_mb: 0,
      thermal_ok: true,
      cpu_quiet_ok: true,
      cpu_cores_used: 0.03,
    });
  });

  test("fails swap when any swap is used", () => {
    const gates = gatesFromReadings(parseSwap(SWAP_USED), parseThermal(THERMAL_OK), { user: 0, sys: 0 }, 10);
    expect(gates.swap_ok).toBe(false);
    expect(gates.swap_used_mb).toBeCloseTo(1986.25, 5);
  });

  test("fails thermal on a reduced limit", () => {
    const gates = gatesFromReadings(parseSwap(SWAP_CLEAN), parseThermal(THERMAL_LIMITED), { user: 0, sys: 0 }, 10);
    expect(gates.thermal_ok).toBe(false);
  });

  test("fails the quiet CPU gate at 0.1 core or more", () => {
    const gates = gatesFromReadings(parseSwap(SWAP_CLEAN), parseThermal(THERMAL_OK), { user: 1, sys: 0 }, 10);
    expect(gates.cpu_quiet_ok).toBe(false);
    expect(gates.cpu_cores_used).toBeCloseTo(0.1, 10);
  });

  test("passes the quiet CPU gate just under 0.1 core", () => {
    const gates = gatesFromReadings(parseSwap(SWAP_CLEAN), parseThermal(THERMAL_OK), { user: 0.5, sys: 0.49 }, 10);
    expect(gates.cpu_quiet_ok).toBe(true);
  });
});

describe("quiet CPU without the harness", () => {
  const TOP = `Processes: 600 total
PID    PPID  %CPU COMMAND
1      0     0.0  launchd
PID    PPID  %CPU COMMAND
500    1     4.0  WindowServer
700    1     30.0 bun
701    700   2.0  top
702    701   9.0  helper of top
800    1     1.5  logd
900    1     0.0  idle thing
`;

  test("reads the second table of top", () => {
    expect(parseTopProcesses(TOP).map((proc) => proc.pid)).toEqual([500, 700, 701, 702, 800, 900]);
  });

  test("leaves out the harness and everything it started", () => {
    const quiet = quietCpu(parseTopProcesses(TOP), 700);
    expect(quiet.cores).toBe(0.055);
    expect(quiet.top).toEqual(["WindowServer 4", "logd 1.5", "idle thing 0"]);
  });

  test("a table with commands holding spaces keeps the whole name", () => {
    const procs = parseTopProcesses("PID PPID %CPU COMMAND\nPID    PPID  %CPU COMMAND\n12 1 3.5 Google Chrome Helper\n");
    expect(procs).toEqual([{ pid: 12, ppid: 1, cpu: 3.5, command: "Google Chrome Helper" }]);
  });
});
