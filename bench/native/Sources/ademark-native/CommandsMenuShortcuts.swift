// Ported from Orca (native/computer-use-macos), MIT, see THIRD_PARTY_NOTICES.md.
import Foundation
import ApplicationServices

enum MenuShortcutsCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")

        try Permissions.requireAccessibility()
        guard ProcessTable.isAlive(pid) else {
            throw NativeError.runtime(code: "process_not_found", message: "pid \(pid) is not running")
        }
        let app = CalibrationAX.appElement(pid)
        CalibrationAX.enableManualAccessibilityIfNeeded(app, pid: pid)
        guard let menuBar = CalibrationAX.child(app, kAXMenuBarAttribute as String) else {
            throw NativeError.runtime(code: "runtime_error", message: "pid \(pid) exposes no menu bar")
        }

        let items = MenuWalk.items(menuBar)
        emit(.object([
            ("pid", .int(Int64(pid))),
            ("items", .array(items.map { item in
                .object([
                    ("path", .array(item.path.map { JSONValue.string($0) })),
                    ("combo", item.combo.map { JSONValue.string($0) } ?? .null),
                    ("enabled", .bool(item.enabled)),
                ])
            })),
        ]))
    }
}

struct MenuItemEntry {
    let path: [String]
    let combo: String?
    let enabled: Bool
}

enum MenuWalk {
    /// Depth is capped so a menu that reports itself as its own submenu ends.
    static let maxDepth = 12

    /// Every menu bar item except the Apple menu, then its menus' items, recursively into submenus.
    static func items(_ menuBar: AXUIElement) -> [MenuItemEntry] {
        var entries: [MenuItemEntry] = []
        for barItem in CalibrationAX.children(menuBar).dropFirst() {
            guard let title = CalibrationAX.string(barItem, kAXTitleAttribute as String), !title.isEmpty else {
                continue
            }
            entries.append(contentsOf: items(of: barItem, path: [title], depth: 0))
        }
        return entries
    }

    private static func items(of owner: AXUIElement, path: [String], depth: Int) -> [MenuItemEntry] {
        guard depth < maxDepth else { return [] }
        var entries: [MenuItemEntry] = []
        for menu in CalibrationAX.children(owner)
        where CalibrationAX.string(menu, kAXRoleAttribute as String) == kAXMenuRole {
            for item in CalibrationAX.children(menu)
            where CalibrationAX.string(item, kAXRoleAttribute as String) == kAXMenuItemRole {
                // A separator is a menu item with no title; it can never be named in a path.
                guard let title = CalibrationAX.string(item, kAXTitleAttribute as String), !title.isEmpty else {
                    continue
                }
                let itemPath = path + [title]
                entries.append(MenuItemEntry(path: itemPath,
                                             combo: combo(of: item),
                                             enabled: CalibrationAX.bool(item, kAXEnabledAttribute as String) ?? false))
                entries.append(contentsOf: items(of: item, path: itemPath, depth: depth + 1))
            }
        }
        return entries
    }

    private static func combo(of item: AXUIElement) -> String? {
        MenuCombo.combo(char: CalibrationAX.string(item, kAXMenuItemCmdCharAttribute as String),
                        virtualKey: CalibrationAX.number(item, kAXMenuItemCmdVirtualKeyAttribute as String)?.intValue,
                        modifiers: CalibrationAX.number(item, kAXMenuItemCmdModifiersAttribute as String)?.intValue)
    }
}
