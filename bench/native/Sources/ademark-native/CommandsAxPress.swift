// Ported from Orca (native/computer-use-macos), MIT, see THIRD_PARTY_NOTICES.md.
import Foundation
import ApplicationServices

enum AxPressCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let locator = try AxLocator.parseArgument(try arguments.string("--locator"))

        try Permissions.requireAccessibility()
        guard ProcessTable.isAlive(pid) else {
            throw NativeError.runtime(code: "process_not_found", message: "pid \(pid) is not running")
        }
        let app = CalibrationAX.appElement(pid)
        CalibrationAX.enableManualAccessibilityIfNeeded(app, pid: pid)
        let window = CalibrationAX.targetWindow(app).flatMap { CalibrationAX.frame($0) }
        let tree = AxReader.read(root: app, window: window,
                                 maxDepth: AxReader.pressMaxDepth, maxNodes: AxReader.pressMaxNodes)
        let match = AxLocatorMatch.pick(locator, in: AxLocatorMatch.depthFirst(tree.root))
        guard let node = match.node, let element = node.element else {
            throw NativeError.runtime(code: "not_found",
                                      message: "no element matches \(describe(locator)) at index \(locator.index) "
                                          + "(\(match.matches) matched)")
        }
        guard CalibrationAX.actions(element).contains(kAXPressAction) else {
            throw NativeError.runtime(code: "no_press_action",
                                      message: "\(describe(locator)) has no AXPress action")
        }
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
            throw NativeError.runtime(code: "no_press_action", message: "AXPress failed on \(describe(locator))")
        }

        emit(.object([
            ("pressed", .bool(true)),
            ("matches", .int(Int64(match.matches))),
            ("frame", CalibrationJSON.rect(node.frame)),
        ]))
    }

    /// The locator's fields in one line, so the error says what was searched for.
    static func describe(_ locator: AxLocator) -> String {
        var parts = ["role \(locator.role)"]
        if let title = locator.title { parts.append("title \(title)") }
        if let titleContains = locator.titleContains { parts.append("title contains \(titleContains)") }
        if let identifier = locator.identifier { parts.append("identifier \(identifier)") }
        if let description = locator.description { parts.append("description \(description)") }
        return parts.joined(separator: ", ")
    }
}
