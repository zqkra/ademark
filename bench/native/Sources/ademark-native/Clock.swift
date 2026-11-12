import Foundation
import Darwin
import CoreMedia

enum Clock {
    /// `intervalNs` spread uniformly over ±20 %. Research 2026-10-20: a fixed cadence (A8 250 ms, A3 50 ms) can lock
    /// to the 60 Hz display, so every probe lands at the same point of a frame and the sample is biased.
    static func jittered(_ intervalNs: UInt64) -> UInt64 {
        let spread = intervalNs / 5
        return intervalNs - spread + UInt64.random(in: 0...(2 * spread))
    }

    static func nowNs() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    }

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    static func ticksToNs(_ ticks: UInt64) -> UInt64 {
        let numer = UInt64(timebase.numer)
        let denom = UInt64(timebase.denom)
        if numer == denom { return ticks }
        return ticks / denom * numer + (ticks % denom) * numer / denom
    }

    static func secondsToNs(_ seconds: Double) -> UInt64 {
        UInt64(max(0, seconds) * 1_000_000_000)
    }

    static func nsToMs(_ ns: UInt64) -> Double {
        Double(ns) / 1_000_000
    }

    /// Host-clock CMTime (as used for sample buffer presentation times) to CLOCK_UPTIME_RAW ns.
    /// Nil for an invalid time, so a caller can never silently fall back to the arrival time.
    static func cmTimeToNs(_ time: CMTime) -> UInt64? {
        guard time.isValid, time.value > 0, time.timescale > 0 else { return nil }
        let ns = CMTimeConvertScale(time, timescale: 1_000_000_000, method: .roundHalfAwayFromZero)
        guard ns.isValid, ns.value > 0 else { return nil }
        return UInt64(ns.value)
    }

    static func sleepNs(_ ns: UInt64) {
        var request = timespec(tv_sec: Int(ns / 1_000_000_000), tv_nsec: Int(ns % 1_000_000_000))
        var remaining = timespec()
        while nanosleep(&request, &remaining) == -1 && errno == EINTR {
            request = remaining
        }
    }

    static func sleepUntil(_ deadline: UInt64) {
        let now = nowNs()
        if deadline > now { sleepNs(deadline - now) }
    }
}
