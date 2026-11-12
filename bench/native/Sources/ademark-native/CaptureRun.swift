import Foundation
import CoreGraphics
import AppKit

struct CaptureRun {
    let pid: Int32
    let t0: UInt64
    let capture: CaptureController
    /// Set when the triggers left another window in front and the capture moved to it; earlier frames are the old one's.
    var movedNs: UInt64? = nil
}

/// `--pid 0` names "the app the first open trigger launches", so a cold-start run can time an app
/// that does not exist yet. The pid is resolved lazily while the triggers run, never before them.
final class PidBox {
    private(set) var pid: Int32
    private let target: (bundleId: String?, appPath: String?)?
    private var bundleId: String?

    init(requested: Int32, triggers: [Trigger]) {
        pid = max(requested, 0)
        target = PidBox.firstOpenTarget(triggers)
        bundleId = PidBox.resolveBundleId(appPath: target?.appPath, bundleId: target?.bundleId)
    }

    /// Non-blocking: returns the pid once the app is running, without waiting.
    func current() -> Int32? {
        if pid > 0 { return pid }
        guard let bundleId else { return nil }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .filter { $0.processIdentifier > 0 }
        guard let app = running.max(by: { ($0.launchDate ?? .distantPast) < ($1.launchDate ?? .distantPast) }) else {
            return nil
        }
        pid = app.processIdentifier
        return pid
    }

    func wait(deadline: UInt64) -> Int32? {
        while Clock.nowNs() < deadline {
            if let resolved = current() { return resolved }
            MainLoop.sleep(20_000_000)
        }
        return current()
    }

    private static func firstOpenTarget(_ triggers: [Trigger]) -> (bundleId: String?, appPath: String?)? {
        for trigger in triggers {
            if case .open(let bundleId, let appPath, _) = trigger {
                return (bundleId, appPath)
            }
        }
        return nil
    }

    static func resolveBundleId(appPath: String?, bundleId: String?) -> String? {
        if let bundleId, !bundleId.isEmpty { return bundleId }
        guard let appPath else { return nil }
        let url = URL(fileURLWithPath: (appPath as NSString).expandingTildeInPath)
        return Bundle(url: url)?.bundleIdentifier
    }
}

enum CaptureRunStarter {
    /// Records t0 immediately before the committing trigger, runs the triggers, then starts capture on the
    /// pid's layer-0 window. Capture starts earlier when the window already exists, so a warm window
    /// is recorded from the beginning of the run.
    static func begin(pid requestedPid: Int32,
                      region: RectSpec,
                      masks: [RectSpec],
                      videoPath: String?,
                      triggers: [Trigger],
                      focusClick: PointSpec?,
                      timeoutS: Double,
                      regionIsSettleMask: Bool = false,
                      secondary: SecondaryRead? = nil) throws -> CaptureRun {
        let box = PidBox(requested: requestedPid, triggers: triggers)
        let started = Clock.nowNs()
        let deadline = started + UInt64(timeoutS * 1_000_000_000)

        var capture: CaptureController?
        if let pid = box.current() {
            let controller = CaptureController(pid: pid, region: region, masks: masks,
                                               videoPath: videoPath, baselineNs: started,
                                               regionIsSettleMask: regionIsSettleMask, secondary: secondary)
            if WindowFinder.frontmost(pid: pid) != nil {
                try controller.start()
            }
            capture = controller
        }

        // t0 is the committing action, the last trigger that is not a wait (TriggerRunner.run).
        var t0 = Clock.nowNs()
        // The target pid is read per trigger, because with --pid 0 it only exists once the open
        // trigger has launched the app.
        let skipped = try TriggerRunner.run(triggers, targetPid: { box.current() }, windowFrame: {
            guard let pid = box.current() else { return nil }
            return WindowFinder.frontmost(pid: pid)?.frame
        }, windowDeadline: deadline, onCommit: { t0 = $0 })

        // A skipped trigger means the run drove the wrong window, so no result can be trusted.
        if let failure = TriggerOutcome.error(skipped: skipped, pid: box.current()) {
            if let controller = capture {
                controller.stop()
                _ = controller.waitForStop()
            }
            throw failure
        }

        guard let pid = box.wait(deadline: deadline) else {
            throw NativeError.runtime(code: "app_not_found", message: "the app did not start in time")
        }
        let controller = capture ?? CaptureController(pid: pid, region: region, masks: masks,
                                                      videoPath: videoPath, baselineNs: started,
                                                      regionIsSettleMask: regionIsSettleMask, secondary: secondary)
        if !controller.isRunning {
            guard try controller.waitAndStart(deadline: deadline) else {
                throw NativeError.runtime(code: "window_not_found",
                                          message: "pid \(pid) showed no on-screen window at layer 0 within \(timeoutS) s")
            }
        }
        // A window the triggers opened elsewhere on screen moves the capture there (tabs in place need no move).
        let movedNs = try controller.followWindow()
        if let focusClick, let frame = controller.windowFrame(),
           Frontmost.waitUntilFrontmost(pid, deadline: deadline) {
            let space = WindowSpace(scale: 1, pixelWidth: frame.width, pixelHeight: frame.height)
            KeyPoster.click(at: space.screenPoint(windowOrigin: frame.origin, spec: focusClick))
        }
        return CaptureRun(pid: pid, t0: t0, capture: controller, movedNs: movedNs)
    }
}
