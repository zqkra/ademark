// The host clock every timestamp in ADEMark uses: clock_gettime_nsec_np(CLOCK_UPTIME_RAW).
// The native helper reads the same clock (TESTS.md 1.1), so Bun and Swift timestamps are comparable.
import { dlopen, FFIType } from "bun:ffi";

const CLOCK_UPTIME_RAW = 8;

const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  clock_gettime_nsec_np: { args: [FFIType.i32], returns: FFIType.u64 },
});

export function nowNs(): bigint {
  return libSystem.symbols.clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
}
