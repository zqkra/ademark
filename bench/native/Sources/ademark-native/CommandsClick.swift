import Foundation
import CoreGraphics

enum ClickCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let point = try PointSpec.parse(try arguments.string("--at"), name: "--at")
        let count = try clickCount(arguments.optionalString("--count"))

        try Permissions.requireAccessibility()
        guard ProcessTable.isAlive(pid) else {
            throw NativeError.runtime(code: "process_not_found", message: "pid \(pid) is not running")
        }
        guard let window = WindowFinder.frontmost(pid: pid) else {
            throw NativeError.runtime(code: "window_not_found",
                                      message: "pid \(pid) has no on-screen window at layer 0")
        }
        // Clicks go to the HID tap, so they would land in whatever app is frontmost.
        guard Frontmost.isFrontmost(pid) else {
            throw NativeError.runtime(code: "not_frontmost",
                                      message: "pid \(pid) is not the frontmost application; nothing was posted")
        }

        let space = WindowSpace(scale: 1, pixelWidth: window.frame.width, pixelHeight: window.frame.height)
        let screenPoint = space.screenPoint(windowOrigin: window.frame.origin, spec: point)
        let previous = CGEvent(source: nil)?.location
        let postedAt = MouseClick.post(at: screenPoint, count: count)
        // Put the owner's pointer back where it was before the probe.
        if let previous { CGWarpMouseCursorPosition(previous) }
        emit(.object([("t_ns", .uint(postedAt))]))
    }

    private static func clickCount(_ raw: String?) throws -> Int {
        guard let raw else { return 1 }
        guard let count = Int(raw), count >= 1, count <= 3 else {
            throw NativeError.badArguments("--count must be 1, 2 or 3")
        }
        return count
    }
}

enum MouseClick {
    private static let source = CGEventSource(stateID: .hidSystemState)
    /// Same reason as `KeyPoster.holdNs`: a down and up posted in the same instant get dropped.
    static let holdNs: UInt64 = 10_000_000

    /// Left clicks `count` times at `point` in screen coordinates, with the click state set so macOS reads the
    /// second and third as a double and triple click. Returns the time just before the first mouse down.
    static func post(at point: CGPoint, count: Int) -> UInt64 {
        let postedAt = Clock.nowNs()
        for state in 1...max(count, 1) {
            post(point, state: state, down: true)
            Clock.sleepNs(holdNs)
            post(point, state: state, down: false)
            if state < count { Clock.sleepNs(holdNs) }
        }
        return postedAt
    }

    private static func post(_ point: CGPoint, state: Int, down: Bool) {
        guard let event = CGEvent(mouseEventSource: source,
                                  mouseType: down ? .leftMouseDown : .leftMouseUp,
                                  mouseCursorPosition: point,
                                  mouseButton: .left) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(state))
        event.post(tap: .cghidEventTap)
    }
}
