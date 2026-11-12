import Foundation
import CoreGraphics
import AppKit

enum CoverCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let durationS = try arguments.double("--duration-s")
        guard durationS >= 0, durationS <= 86_400 else {
            throw NativeError.badArguments("--duration-s must be between 0 and 86400")
        }

        let deadline = Clock.nowNs() + 5_000_000_000
        guard let window = WindowFinder.wait(pid: pid, until: deadline) else {
            throw NativeError.runtime(code: "window_not_found",
                                      message: "pid \(pid) showed no on-screen window at layer 0 within 5 s")
        }

        // AppKit needs an application before it can own a window, and an accessory app never shows
        // up in the Dock or takes activation.
        let app = NSApplication.shared
        _ = app.setActivationPolicy(.accessory)

        let appKitFrame = ScreenGeometry.appKitFrame(cgFrame: window.frame,
                                                    primaryHeight: ScreenGeometry.primaryHeight)
        let panel = NSPanel(contentRect: appKitFrame,
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered,
                            defer: false)
        panel.isOpaque = true
        panel.backgroundColor = .black
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
        panel.contentView?.wantsLayer = true
        panel.contentView?.layer?.backgroundColor = NSColor.black.cgColor

        let stop = SignalStop()

        panel.orderFrontRegardless()
        let shownNs = Clock.nowNs()
        let endNs = shownNs + Clock.secondsToNs(durationS)
        while !stop.isRequested && Clock.nowNs() < endNs {
            MainLoop.sleep(20_000_000)
        }

        panel.orderOut(nil)
        panel.close()
        let closedNs = Clock.nowNs()

        emit(.object([
            ("window_id", .uint(UInt64(window.windowID))),
            ("frame", .object([
                ("x", .double(Double(window.frame.origin.x))),
                ("y", .double(Double(window.frame.origin.y))),
                ("w", .double(Double(window.frame.size.width))),
                ("h", .double(Double(window.frame.size.height))),
            ])),
            ("shown_ns", .uint(shownNs)),
            ("closed_ns", .uint(closedNs)),
        ]))
    }
}
