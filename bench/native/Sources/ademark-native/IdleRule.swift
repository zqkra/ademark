import Foundation

struct CoreSample: Equatable {
    let tNs: UInt64
    let cores: Double
}

/// A1 waits for the machine to go quiet after a purge, A2 after a quit (TESTS.md). Both used fixed sleeps; this
/// replaces them with a measured quiet window over host CPU ticks.
enum IdleRule {
    /// Cores busy over one interval: the busy share of all host ticks times the logical CPU count.
    /// The helper's own ticks are part of the host counters, which is intended: it adds work while it waits.
    static func coresBusy(previous: CpuTicks, current: CpuTicks, logicalCpus: Int) -> Double? {
        guard logicalCpus > 0 else { return nil }
        let busy = UInt64(current.user &- previous.user)
            + UInt64(current.system &- previous.system)
            + UInt64(current.nice &- previous.nice)
        let total = busy + UInt64(current.idle &- previous.idle)
        guard total > 0 else { return nil }
        return Double(busy) / Double(total) * Double(logicalCpus)
    }

    /// Quiet when every interval in the last `quietNs` is under `threshold`, and the samples cover that whole window.
    static func isQuiet(samples: [CoreSample], threshold: Double, quietNs: UInt64) -> Bool {
        guard let first = samples.first, let last = samples.last,
              last.tNs >= first.tNs, last.tNs - first.tNs >= quietNs else { return false }
        let start = last.tNs - quietNs
        return samples.filter { $0.tNs >= start }.allSatisfy { $0.cores < threshold }
    }
}
