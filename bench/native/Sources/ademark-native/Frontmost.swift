import Foundation
import AppKit

/// Keys and clicks are posted to the HID event tap, so they reach whatever app is frontmost.
/// A post is only safe when the measured app is the frontmost one.
func canPost(frontmostPid: Int32?, target: Int32) -> Bool {
    guard let frontmostPid else { return false }
    return frontmostPid == target
}

enum Frontmost {
    static func currentPid() -> Int32? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    /// Reads the frontmost app now and applies `canPost(frontmostPid:target:)`.
    static func isFrontmost(_ target: Int32) -> Bool {
        canPost(frontmostPid: currentPid(), target: target)
    }

    /// Longest a single trigger waits for the app to come front. Bounded so a trigger that can
    /// never post cannot eat the whole measurement window; the trigger is then skipped.
    static let waitCapNs: UInt64 = 5_000_000_000

    /// Waits until the target is frontmost, so a trigger that must post can do so safely.
    /// Returns false when the wait runs out; the caller must then skip the post.
    static func waitUntilFrontmost(_ target: Int32, deadline: UInt64) -> Bool {
        let limit = min(deadline, Clock.nowNs() &+ waitCapNs)
        while Clock.nowNs() < limit {
            if isFrontmost(target) { return true }
            MainLoop.sleep(20_000_000)
        }
        return isFrontmost(target)
    }
}
