// Ported from Orca (native/computer-use-macos), MIT, see THIRD_PARTY_NOTICES.md.
import Foundation
import ApplicationServices
import CoreGraphics

enum AxTreeCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let depth = try positive(arguments, "--depth", default: AxReader.defaultMaxDepth, limit: 1000)
        let maxNodes = try positive(arguments, "--max-nodes", default: AxReader.defaultMaxNodes, limit: 200_000)
        let windowOnly = arguments.has("--window-only")

        try Permissions.requireAccessibility()
        guard ProcessTable.isAlive(pid) else {
            throw NativeError.runtime(code: "process_not_found", message: "pid \(pid) is not running")
        }
        let app = CalibrationAX.appElement(pid)
        CalibrationAX.enableManualAccessibilityIfNeeded(app, pid: pid)

        let window = CalibrationAX.targetWindow(app)
        let windowFrame = window.flatMap { CalibrationAX.frame($0) }
        let root: AXUIElement
        if windowOnly {
            guard let window else {
                throw NativeError.runtime(code: "window_not_found", message: "pid \(pid) has no accessible window")
            }
            root = window
        } else {
            root = app
        }

        let tree = AxReader.read(root: root, window: windowFrame, maxDepth: depth, maxNodes: maxNodes)
        emit(.object([
            ("pid", .int(Int64(pid))),
            ("window", CalibrationJSON.rect(tree.window)),
            ("nodes", .int(Int64(tree.nodes))),
            ("truncated", .bool(tree.truncated)),
            ("root", CalibrationJSON.node(tree.root)),
        ]))
    }

    private static func positive(_ arguments: Arguments, _ name: String, default value: Int, limit: Int) throws -> Int {
        guard let raw = arguments.optionalString(name) else { return value }
        guard let number = Int(raw), number > 0, number <= limit else {
            throw NativeError.badArguments("\(name) must be between 1 and \(limit)")
        }
        return number
    }
}
