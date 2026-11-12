import Foundation
import ApplicationServices
import AppKit

enum AxWindow {
    static func firstStandardWindow(pid: Int32) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        guard let raw = copyAttribute(app, kAXWindowsAttribute), let windows = raw as? [AXUIElement] else {
            return nil
        }
        let standard = windows.first { window in
            guard let subrole = copyAttribute(window, kAXSubroleAttribute) as? String else { return false }
            return subrole == kAXStandardWindowSubrole
        }
        return standard ?? windows.first
    }

    static func apply(position: CGPoint, size: CGSize, to window: AXUIElement) -> CGRect {
        var point = position
        var extent = size
        if let value = AXValueCreate(.cgPoint, &point) {
            AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value)
        }
        if let value = AXValueCreate(.cgSize, &extent) {
            AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
        }
        return frame(of: window) ?? CGRect(origin: position, size: size)
    }

    static func frame(of window: AXUIElement) -> CGRect? {
        var point = CGPoint.zero
        var size = CGSize.zero
        var hasPoint = false
        var hasSize = false
        if let raw = copyAttribute(window, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
            hasPoint = AXValueGetValue(unsafeDowncast(raw, to: AXValue.self), .cgPoint, &point)
        }
        if let raw = copyAttribute(window, kAXSizeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
            hasSize = AXValueGetValue(unsafeDowncast(raw, to: AXValue.self), .cgSize, &size)
        }
        guard hasPoint && hasSize, size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: point, size: size)
    }

    static func raise(_ window: AXUIElement, pid: Int32) {
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    }

    static func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}
