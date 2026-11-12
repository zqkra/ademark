import Foundation
import CoreGraphics

struct ScrollOptions {
    let pid: Int32
    let region: RectSpec
    let count: Int
    let hz: Double
    let lines: Int
    let framesPath: String
}

enum ScrollWheel {
    private static let source = CGEventSource(stateID: .hidSystemState)

    /// Line-based wheel events, positive `lines` toward the top (TESTS.md A11).
    static func post(lines: Int) {
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1,
                                  wheel1: Int32(clamping: lines), wheel2: 0, wheel3: 0) else { return }
        event.post(tap: .cghidEventTap)
    }
}

enum ScrollCommand {
    static func run(_ arguments: Arguments) throws {
        let options = try parse(arguments)

        try Permissions.requireAccessibility()
        try Permissions.requireScreenRecording()

        let started = Clock.nowNs()
        let capture = CaptureController(pid: options.pid, region: options.region, masks: [],
                                        videoPath: nil, baselineNs: started)
        guard try capture.waitAndStart(deadline: started + 30_000_000_000) else {
            throw NativeError.runtime(code: "window_not_found",
                                      message: "pid \(options.pid) showed no on-screen window at layer 0 within 30 s")
        }

        // Scroll events go to the window under the pointer, so move it into the region first. A
        // warp is only safe while the measured app is frontmost, like every other posting command.
        if Frontmost.isFrontmost(options.pid), let frame = capture.windowFrame() {
            let center = PointSpec(x: options.region.x + options.region.w / 2,
                                   y: options.region.y + options.region.h / 2)
            let space = WindowSpace(scale: 1, pixelWidth: frame.width, pixelHeight: frame.height)
            _ = CGWarpMouseCursorPosition(space.screenPoint(windowOrigin: frame.origin, spec: center))
            // A warp can leave the cursor disassociated until the next hardware event.
            _ = CGAssociateMouseAndMouseCursorPosition(1)
        }

        let intervalNs = max(UInt64(1_000_000_000 / options.hz), 1)
        let t0 = Clock.nowNs()
        var posted = 0
        var skipped = 0
        var lastPostNs = t0
        for index in 0..<options.count {
            if Frontmost.isFrontmost(options.pid) {
                ScrollWheel.post(lines: options.lines)
                lastPostNs = Clock.nowNs()
                posted += 1
            } else {
                skipped += 1
            }
            Clock.sleepUntil(t0 + UInt64(index + 1) * intervalNs)
        }
        // The scroll window ends one event interval after the last event was posted (TESTS.md A11).
        let tEnd = lastPostNs + intervalNs
        // Keep capturing for a second after the last post, so the receipt has trailing frames.
        Clock.sleepNs(1_000_000_000)

        capture.stop()
        _ = capture.waitForStop()

        if let failure = TriggerOutcome.error(skipped: skipped, pid: options.pid) {
            throw failure
        }

        let records = capture.store.snapshot()
        try FramesFile.write(path: options.framesPath, records: records, cleared: nil)
        let gaps = FrameGaps.windowed(frameTimes: records.map { $0.tNs }, t0Ns: t0, tEndNs: tEnd)
        emit(.object([
            ("t0_ns", .uint(t0)),
            ("t_end_ns", .uint(tEnd)),
            ("posted", .int(Int64(posted))),
            ("frames", .int(Int64(records.count))),
            ("gaps_over_33ms", .int(Int64(gaps.gapsOver33ms))),
            ("max_gap_ms", .double(gaps.maxGapMs)),
        ]))
    }

    static func parse(_ arguments: Arguments) throws -> ScrollOptions {
        let pid = try arguments.int32("--pid")
        let region = try RectSpec.parse(try arguments.string("--region"), name: "--region")
        guard region.w > 0, region.h > 0 else {
            throw NativeError.badArguments("--region must have a positive width and height")
        }
        let count = try arguments.int("--count")
        guard count > 0 else { throw NativeError.badArguments("--count must be positive") }
        let hz = try arguments.double("--hz")
        guard hz > 0, hz <= 1000 else {
            throw NativeError.badArguments("--hz must be greater than 0 and at most 1000")
        }
        let lines = try arguments.int("--lines")
        let framesPath = try arguments.string("--frames")
        return ScrollOptions(pid: pid, region: region, count: count, hz: hz, lines: lines, framesPath: framesPath)
    }
}
