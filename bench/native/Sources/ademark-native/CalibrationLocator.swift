// Ported from Orca (native/computer-use-macos), MIT, see THIRD_PARTY_NOTICES.md.
import Foundation

/// Which element to press. Every given field must match; `index` picks among the matches in depth-first order.
struct AxLocator: Equatable {
    let role: String
    let title: String?
    let titleContains: String?
    let identifier: String?
    let description: String?
    let index: Int

    /// `--locator` takes a JSON object or a path to a file holding one, like `--triggers` and `--masks`.
    static func parseArgument(_ value: String) throws -> AxLocator {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") {
            return try parse(data: Data(trimmed.utf8))
        }
        return try parse(data: try requireFile((value as NSString).expandingTildeInPath))
    }

    static func parse(data: Data) throws -> AxLocator {
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw NativeError.badArguments("--locator is not valid JSON")
        }
        guard let root = raw as? [String: Any] else {
            throw NativeError.badArguments("--locator must be a JSON object")
        }
        guard let role = root["role"] as? String, !role.isEmpty else {
            throw NativeError.badArguments("--locator needs a role")
        }
        return AxLocator(role: role,
                         title: try text(root, "title"),
                         titleContains: try text(root, "titleContains"),
                         identifier: try text(root, "identifier"),
                         description: try text(root, "description"),
                         index: try integer(root, "index"))
    }

    func matches(_ node: AxNode) -> Bool {
        guard node.role == role else { return false }
        if let title, node.title != title { return false }
        if let titleContains, node.title?.contains(titleContains) != true { return false }
        if let identifier, node.identifier != identifier { return false }
        if let description, node.description != description { return false }
        return true
    }

    private static func text(_ root: [String: Any], _ key: String) throws -> String? {
        guard let raw = root[key], !(raw is NSNull) else { return nil }
        guard let value = raw as? String, !value.isEmpty else {
            throw NativeError.badArguments("--locator \(key) must be a non-empty string")
        }
        return value
    }

    private static func integer(_ root: [String: Any], _ key: String) throws -> Int {
        guard let raw = root[key], !(raw is NSNull) else { return 0 }
        guard !(raw is Bool),
              let number = raw as? NSNumber,
              number.doubleValue >= 0,
              number.doubleValue == number.doubleValue.rounded(),
              number.doubleValue <= Double(Int32.max) else {
            throw NativeError.badArguments("--locator \(key) must be 0 or a positive integer")
        }
        return number.intValue
    }
}

enum AxLocatorMatch {
    struct Match {
        let matches: Int
        let node: AxNode?
    }

    /// The nodes under `root` in depth-first pre-order, the order `index` counts.
    static func depthFirst(_ root: AxNode) -> [AxNode] {
        var nodes: [AxNode] = []
        var stack = [root]
        while let node = stack.popLast() {
            nodes.append(node)
            stack.append(contentsOf: node.children.reversed())
        }
        return nodes
    }

    /// The locator's element, plus how many nodes matched so a miss can name the count.
    static func pick(_ locator: AxLocator, in nodes: [AxNode]) -> Match {
        let matched = nodes.filter { locator.matches($0) }
        guard locator.index >= 0, locator.index < matched.count else {
            return Match(matches: matched.count, node: nil)
        }
        return Match(matches: matched.count, node: matched[locator.index])
    }
}
