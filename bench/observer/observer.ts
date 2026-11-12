// Reads one app from the kernel while anything else runs: macOS groups an app with its helpers in a coalition, and
// `proc_pid_rusage` counts each process on its own. RAM and instructions do not move with load; wall time does.
// Same account only, no root. Layout: rusage_info_v4 in xnu bsd/sys/resource.h.
import { dlopen, FFIType, ptr } from "bun:ffi";

const RUSAGE_INFO_V4 = 4;
const PROC_PIDCOALITIONINFO = 20;
const UUID_BYTES = 16;
const WORDS = 48;
const FIELD = {
  userTime: 0,
  systemTime: 1,
  idleWakeups: 2,
  footprint: 7,
  lifetimeMaxFootprint: 28,
  instructions: 29,
  cycles: 30,
  billedEnergy: 31,
} as const;

const { symbols: libc } = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

export interface ProcessUsage {
  pid: number;
  footprintBytes: number;
  peakFootprintBytes: number;
  instructions: number;
  cycles: number;
  cpuTicks: number;
  idleWakeups: number;
  billedEnergy: number;
}

export function usageOf(pid: number): ProcessUsage | null {
  const buffer = new BigUint64Array((UUID_BYTES + WORDS * 8) / 8);
  if (libc.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buffer)) !== 0) return null;
  const word = (index: number): number => Number(buffer[UUID_BYTES / 8 + index]);
  return {
    pid,
    footprintBytes: word(FIELD.footprint),
    peakFootprintBytes: word(FIELD.lifetimeMaxFootprint),
    instructions: word(FIELD.instructions),
    cycles: word(FIELD.cycles),
    cpuTicks: word(FIELD.userTime) + word(FIELD.systemTime),
    idleWakeups: word(FIELD.idleWakeups),
    billedEnergy: word(FIELD.billedEnergy),
  };
}

/** The resource coalition of a process, or null when it is gone. */
export function coalitionOf(pid: number): bigint | null {
  // The kernel refuses a buffer smaller than its struct, which is larger than the id we read.
  const buffer = new BigUint64Array(8);
  if (libc.proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, ptr(buffer), buffer.byteLength) <= 0) return null;
  return buffer[0]!;
}

function allPids(): number[] {
  const buffer = new Int32Array(8192);
  const count = libc.proc_listallpids(ptr(buffer), buffer.byteLength);
  return count <= 0 ? [] : [...buffer.subarray(0, count)].filter((pid) => pid > 0);
}

/** Every process in the coalition of `pid`, which is the app and all it started. */
export function appPids(pid: number): number[] {
  const coalition = coalitionOf(pid);
  if (coalition === null) return [];
  return allPids().filter((other) => coalitionOf(other) === coalition);
}

export interface AppUsage {
  processes: number;
  footprintBytes: number;
  instructions: number;
  cpuTicks: number;
  idleWakeups: number;
  billedEnergy: number;
}

export function appUsage(pid: number): AppUsage {
  const total: AppUsage = { processes: 0, footprintBytes: 0, instructions: 0, cpuTicks: 0, idleWakeups: 0, billedEnergy: 0 };
  for (const member of appPids(pid)) {
    const usage = usageOf(member);
    if (usage === null) continue;
    total.processes += 1;
    total.footprintBytes += usage.footprintBytes;
    total.instructions += usage.instructions;
    total.cpuTicks += usage.cpuTicks;
    total.idleWakeups += usage.idleWakeups;
    total.billedEnergy += usage.billedEnergy;
  }
  return total;
}
