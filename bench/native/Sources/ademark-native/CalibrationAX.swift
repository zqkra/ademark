// Ported from Orca (native/computer-use-macos), MIT, see THIRD_PARTY_NOTICES.md.
import Foundation
import ApplicationServices

/// Accessibility reads for calibration: one element at a time, with a 0.5 s messaging timeout armed before every
/// read, so an app that stops answering cannot hang the helper.
enum CalibrationAX {
    static let messagingTimeout: Float = 0.5
    static let stringLimit = 200

    static func appElement(_ pid: Int32) -> AXUIElement {
        AXUIElementCreateApplication(pid)
    }

    /// Electron and Chromium apps keep their web content behind a private AX mode and otherwise expose an app element
    /// with no children. Turning the mode on makes the app build and walk its tree for every change, so it raises the
    /// app's memory and CPU: a measured run always relaunches the app after calibration, before timing anything.
    static func enableManualAccessibilityIfNeeded(_ app: AXUIElement, pid: Int32) {
        // Non-Chromium apps reject this attribute, and the failed call is harmless.
        _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        guard isChromiumApp(pid) else { return }
        _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    /// Electron apps may rename their framework (Codex Framework.framework), so names are not enough: any framework
    /// that ships Chromium's resource pak counts too.
    static func isChromiumApp(_ pid: Int32) -> Bool {
        guard let path = ProcessTable.executablePath(pid), let marker = path.range(of: ".app/Contents/") else {
            return false
        }
        let bundle = String(path[path.startIndex..<marker.lowerBound]) + ".app"
        let frameworksPath = bundle + "/Contents/Frameworks"
        guard let frameworks = try? FileManager.default.contentsOfDirectory(atPath: frameworksPath) else {
            return false
        }
        return frameworks.contains { name in
            guard name.hasSuffix(".framework") else { return false }
            if name.contains("Electron") || name.contains("Chromium") { return true }
            return FileManager.default.fileExists(
                atPath: frameworksPath + "/" + name + "/Versions/A/Resources/chrome_100_percent.pak")
        }
    }

    static func arm(_ element: AXUIElement) {
        _ = AXUIElementSetMessagingTimeout(element, messagingTimeout)
    }

    static func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        arm(element)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    /// An attribute that holds one element, such as `AXFocusedWindow`.
    static func child(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = copyAttribute(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    static func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        copyAttribute(element, attribute) as? [AXUIElement] ?? []
    }

    static func children(_ element: AXUIElement) -> [AXUIElement] {
        elements(element, kAXChildrenAttribute)
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = copyAttribute(element, attribute) else { return nil }
        if CFGetTypeID(value) == CFStringGetTypeID() {
            return value as? String
        }
        if CFGetTypeID(value) == CFURLGetTypeID() {
            return (value as? URL)?.absoluteString
        }
        return nil
    }

    static func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        copyAttribute(element, attribute) as? Bool
    }

    static func number(_ element: AXUIElement, _ attribute: String) -> NSNumber? {
        copyAttribute(element, attribute) as? NSNumber
    }

    /// Strings, numbers and booleans as text; any other value type is null.
    static func valueString(_ element: AXUIElement) -> String? {
        guard let value = copyAttribute(element, kAXValueAttribute) else { return nil }
        switch CFGetTypeID(value) {
        case CFStringGetTypeID():
            return value as? String
        case CFURLGetTypeID():
            return (value as? URL)?.absoluteString
        case CFBooleanGetTypeID():
            return (value as? Bool).map { $0 ? "true" : "false" }
        case CFNumberGetTypeID():
            return (value as? NSNumber)?.stringValue
        default:
            return nil
        }
    }

    static func actions(_ element: AXUIElement) -> [String] {
        arm(element)
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let values = names as? [String] else {
            return []
        }
        return values
    }

    /// The element's frame in screen points, top-left origin, from `AXPosition` and `AXSize`.
    static func frame(_ element: AXUIElement) -> CGRect? {
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard let position = copyAttribute(element, kAXPositionAttribute),
              CFGetTypeID(position) == AXValueGetTypeID(),
              AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &origin) else {
            return nil
        }
        guard let extent = copyAttribute(element, kAXSizeAttribute),
              CFGetTypeID(extent) == AXValueGetTypeID(),
              AXValueGetValue(unsafeDowncast(extent, to: AXValue.self), .cgSize, &size) else {
            return nil
        }
        guard size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// Window points are relative to the target window's top-left corner, the same as `Rect` everywhere else.
    static func relativeFrame(_ absolute: CGRect, window: CGRect) -> CGRect {
        CGRect(x: absolute.minX - window.minX, y: absolute.minY - window.minY,
               width: absolute.width, height: absolute.height)
    }

    /// Strings over `limit` characters are cut to `limit - 1` plus "…".
    static func truncate(_ text: String, limit: Int = stringLimit) -> String {
        guard limit > 0, text.count > limit else { return text }
        return String(text.prefix(limit - 1)) + "…"
    }

    /// The app's focused window, or its first usable window when none is focused.
    static func targetWindow(_ app: AXUIElement) -> AXUIElement? {
        if let focused = child(app, kAXFocusedWindowAttribute as String) {
            return focused
        }
        let windows = elements(app, kAXWindowsAttribute as String)
        return windows.first(where: isUsableWindow) ?? windows.first
    }

    static func isUsableWindow(_ window: AXUIElement) -> Bool {
        string(window, kAXRoleAttribute as String) == kAXWindowRole
            && bool(window, kAXMinimizedAttribute as String) != true
    }
}
