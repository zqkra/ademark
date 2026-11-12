import Foundation

enum WatchCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.pid("--pid")
        let needles = try WatchTexts.parse(text: arguments.optionalString("--text"), texts: arguments.optionalString("--texts"))
        let region = try RectSpec.parse(try arguments.string("--region"), name: "--region")
        let triggers = try TriggerParser.parseArgument(try arguments.string("--triggers"))
        let timeoutS = try arguments.double("--timeout-s")
        guard timeoutS > 0 else { throw NativeError.badArguments("--timeout-s must be positive") }
        let framesPath = try arguments.string("--frames")
        // Letters the marker may have misread, as substitutions (TextMatcher). Omitted: exact.
        let fuzzy = try arguments.optionalString("--fuzzy").map { value -> Int in
            guard let count = Int(value), (0...3).contains(count) else { throw NativeError.badArguments("--fuzzy must be 0 to 3") }
            return count
        } ?? 0
        // --nearly: the rule of the echo's absent region (a wrong, missing or extra letter, over all lines joined). A3
        // reads the old thread's marker with it before the stopwatch, so both reads of one proof see the same text.
        let nearly = arguments.has("--nearly")
        if nearly && fuzzy > 0 { throw NativeError.badArguments("--nearly and --fuzzy cannot both be set") }
        let match: ([String]) -> String? = { lines in
            nearly ? TextMatcher.firstNearly(lines, needles: needles)
                   : TextMatcher.firstNeedle(lines, needles: needles, maxSubstitutions: fuzzy)
        }

        try Permissions.requireAccessibility()
        try Permissions.requireScreenRecording()

        let run = try CaptureRunStarter.begin(pid: pid, region: region, masks: [], videoPath: nil,
                                              triggers: triggers, focusClick: nil, timeoutS: timeoutS)
        let capture = run.capture
        let t0 = run.t0
        // Frames from a window the triggers left (a switched Ghostty tab) are not the shown thread.
        let earliest = max(t0, run.movedNs ?? 0)
        let deadline = t0 + UInt64(timeoutS * 1_000_000_000)
        var cursor = 0
        var seen: FrameRecord?
        var seenText: String?
        while Clock.nowNs() < deadline {
            let result = capture.store.firstMatching(from: cursor) { frame in
                frame.tNs >= earliest && match(frame.lines) != nil
            }
            cursor = result.nextIndex
            if let frame = result.frame {
                seen = frame
                seenText = match(frame.lines)
                break
            }
            Clock.sleepNs(2_000_000)
        }
        capture.stop()
        _ = capture.waitForStop()

        let records = capture.store.snapshot()
        try FramesFile.write(path: framesPath, records: records, cleared: nil)
        let ms = seen.map { Clock.nsToMs($0.tNs >= t0 ? $0.tNs - t0 : 0) }
        emit(.object([
            ("t0_ns", .uint(t0)),
            ("seen_ns", seen.map { JSONValue.uint($0.tNs) } ?? .null),
            ("ms", ms.map { JSONValue.double($0) } ?? .null),
            ("timed_out", .bool(seen == nil)),
            ("seen_text", seenText.map { JSONValue.string($0) } ?? .null),
        ]))
    }
}

/// `--text <one>` or `--texts <JSON array>`, never both. 2026-11-09: Orca's font read "LONGTHREAD-END" as
/// "L(NGTHREA&END" in all 1,148 drain frames, so A11 watches for Orca's spellings of its end marker too.
enum WatchTexts {
    static func parse(text: String?, texts: String?) throws -> [String] {
        switch (text, texts) {
        case (let one?, nil):
            guard !one.isEmpty else { throw NativeError.badArguments("missing --text") }
            return [one]
        case (nil, let list?):
            guard let data = list.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
                throw NativeError.badArguments("--texts must be a JSON array of strings")
            }
            let values = raw.compactMap { $0 as? String }
            guard values.count == raw.count, !values.isEmpty, !values.contains(where: \.isEmpty) else {
                throw NativeError.badArguments("--texts must be a JSON array of strings that are not empty")
            }
            return values
        case (nil, nil):
            throw NativeError.badArguments("missing --text")
        case (_?, _?):
            throw NativeError.badArguments("--text and --texts cannot both be set")
        }
    }
}

