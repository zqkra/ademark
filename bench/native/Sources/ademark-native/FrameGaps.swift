import Foundation

struct FrameGapSummary: Equatable {
    let gapsOver33ms: Int
    let maxGapMs: Double
}

/// A11 counts frame gaps during the scroll only. The scroll runs from the first event to the last event plus one
/// event interval; frames after it do not count, because an app that stops drawing when the content stops moving is
/// idle, not stuttering. The window starts and ends with a virtual frame, so the silence before the first frame and
/// after the last one both count: a frozen app that draws nothing during the scroll is one gap over the whole window.
/// The threshold is strictly "over 33 ms", so a pair exactly 33.0 ms apart is not a gap.
enum FrameGaps {
    static let thresholdNs: UInt64 = 33_000_000

    static func windowed(frameTimes: [UInt64], t0Ns: UInt64, tEndNs: UInt64) -> FrameGapSummary {
        let empty = FrameGapSummary(gapsOver33ms: 0, maxGapMs: 0)
        guard tEndNs >= t0Ns else { return empty }
        var times: [UInt64] = [t0Ns]
        times.append(contentsOf: frameTimes.filter { $0 > t0Ns && $0 <= tEndNs }.sorted())
        times.append(tEndNs)
        var gaps = 0
        var maxGap: UInt64 = 0
        for index in 1..<times.count {
            let difference = times[index] - times[index - 1]
            if difference > thresholdNs { gaps += 1 }
            maxGap = max(maxGap, difference)
        }
        return FrameGapSummary(gapsOver33ms: gaps, maxGapMs: Clock.nsToMs(maxGap))
    }
}
