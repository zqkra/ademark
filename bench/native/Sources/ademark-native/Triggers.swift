import Foundation
import AppKit

enum Trigger {
    case open(bundleId: String?, appPath: String?, args: [String])
    case keys(KeyCombo)
    case type(String)
    case click(PointSpec)
    case enter
    case wait(Int)
}

enum TriggerParser {
    /// `--triggers` takes a JSON array or a path to a file holding one.
    static func parseArgument(_ value: String) throws -> [Trigger] {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("[") {
            return try parse(string: trimmed)
        }
        return try parse(data: try requireFile((value as NSString).expandingTildeInPath))
    }

    static func parseFile(_ path: String) throws -> [Trigger] {
        try parse(data: try requireFile(path))
    }

    static func parse(string: String) throws -> [Trigger] {
        guard let data = string.data(using: .utf8) else {
            throw NativeError.badArguments("triggers are not valid UTF-8")
        }
        return try parse(data: data)
    }

    static func parse(data: Data) throws -> [Trigger] {
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [Any] else {
            throw NativeError.badArguments("triggers must be a JSON array")
        }
        return try raw.map { try parseOne($0) }
    }

    private static func parseOne(_ raw: Any) throws -> Trigger {
        guard let object = raw as? [String: Any], let kind = object["kind"] as? String else {
            throw NativeError.badArguments("trigger is missing kind")
        }
        switch kind {
        case "open":
            let bundleId = object["bundleId"] as? String
            let appPath = object["appPath"] as? String
            guard bundleId != nil || appPath != nil else {
                throw NativeError.badArguments("open trigger needs bundleId or appPath")
            }
            let args = (object["args"] as? [Any])?.compactMap { $0 as? String } ?? []
            return .open(bundleId: bundleId, appPath: appPath, args: args)
        case "keys":
            guard let combo = object["combo"] as? String else {
                throw NativeError.badArguments("keys trigger needs combo")
            }
            return .keys(try KeyCombo.parseArgument(combo))
        case "type":
            guard let text = object["text"] as? String else {
                throw NativeError.badArguments("type trigger needs text")
            }
            return .type(text)
        case "click":
            guard let point = object["point"] as? [String: Any],
                  let x = (point["x"] as? NSNumber)?.doubleValue,
                  let y = (point["y"] as? NSNumber)?.doubleValue else {
                throw NativeError.badArguments("click trigger needs point {x,y}")
            }
            return .click(PointSpec(x: x, y: y))
        case "enter":
            return .enter
        case "wait":
            guard let ms = (object["ms"] as? NSNumber)?.intValue, ms >= 0 else {
                throw NativeError.badArguments("wait trigger needs ms")
            }
            return .wait(ms)
        default:
            throw NativeError.badArguments("unknown trigger kind: \(kind)")
        }
    }
}

enum TriggerRunner {
    /// Keys, text and clicks reach whatever app is frontmost, so each one waits until `targetPid`
    /// is in front and is skipped otherwise. The skipped count is returned and never ignored: the
    /// caller fails the run, because a skipped trigger means it drove the wrong window.
    ///
    /// `onCommit` receives the clock right before the last trigger that is not a wait runs: the action that commits
    /// the step. Earlier triggers (opening a dialog or a palette) and fixed waits are setup, so a stopwatch that starts
    /// there does not count our own waits (2026-11-07: Orca's 2.5 s wait read as a 2.7 s thread open).
    static func run(_ triggers: [Trigger],
                    targetPid: () -> Int32?,
                    windowFrame: () -> CGRect?,
                    windowDeadline: UInt64,
                    onCommit: (UInt64) -> Void = { _ in }) throws -> Int {
        var skipped = 0
        let commitIndex = triggers.lastIndex { trigger in
            if case .wait = trigger { return false }
            return true
        }
        for (index, trigger) in triggers.enumerated() {
            if index == commitIndex { onCommit(Clock.nowNs()) }
            switch trigger {
            case .open(let bundleId, let appPath, let args):
                try openApplication(bundleId: bundleId, appPath: appPath, args: args)
            case .keys(let combo):
                if waitForTarget(targetPid, deadline: windowDeadline) {
                    KeyPoster.press(combo)
                } else {
                    skipped += 1
                }
            case .type(let text):
                if waitForTarget(targetPid, deadline: windowDeadline) {
                    KeyPoster.typeText(text)
                } else {
                    skipped += 1
                }
            case .enter:
                if waitForTarget(targetPid, deadline: windowDeadline) {
                    KeyPoster.press(KeyCombo(modifiers: [], key: .named(.enter)))
                } else {
                    skipped += 1
                }
            case .wait(let ms):
                Clock.sleepNs(UInt64(ms) * 1_000_000)
            case .click(let point):
                guard let frame = waitForWindow(windowFrame, deadline: windowDeadline) else {
                    throw NativeError.runtime(code: "window_not_found", message: "click trigger found no window")
                }
                guard waitForTarget(targetPid, deadline: windowDeadline) else {
                    skipped += 1
                    continue
                }
                let screenPoint = WindowSpace(scale: 1, pixelWidth: frame.width, pixelHeight: frame.height)
                    .screenPoint(windowOrigin: frame.origin, spec: point)
                KeyPoster.click(at: screenPoint)
            }
        }
        return skipped
    }

    /// True only when the measured app is frontmost, so the post cannot land in another app.
    private static func waitForTarget(_ targetPid: () -> Int32?, deadline: UInt64) -> Bool {
        guard let pid = targetPid() else { return false }
        return Frontmost.waitUntilFrontmost(pid, deadline: deadline)
    }

    private static func waitForWindow(_ windowFrame: () -> CGRect?, deadline: UInt64) -> CGRect? {
        while Clock.nowNs() < deadline {
            if let frame = windowFrame() { return frame }
            MainLoop.sleep(20_000_000)
        }
        return windowFrame()
    }

    private static func openApplication(bundleId: String?, appPath: String?, args: [String]) throws {
        var url: URL?
        if let appPath, !appPath.isEmpty {
            url = URL(fileURLWithPath: (appPath as NSString).expandingTildeInPath)
        } else if let bundleId {
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
        }
        guard let url else {
            throw NativeError.runtime(code: "app_not_found",
                                      message: "cannot resolve \(bundleId ?? appPath ?? "application")")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = args
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
        // NSWorkspace dispatches the launch on the main queue; give it one turn before the next trigger.
        MainLoop.sleep(20_000_000)
    }
}