enum LagCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let region = try RectSpec.parse(try arguments.string("--region"), name: "--region")
        let count = try arguments.int("--count")
        let intervalMs = try arguments.int("--interval-ms")
        guard count > 0 else { throw NativeError.badArguments("--count must be positive") }
        guard intervalMs > 0 else { throw NativeError.badArguments("--interval-ms must be positive") }
        let framesPath = try arguments.string("--frames")
        let clearCombos = try ClearKeys.parse(arguments.optionalString("--clear"))

        try Permissions.requireAccessibility()
        try Permissions.requireScreenRecording()

        let started = Clock.nowNs()
        let capture = CaptureController(pid: pid, region: region, masks: [], videoPath: nil, baselineNs: started,
                                        signatures: true)
        guard try capture.waitAndStart(deadline: started + 30_000_000_000) else {
            throw NativeError.runtime(code: "window_not_found", message: "pid \(pid) showed no on-screen window")
        }
        let minColumns = LagRule.minColumns(scale: capture.target?.scale ?? 2)

        let probe = Array("ademarkqz")
        let intervalNs = UInt64(intervalMs) * 1_000_000
        var postTimes: [UInt64] = []
        var echoes: [UInt64?] = []
        var baseline = capture.store.snapshot().last?.normalizedText ?? ""
        var cursor = 0
        var typed = ""

        for index in 0..<count {
            let character = probe[index % probe.count]
            // The baseline is the text just before this keystroke, so a missed echo cannot
            // make later keystrokes look faster than they are.
            baseline = capture.store.snapshot().last?.normalizedText ?? baseline
            let postTime = Clock.nowNs()
            // Keys reach whatever app is frontmost, so a slot is only typed while this app is in
            // front. A skipped slot is counted as missed, never typed into another app.
            let posted = Frontmost.isFrontmost(pid)
            if posted {
                KeyPoster.typeCharacter(character)
                typed.append(character)
            }
            let deadline = LagRule.deadline(postNs: postTime)
            var seen: UInt64?
            let before = baseline
            let typedSoFar = typed
            let windowStart = postTime > LagRule.recentWindowNs ? postTime - LagRule.recentWindowNs : 0
            while posted, Clock.nowNs() < deadline {
                // Read again on every pass: a frame stamped just before the keystroke can arrive after it. A still
                // screen sends no frames, so the last frame before the keystroke always counts too.
                let earlier = capture.store.snapshot().filter { $0.tNs < postTime }
                let recent = (earlier.filter { $0.tNs >= windowStart } + earlier.suffix(1)).compactMap(\.columns)
                let result = capture.store.firstMatching(from: cursor) { frame in
                    guard frame.tNs >= postTime else { return false }
                    // Pixels when the capture has them; the OCR rule is the fallback.
                    if let columns = frame.columns, !recent.isEmpty {
                        return LagRule.pixelEchoed(frame: columns, recent: recent, minColumns: minColumns)
                    }
                    return LagRule.echoed(frameText: frame.normalizedText, baselineText: before, typed: typedSoFar)
                }
                cursor = result.nextIndex
                if let frame = result.frame {
                    seen = frame.tNs
                    baseline = frame.normalizedText
                    break
                }
                Clock.sleepNs(2_000_000)
            }
            postTimes.append(postTime)
            echoes.append(seen)
            let next = postTime + Clock.jittered(intervalNs)
            if next > Clock.nowNs() { Clock.sleepUntil(next) }
        }

        if Frontmost.isFrontmost(pid) {
            ClearKeys.press(clearCombos)
        }
        capture.stop()
        _ = capture.waitForStop()
        try FramesFile.write(path: framesPath, records: capture.store.snapshot(), cleared: nil)

        // probes_ms carries one slot per probe, so C3 can see the order of the lost ones (TESTS.md §1.6).
        let probes = LagRule.probeLatencies(postNs: postTimes, echoNs: echoes)
        let samples = probes.compactMap { $0 }
        let lost = probes.count - samples.count
        emit(.object([
            ("samples_ms", .array(samples.map { .double($0) })),
            ("p50", .double(Stats.percentileDouble(samples, 0.5))),
            ("p95", .double(Stats.percentileDouble(samples, 0.95))),
            ("lost", .int(Int64(lost))),
            ("probes_ms", .array(probes.map { $0.map { JSONValue.double($0) } ?? .null })),
        ]))
    }
}
