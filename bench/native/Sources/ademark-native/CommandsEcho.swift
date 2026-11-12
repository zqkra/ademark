import Foundation
import CoreGraphics

struct EchoOptions {
    let pid: Int32
    let triggers: [Trigger]
    let region: RectSpec
    let focusClick: PointSpec?
    let probe: String
    let intervalMs: Int
    let timeoutS: Double
    /// From t0 to the end of the settle poll (TESTS.md §1.3: default 5 s, the pilot lost a third of Track A to 30 s).
    let settleCapNs: UInt64
    let framesPath: String
    let videoPath: String?
    let masks: [RectSpec]
    /// Keys that empty the composer after Ready. Pilot 2026-10-20: cmd+a, delete selects the terminal's text in Ghostty
    /// and leaves Claude Code's input full, so the next run saw the old probe and read Ready at once; there ctrl+u works.
    let clearCombos: [KeyCombo]
    /// Text left as a draft in the old thread. Ready also needs it gone from the region, so a probe typed into the old
    /// composer while the new thread is still opening can never read as a new thread (2026-11-07).
    let absent: String?
    /// ADEMARK-40: with it, `absent` is a marker read in this region (the old thread's transcript), not in the composer.
    /// The region is read only on a frame whose composer would be Ready, and a frame that still shows the marker there
    /// is not Ready, so a probe that echoes in the old thread never counts.
    let absentRegion: RectSpec?
    /// A longer text of the marker line, read in the same region: the old thread is on screen when either is read.
    let absentAlso: String?
}

struct EchoResult {
    let t0Ns: UInt64
    let readyNs: UInt64?
    let readyMs: Double?
    let settledMs: Double?
    let frames: Int
    let timedOut: Bool
    /// With --absent: whether the old thread's draft was read in the region in any frame. Without it the guard proved
    /// nothing, and A3 does not trust the time (council, 2026-11-08).
    let absentSeen: Bool
    /// With --absent-region: the Ready frame's absent region was read and the marker was not in it.
    let absentChecked: Bool
}

enum EchoCommand {
    static func run(_ arguments: Arguments) throws {
        let options = try parse(arguments)
        try Permissions.requireAccessibility()
        try Permissions.requireScreenRecording()
        let result = try EchoRunner(options: options).run()
        emit(.object([
            ("t0_ns", .uint(result.t0Ns)),
            ("ready_ns", result.readyNs.map { JSONValue.uint($0) } ?? .null),
            ("ready_ms", result.readyMs.map { JSONValue.double($0) } ?? .null),
            ("settled_ms", result.settledMs.map { JSONValue.double($0) } ?? .null),
            ("frames", .int(Int64(result.frames))),
            ("timed_out", .bool(result.timedOut)),
            ("absent_seen", .bool(result.absentSeen)),
            ("absent_checked", .bool(result.absentChecked)),
        ]))
    }

    static func parse(_ arguments: Arguments) throws -> EchoOptions {
        let pid = try arguments.pid("--pid")
        let triggers = try TriggerParser.parseArgument(try arguments.string("--triggers"))
        let region = try RectSpec.parse(try arguments.string("--region"), name: "--region")
        let focusClick = try arguments.optionalString("--focus-click").map { try PointSpec.parse($0, name: "--focus-click") }
        let probe = try arguments.string("--probe")
        guard !probe.isEmpty else { throw NativeError.badArguments("--probe must not be empty") }
        let intervalMs = try arguments.int("--interval-ms")
        guard intervalMs > 0 else { throw NativeError.badArguments("--interval-ms must be positive") }
        let timeoutS = try arguments.double("--timeout-s")
        guard timeoutS > 0 else { throw NativeError.badArguments("--timeout-s must be positive") }
        let settleCapNs = try settleCapNs(arguments.optionalString("--settle-cap-s"))
        let framesPath = try arguments.string("--frames")
        let videoPath = arguments.optionalString("--video")
        let masks = try parseMasks(arguments.optionalString("--masks"))
        let clearCombos = try ClearKeys.parse(arguments.optionalString("--clear"))
        let absent = arguments.optionalString("--absent").flatMap { $0.isEmpty ? nil : $0 }
        let absentRegion = try arguments.optionalString("--absent-region").map { try RectSpec.parse($0, name: "--absent-region") }
        if absentRegion != nil && absent == nil {
            throw NativeError.badArguments("--absent-region needs --absent")
        }
        let absentAlso = arguments.optionalString("--absent-also").flatMap { $0.isEmpty ? nil : $0 }
        if absentAlso != nil && absentRegion == nil {
            throw NativeError.badArguments("--absent-also needs --absent-region")
        }
        return EchoOptions(pid: pid, triggers: triggers, region: region, focusClick: focusClick,
                           probe: probe, intervalMs: intervalMs, timeoutS: timeoutS, settleCapNs: settleCapNs,
                           framesPath: framesPath, videoPath: videoPath, masks: masks, clearCombos: clearCombos,
                           absent: absent, absentRegion: absentRegion, absentAlso: absentAlso)
    }

