import Foundation

struct DirtySample: Equatable {
    let tNs: UInt64
    let dirtyOutsideMasks: Int
}

enum SettledFinder {
    /// First sample after which no dirty rectangle fell outside the masks for `quietNs`,
    /// searching only samples within `capNs` of `t0`. Nil when the window never settles.
    static func firstSettled(samples: [DirtySample],
                             t0: UInt64,
                             capNs: UInt64,
                             quietNs: UInt64) -> UInt64? {
        let limit = t0 &+ capNs
        let sorted = samples.filter { $0.tNs >= t0 && $0.tNs <= limit }.sorted { $0.tNs < $1.tNs }
        guard let last = sorted.last, last.tNs >= t0 &+ quietNs else { return nil }
        for (index, sample) in sorted.enumerated() {
            // The quiet window can only start on a frame that drew nothing outside the masks.
            if sample.dirtyOutsideMasks > 0 { continue }
            let quietEnd = sample.tNs &+ quietNs
            if quietEnd > limit { return nil }
            var dirty = false
            for candidate in sorted[(index + 1)...] {
                if candidate.tNs > quietEnd { break }
                if candidate.dirtyOutsideMasks > 0 { dirty = true; break }
            }
            if !dirty { return sample.tNs }
        }
        return nil
    }
}
