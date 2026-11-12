import Foundation

enum MainLoop {
    /// Sleeps while pumping the main run loop, so framework work queued on the main queue
    /// (NSWorkspace launches, ScreenCaptureKit completion handlers) still runs while we wait.
    static func sleep(_ ns: UInt64) {
        let deadline = Date(timeIntervalSinceNow: Double(ns) / 1_000_000_000)
        while Date() < deadline {
            RunLoop.current.run(mode: .default, before: min(deadline, Date(timeIntervalSinceNow: 0.01)))
        }
    }
}
