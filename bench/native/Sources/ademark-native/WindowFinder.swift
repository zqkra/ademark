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

    static func frontmost(pid: Int32) -> WindowSnapshot? {
        snapshots(pid: pid).first
    }

    static func wait(pid: Int32, until deadline: UInt64, pollNs: UInt64 = 20_000_000) -> WindowSnapshot? {
        while Clock.nowNs() < deadline {
            if let window = frontmost(pid: pid) { return window }
            MainLoop.sleep(pollNs)
        }
        return frontmost(pid: pid)
    }
}
