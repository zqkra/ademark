import Foundation
import CoreGraphics

/// A process that posts a key event and exits at once can lose it: the window server drops a key event whose sender
/// has already gone and logs "Sender is prohibited from synthesizing events". `keys` exited that way until 2026-11-15.
/// Measured that day under load, with an event tap as the witness: 59 of 105 `keys --enter` arrived whole, and 105 of
/// 105 once `keys` waited here. So `keys` holds its process until the HID state shows each key down and then up.
/// Triggers inside `echo` and `watch` do not need it, because those processes live on after their last event.
/// `click` does not either: 105 of 105 arrived as it is.
enum InputSettle {
    /// Longest wait for one event. Under load the state followed within 30 ms.
    static let capNs: UInt64 = 250_000_000
    static let pollNs: UInt64 = 1_000_000

    /// Polls `read` until it returns `want` or the cap runs out. False when the cap ran out first.
    @discardableResult
    static func wait(for want: Bool,
                     capNs: UInt64 = capNs,
                     pollNs: UInt64 = pollNs,
                     now: () -> UInt64 = Clock.nowNs,
                     sleep: (UInt64) -> Void = Clock.sleepNs,
                     read: () -> Bool) -> Bool {
        let deadline = now() &+ capNs
        while true {
            if read() == want { return true }
            if now() >= deadline { return false }
            sleep(pollNs)
        }
    }

    static func keyIsDown(_ keyCode: CGKeyCode) -> Bool {
        CGEventSource.keyState(.hidSystemState, key: keyCode)
    }
}
