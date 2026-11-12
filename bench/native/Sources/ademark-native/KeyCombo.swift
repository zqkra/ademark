import Foundation
import CoreGraphics

enum KeyComboError: Error, CustomStringConvertible {
    case empty
    case unknownModifier(String)
    case unknownKey(String)
    case missingKey

    var description: String {
        switch self {
        case .empty: return "empty key combination"
        case .unknownModifier(let value): return "unknown modifier: \(value)"
        case .unknownKey(let value): return "unknown key: \(value)"
        case .missingKey: return "key combination has no key"
        }
    }
}

struct KeyCombo {
    let modifiers: [CGEventFlags]
    let key: Key

    enum Key: Equatable {
        case letter(Character)
        case digit(Character)
        case named(NamedKey)

        var label: String {
            switch self {
            case .letter(let value): return String(value)
            case .digit(let value): return String(value)
            case .named(let value): return value.rawValue
            }
        }
    }

    enum NamedKey: String, CaseIterable {
        case enter, tab, escape, delete, space, left, right, up, down
    }

    /// Argument-level wrapper: an unparsable combo is a bad argument, not a runtime failure.
    static func parseArgument(_ text: String) throws -> KeyCombo {
        do {
            return try parse(text)
        } catch let error as KeyComboError {
            throw NativeError.badArguments(error.description)
        }
    }

    static func parse(_ text: String) throws -> KeyCombo {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { throw KeyComboError.empty }
        var parts = trimmed.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let keyPart = parts.popLast(), !keyPart.isEmpty else { throw KeyComboError.missingKey }

        var flags: [CGEventFlags] = []
        for part in parts {
            switch part {
            case "cmd", "command", "meta": flags.append(.maskCommand)
            case "shift": flags.append(.maskShift)
            case "alt", "option", "opt": flags.append(.maskAlternate)
            case "ctrl", "control": flags.append(.maskControl)
            default: throw KeyComboError.unknownModifier(part)
            }
        }
        guard let key = parseKey(keyPart) else { throw KeyComboError.unknownKey(keyPart) }
        return KeyCombo(modifiers: flags, key: key)
    }

    static func parseKey(_ text: String) -> Key? {
        if text.count == 1, let character = text.first, character.isASCII {
            if character.isLetter { return .letter(character) }
            if character.isNumber { return .digit(character) }
        }
        if let named = NamedKey(rawValue: text) { return .named(named) }
        return nil
    }

    var virtualKeyCode: CGKeyCode {
        switch key {
        case .letter(let character):
            return KeyCombo.letterKeyCodes[character] ?? 0
        case .digit(let character):
            return KeyCombo.digitKeyCodes[character] ?? 0
        case .named(let named):
            switch named {
            case .enter: return 0x24
            case .tab: return 0x30
            case .escape: return 0x35
            case .delete: return 0x33
            case .space: return 0x31
            case .left: return 0x7B
            case .right: return 0x7C
            case .down: return 0x7D
            case .up: return 0x7E
            }
        }
    }

    var eventFlags: CGEventFlags {
        modifiers.reduce(into: CGEventFlags()) { $0.insert($1) }
    }

    static let letterKeyCodes: [Character: CGKeyCode] = [
        "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03, "g": 0x05,
        "h": 0x04, "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D,
        "o": 0x1F, "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11, "u": 0x20,
        "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10, "z": 0x06,
    ]

    static let digitKeyCodes: [Character: CGKeyCode] = [
        "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
        "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
    ]
}
