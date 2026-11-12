import Foundation
import CoreMedia

enum FrameTimeSource: String {
    case pts
    case display
    case arrival
}

struct FrameTimestamp {
    let tNs: UInt64
    let source: FrameTimeSource
}

enum FrameTimeSelector {
    /// Picks a frame's timestamp and says where it came from.
    ///
    /// - `ptsNs`: the sample buffer presentation time on the host clock, nil when invalid.
    /// - `displayTicks`: `SCStreamFrameInfo.displayTime`, a mach absolute time, nil when absent.
    /// - `arrivalNs`: when this process received the frame. Only used as a last resort, because it
    ///   comes after the frame was shown and would make Ready look slower than it is.
    static func select(ptsNs: UInt64?, displayTicks: UInt64?, arrivalNs: UInt64) -> FrameTimestamp {
        if let ptsNs, ptsNs > 0 {
            return FrameTimestamp(tNs: ptsNs, source: .pts)
        }
        if let displayTicks, displayTicks > 0 {
            return FrameTimestamp(tNs: Clock.ticksToNs(displayTicks), source: .display)
        }
        return FrameTimestamp(tNs: arrivalNs, source: .arrival)
    }
}
