import Foundation

/// Chooses which frame to compare after typing. ScreenCaptureKit sends a frame only when the window changes, so a
/// composer that draws the text right after the key and then stays still sends nothing at the settle mark.
enum ProbeFrameSelector {
    /// The newest frame at or after `lastKeyNs`, once the settle window has passed; nil before then or when only
    /// older frames have arrived.
    static func newestAfterKey(frames: [UInt64], lastKeyNs: UInt64, nowNs: UInt64) -> UInt64? {
        guard nowNs >= lastKeyNs + ProbeRegionCommand.settleNs else { return nil }
        return frames.filter { $0 >= lastKeyNs }.max()
    }
}