    static let defaultSettleCapS = 5.0
    static let maxSettleCapS = 30.0

    /// `--settle-cap-s` is optional; zero and anything over 30 s are rejected before any permission check or capture.
    static func settleCapNs(_ value: String?) throws -> UInt64 {
        guard let value else { return Clock.secondsToNs(defaultSettleCapS) }
        guard let seconds = Double(value), seconds.isFinite, seconds > 0, seconds <= maxSettleCapS else {
            throw NativeError.badArguments("--settle-cap-s must be greater than 0 and at most 30")
        }
        return Clock.secondsToNs(seconds)
    }

    /// `--masks` takes a JSON array or a path to a file holding one.
    static func parseMasks(_ value: String?) throws -> [RectSpec] {
        guard let value else { return [] }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let data = trimmed.hasPrefix("[") ? Data(trimmed.utf8) : try requireFile((value as NSString).expandingTildeInPath)
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [Any] else {
            throw NativeError.badArguments("--masks must hold a JSON array")
        }
        return try raw.map { item in
            guard let object = item as? [String: Any],
                  let x = (object["x"] as? NSNumber)?.doubleValue,
                  let y = (object["y"] as? NSNumber)?.doubleValue,
                  let w = (object["w"] as? NSNumber)?.doubleValue,
                  let h = (object["h"] as? NSNumber)?.doubleValue else {
                throw NativeError.badArguments("mask must be {x,y,w,h}")
            }
            return RectSpec(x: x, y: y, w: w, h: h)
        }
    }
}

final class EchoRunner {
    private let options: EchoOptions

    init(options: EchoOptions) {
        self.options = options
    }

