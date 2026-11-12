import Foundation
import CoreGraphics
import ApplicationServices

enum KeyPoster {
    private static let source = CGEventSource(stateID: .hidSystemState)

    /// Pilot 2026-10-20: a key-up posted in the same instant as its key-down is dropped by Ghostty
    /// (Cmd+T opened no tab, Enter did nothing, typed text kept only its first two characters).
    /// With 10 ms between them every key arrived. Timed runs take t0 before the key-down, so the hold
    /// after it does not move t0.
    static let holdNs: UInt64 = 10_000_000

    static func press(_ combo: KeyCombo) {
        let flags = combo.eventFlags
        post(keyCode: combo.virtualKeyCode, flags: flags, unicode: nil, keyDown: true)
        Clock.sleepNs(holdNs)
        post(keyCode: combo.virtualKeyCode, flags: flags, unicode: nil, keyDown: false)
    }

    static func typeText(_ text: String) {
        for character in text {
            let units = Array(String(character).utf16)
            let (keyCode, flags) = physicalKey(for: character)
            post(keyCode: keyCode, flags: flags, unicode: units, keyDown: true)
            Clock.sleepNs(holdNs)
            post(keyCode: keyCode, flags: flags, unicode: units, keyDown: false)
        }
    }

    /// The real key for a letter, digit or space, with Shift for a capital, next to the Unicode text. Diri 0.11.2 reads
    /// the key code and ignores the text, so key code 0 typed every probe as "aaaa" (2026-11-07). Other characters keep
    /// key code 0 and travel as text only.
    static func physicalKey(for character: Character) -> (CGKeyCode, CGEventFlags) {
        if character == " " { return (0x31, []) }
        let lower = Character(character.lowercased())
        if let code = KeyCombo.letterKeyCodes[lower] {
            return (code, character.isUppercase ? .maskShift : [])
        }
        if let code = KeyCombo.digitKeyCodes[character] { return (code, []) }
        return (0, [])
    }

    static func typeCharacter(_ character: Character) {
        typeText(String(character))
    }

    static func click(at point: CGPoint) {
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
                                 mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                               mouseCursorPosition: point, mouseButton: .left) else { return }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    static func clearField() {
        let selectAll = KeyCombo(modifiers: [.maskCommand], key: .letter("a"))
        press(selectAll)
        press(KeyCombo(modifiers: [], key: .named(.delete)))
    }

    private static func post(keyCode: CGKeyCode, flags: CGEventFlags, unicode: [UniChar]?, keyDown: Bool) {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown) else { return }
        event.flags = flags
        if let unicode, !unicode.isEmpty {
            var units = unicode
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        }
        event.post(tap: .cghidEventTap)
    }
}

/// `--clear`: a comma-separated list of combos that empty a composer, pressed in order. Omitted: cmd+a, delete.
enum ClearKeys {
    static let defaultCombos = [KeyCombo(modifiers: [.maskCommand], key: .letter("a")),
                                KeyCombo(modifiers: [], key: .named(.delete))]

    static func parse(_ value: String?) throws -> [KeyCombo] {
        guard let value else { return defaultCombos }
        let combos = try value.split(separator: ",").map { try KeyCombo.parseArgument(String($0)) }
        guard !combos.isEmpty else { throw NativeError.badArguments("--clear needs at least one combo") }
        return combos
    }

    static func press(_ combos: [KeyCombo]) {
        for combo in combos { KeyPoster.press(combo) }
    }
}
