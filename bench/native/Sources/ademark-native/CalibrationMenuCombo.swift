// Ported from Orca (native/computer-use-macos), MIT, see THIRD_PARTY_NOTICES.md.
import Foundation

/// A menu item's key equivalent as the combo string `keys --combo` accepts.
enum MenuCombo {
    /// `AXMenuItemCmdModifiers` bits: 0 shift, 1 option, 2 control, 3 "no command" (no cmd).
    static let shiftBit = 1
    static let optionBit = 2
    static let controlBit = 4
    static let noCommandBit = 8

    /// Modifiers in the order `ctrl+alt+shift+cmd`; cmd is on unless bit 3 is set.
    static func modifiers(mask: Int) -> [String] {
        var names: [String] = []
        if mask & controlBit != 0 { names.append("ctrl") }
        if mask & optionBit != 0 { names.append("alt") }
        if mask & shiftBit != 0 { names.append("shift") }
        if mask & noCommandBit == 0 { names.append("cmd") }
        return names
    }

    /// `AXMenuItemCmdVirtualKey` to a `KeyCombo` name. Keys `KeyCombo` has no name for (function keys, forward
    /// delete, and so on) are absent: their items report no combo rather than one that cannot be parsed.
    static let virtualKeyNames: [Int: String] = [
        0x24: "enter",
        0x30: "tab",
        0x35: "escape",
        0x33: "delete",
        0x31: "space",
        0x7B: "left",
        0x7C: "right",
        0x7D: "down",
        0x7E: "up",
    ]

    /// The item's character first (`AXMenuItemCmdChar` is often the uppercase letter), then its virtual key.
    static func keyName(char: String?, virtualKey: Int?) -> String? {
        if let char {
            let trimmed = char.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !trimmed.isEmpty, let key = KeyCombo.parseKey(trimmed) { return key.label }
        }
        if let virtualKey { return virtualKeyNames[virtualKey] }
        return nil
    }

    /// Nil when the item has no key equivalent, or one `KeyCombo` cannot name.
    static func combo(char: String?, virtualKey: Int?, modifiers mask: Int?) -> String? {
        guard let key = keyName(char: char, virtualKey: virtualKey) else { return nil }
        return (modifiers(mask: mask ?? 0) + [key]).joined(separator: "+")
    }
}