    func run() throws -> EchoResult {
        let readiness = SharedReadiness(EchoReadiness(probe: options.probe, absent: options.absent,
                                                      absentHasRegion: options.absentRegion != nil,
                                                      absentAlso: options.absentAlso))
        let secondary = options.absentRegion.map { region in
            SecondaryRead(region: region, shouldRead: { readiness.echoes($0) })
        }
        let run = try CaptureRunStarter.begin(pid: options.pid,
                                             region: options.region,
                                             masks: options.masks,
                                             videoPath: options.videoPath,
                                             triggers: options.triggers,
                                             focusClick: options.focusClick,
                                             timeoutS: options.timeoutS,
                                             regionIsSettleMask: true,
                                             secondary: secondary)
        let capture = run.capture
        let t0 = run.t0

        let readyFrame = typeUntilReady(capture: capture, pid: run.pid, t0: t0, movedNs: run.movedNs, readiness: readiness)

        // Clear the composer with the clear keys (default cmd+a, delete). Never Enter. Only when the measured app is
        // frontmost, because these events reach whatever app is in front.
        let cleared = Frontmost.isFrontmost(run.pid)
        if cleared {
            ClearKeys.press(options.clearCombos)
        }

        // Visually settled: the first frame after which no dirty rect outside the masks (the probe region included,
        // so the blinking caret does not count) appears for 1 s, capped at --settle-cap-s from t0 (TESTS.md §1.3).
        // Capture stops as soon as the window settles or the cap is reached.
        let settleCap = t0 + options.settleCapNs
        var settledNs: UInt64?
        while Clock.nowNs() < settleCap {
            settledNs = capture.store.firstSettled(t0: t0, capNs: options.settleCapNs, quietNs: 1_000_000_000)
            if settledNs != nil { break }
            Clock.sleepNs(20_000_000)
        }
        capture.stop()
        _ = capture.waitForStop()

        let records = capture.store.snapshot()
        try FramesFile.write(path: options.framesPath, records: records, cleared: cleared)
        if settledNs == nil {
            settledNs = SettledFinder.firstSettled(samples: records.map { $0.dirtySample }, t0: t0,
                                                   capNs: options.settleCapNs, quietNs: 1_000_000_000)
        }

        let readyMs = readyFrame.map { Clock.nsToMs($0.tNs >= t0 ? $0.tNs - t0 : 0) }
        let settledMs = settledNs.map { Clock.nsToMs($0 >= t0 ? $0 - t0 : 0) }
        let guardReader = EchoReadiness(probe: options.probe, absent: options.absent,
                                        absentHasRegion: options.absentRegion != nil, absentAlso: options.absentAlso)
        // Only frames before the accepted Ready count: a later read cannot vouch for an earlier echo. With a region,
        // absent_seen says the probe echoed while the old thread's marker was still on screen.
        let readyAt = readyFrame?.tNs ?? UInt64.max
        let absentSeen = options.absent == nil ? false : records.contains { record in
            guard record.tNs < readyAt else { return false }
            if options.absentRegion != nil { return record.absentLines.map(guardReader.regionMarkerShown) ?? false }
            return guardReader.absentStillShown(record.lines)
        }
        let absentChecked = options.absentRegion != nil && readyFrame.map { frame in
            frame.absentLines.map { !guardReader.regionMarkerShown($0) } ?? false
        } ?? false
        return EchoResult(t0Ns: t0,
                          readyNs: readyFrame?.tNs,
                          readyMs: readyMs,
                          settledMs: settledMs,
                          frames: records.count,
                          timedOut: readyFrame == nil,
                          absentSeen: absentSeen,
                          absentChecked: absentChecked)
    }

    /// Posts one probe character per interval, but only while the measured app is frontmost.
    /// A skipped slot keeps the clock running from t0: not being frontmost is part of "not ready yet".
    private func typeUntilReady(capture: CaptureController, pid: Int32, t0: UInt64, movedNs: UInt64?,
                                readiness: SharedReadiness) -> FrameRecord? {
        let characters = Array(options.probe)
        let intervalNs = UInt64(options.intervalMs) * 1_000_000
        let deadline = t0 + UInt64(options.timeoutS * 1_000_000_000)
        // Frames before t0, or from a window the triggers left, belong to the previous state and cannot count as ready.
        let earliest = max(t0, movedNs ?? 0)
        if let movedNs {
            // The new window's first frame is its starting state; wait briefly so it is read before any probe key.
            let waitUntil = min(deadline, Clock.nowNs() + 500_000_000)
            while Clock.nowNs() < waitUntil, capture.store.snapshot().last.map({ $0.tNs < movedNs }) ?? true {
                Clock.sleepNs(5_000_000)
            }
        }
        var cursor = 0
        for frame in capture.store.snapshot() {
            cursor += 1
            if frame.tNs >= (movedNs ?? 0) { readiness.absorb(frame.lines) }
        }
        var index = 0
        var nextProbe = Clock.nowNs()
        while Clock.nowNs() < deadline {
            let result = capture.store.firstMatching(from: cursor) { frame in
                frame.tNs >= earliest && readiness.isReady(frame)
            }
            cursor = result.nextIndex
            if let frame = result.frame { return frame }
            let now = Clock.nowNs()
            if now >= nextProbe {
                if Frontmost.isFrontmost(pid) {
                    let character = characters[index % characters.count]
                    readiness.typedCharacter(character)
                    KeyPoster.typeCharacter(character)
                    index += 1
                }
                nextProbe += Clock.jittered(intervalNs)
                if nextProbe < now { nextProbe = now + Clock.jittered(intervalNs) }
            }
            Clock.sleepNs(2_000_000)
        }
        return capture.store.firstMatching(from: cursor) { frame in
            frame.tNs >= earliest && readiness.isReady(frame)
        }.frame
    }

}
