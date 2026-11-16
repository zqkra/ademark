import Foundation
import CoreGraphics
import AppKit

struct WindowSnapshot {
    let windowID: CGWindowID
    let frame: CGRect
}

enum WindowFinder {
    static func snapshots(pid: Int32) -> [WindowSnapshot] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let entries = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        var result: [WindowSnapshot] = []
        for entry in entries {
            guard let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, owner == pid else { continue }
            guard let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue, layer == 0 else { continue }
            guard let number = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
            guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.width >= 1, bounds.height >= 1 else { continue }
            if let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha <= 0.01 { continue }
            result.append(WindowSnapshot(windowID: CGWindowID(number), frame: bounds))
        }
        return result
    }

    /// While a window is captured, macOS puts the sharing control of its title bar in a window of its own: 66 x 20
    /// points, layer 0, owned by the app and in front of its window (measured 2026-11-15 on macOS 27.2.1, for as long
    /// as `watch` captured). A click measured from that one lands 16 points right and down of the calibrated point:
    /// 0 of 12 clicks during a capture hit their button, and 12 of 12 once it is passed over. No window a profile is
    /// calibrated on is under this side.
    static let minimumSide: CGFloat = 100

    static func frontmost(pid: Int32) -> WindowSnapshot? {
        frontmost(snapshots(pid: pid))
    }

    /// Front to back, the first window that is at least `minimumSide` wide and high. When none is, the first window.
    static func frontmost(_ windows: [WindowSnapshot]) -> WindowSnapshot? {
        windows.first { $0.frame.width >= minimumSide && $0.frame.height >= minimumSide } ?? windows.first
    }

    static func wait(pid: Int32, until deadline: UInt64, pollNs: UInt64 = 20_000_000) -> WindowSnapshot? {
        while Clock.nowNs() < deadline {
            if let window = frontmost(pid: pid) { return window }
            MainLoop.sleep(pollNs)
        }
        return frontmost(pid: pid)
    }
}
