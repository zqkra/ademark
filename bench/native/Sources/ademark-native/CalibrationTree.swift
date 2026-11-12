// Ported from Orca (native/computer-use-macos), MIT, see THIRD_PARTY_NOTICES.md.
import Foundation
import ApplicationServices
import CoreGraphics

/// One Accessibility node as calibration reads it. `element` is kept for ax-press and stays nil in the selftest.
struct AxNode {
    let role: String
    let subrole: String?
    let title: String?
    let value: String?
    let description: String?
    let identifier: String?
    let frame: CGRect?
    let enabled: Bool?
    let focused: Bool?
    let actions: [String]
    var children: [AxNode]
    var element: AXUIElement?

    init(role: String,
         subrole: String? = nil,
         title: String? = nil,
         value: String? = nil,
         description: String? = nil,
         identifier: String? = nil,
         frame: CGRect? = nil,
         enabled: Bool? = nil,
         focused: Bool? = nil,
         actions: [String] = [],
         children: [AxNode] = [],
         element: AXUIElement? = nil) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.value = value
        self.description = description
        self.identifier = identifier
        self.frame = frame
        self.enabled = enabled
        self.focused = focused
        self.actions = actions
        self.children = children
        self.element = element
    }
}

struct AxTree {
    let window: CGRect?
    let root: AxNode
    let nodes: Int
    let truncated: Bool
}

enum AxReader {
    static let defaultMaxDepth = 12
    static let defaultMaxNodes = 4000
    /// ax-press searches the whole app, so it walks deeper and wider than ax-tree prints.
    static let pressMaxDepth = 30
    static let pressMaxNodes = 20_000

    /// Depth-first pre-order, `maxDepth` levels including the root, at most `maxNodes` nodes, and frames relative to
    /// `window`.
    static func read(root: AXUIElement, window: CGRect?, maxDepth: Int, maxNodes: Int) -> AxTree {
        var state = WalkState(maxDepth: maxDepth, maxNodes: maxNodes)
        let node = build(root, window: window, depth: 0, state: &state)
        return AxTree(window: window,
                      root: node ?? AxNode(role: "AXUnknown"),
                      nodes: state.nodes,
                      truncated: state.truncated)
    }

    private struct WalkState {
        let maxDepth: Int
        let maxNodes: Int
        var nodes = 0
        var truncated = false
    }

    private static func build(_ element: AXUIElement, window: CGRect?, depth: Int, state: inout WalkState) -> AxNode? {
        guard state.nodes < state.maxNodes else {
            state.truncated = true
            return nil
        }
        var node = node(element, window: window)
        state.nodes += 1
        let children = CalibrationAX.children(element)
        guard !children.isEmpty else { return node }
        guard depth + 1 < state.maxDepth else {
            state.truncated = true
            return node
        }
        node.children = children.compactMap { build($0, window: window, depth: depth + 1, state: &state) }
        return node
    }

    static func node(_ element: AXUIElement, window: CGRect?) -> AxNode {
        let frame = CalibrationAX.frame(element).flatMap { absolute in
            window.map { CalibrationAX.relativeFrame(absolute, window: $0) }
        }
        return AxNode(
            role: CalibrationAX.truncate(CalibrationAX.string(element, kAXRoleAttribute as String) ?? "AXUnknown"),
            subrole: CalibrationAX.string(element, kAXSubroleAttribute as String).map { CalibrationAX.truncate($0) },
            title: CalibrationAX.string(element, kAXTitleAttribute as String).map { CalibrationAX.truncate($0) },
            value: CalibrationAX.valueString(element).map { CalibrationAX.truncate($0) },
            description: CalibrationAX.string(element, kAXDescriptionAttribute as String).map { CalibrationAX.truncate($0) },
            identifier: CalibrationAX.string(element, "AXIdentifier").map { CalibrationAX.truncate($0) },
            frame: frame,
            enabled: CalibrationAX.bool(element, kAXEnabledAttribute as String),
            focused: CalibrationAX.bool(element, kAXFocusedAttribute as String),
            actions: CalibrationAX.actions(element),
            element: element
        )
    }
}

enum CalibrationJSON {
    static func rect(_ rect: CGRect?) -> JSONValue {
        guard let rect else { return .null }
        return .object([
            ("x", .double(Double(rect.origin.x))),
            ("y", .double(Double(rect.origin.y))),
            ("w", .double(Double(rect.size.width))),
            ("h", .double(Double(rect.size.height))),
        ])
    }

    static func node(_ element: AxNode) -> JSONValue {
        let subrole: JSONValue = element.subrole.map { .string($0) } ?? .null
        let title: JSONValue = element.title.map { .string($0) } ?? .null
        let value: JSONValue = element.value.map { .string($0) } ?? .null
        let description: JSONValue = element.description.map { .string($0) } ?? .null
        let identifier: JSONValue = element.identifier.map { .string($0) } ?? .null
        let enabled: JSONValue = element.enabled.map { .bool($0) } ?? .null
        let focused: JSONValue = element.focused.map { .bool($0) } ?? .null
        return .object([
            ("role", .string(element.role)),
            ("subrole", subrole),
            ("title", title),
            ("value", value),
            ("description", description),
            ("identifier", identifier),
            ("frame", rect(element.frame)),
            ("enabled", enabled),
            ("focused", focused),
            ("actions", .array(element.actions.map { JSONValue.string($0) })),
            ("children", .array(element.children.map { CalibrationJSON.node($0) })),
        ])
    }
}
