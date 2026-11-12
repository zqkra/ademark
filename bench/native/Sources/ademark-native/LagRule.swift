import Foundation

enum LagRule {
    /// TESTS.md A8 step 4: a keystroke with no echo within 2 s counts as missed.
    static let missNs: UInt64 = 2_000_000_000

    /// A keystroke is lost when its echo deadline passes with no frame whose text grew.
    static func isLost(echoNs: UInt64?, deadlineNs: UInt64) -> Bool {
        guard let echoNs else { return true }
        return echoNs > deadlineNs
    }

    static func deadline(postNs: UInt64) -> UInt64 {
        postNs &+ missNs
    }

    /// TESTS.md A8 step 3: "OCR reads one more probe character". The text growing is the plain case. Pilot
    /// 2026-10-20: Ghostty's block cursor is read as a letter after the last character ("ad" + cursor = "adl"), so
    /// the next keystroke ("ade") replaced that letter without growing the text and every `e` and `q` was lost.
    /// The keystroke also counts as echoed when the last two typed characters appear once more than before it.
    static func echoed(frameText: String, baselineText: String, typed: String) -> Bool {
        if frameText.count > baselineText.count { return true }
        let pair = String(ProbeMatcher.normalize(typed).suffix(2))
        guard pair.count == 2 else { return false }
        return occurrences(of: pair, in: frameText) > occurrences(of: pair, in: baselineText)
    }

    /// Pilot 2026-10-20: Vision's fast OCR misreads the last character while a text caret stands right after it
    /// ("m" + caret = "rn", "z" + caret = "4"), so in Zeron and T3 Code a keystroke was only read when the caret blinked
    /// off, 500-1,000 ms later. The echo is read from pixels instead: the first frame whose composer columns differ, by
    /// at least `minColumns`, from every frame of the `recent` window before the keystroke. A blinking caret (bar or
    /// block) only switches between states already in that window, so it never counts; a new glyph does.
    static let recentWindowNs: UInt64 = 1_200_000_000

    static func pixelEchoed(frame: [UInt32], recent: [[UInt32]], minColumns: Int) -> Bool {
        guard !recent.isEmpty else { return false }
        return recent.allSatisfy { ColumnSignature.changedColumns(frame, $0) >= minColumns }
    }

    /// Columns a new glyph changes at least: 3 points, at the capture's scale.
    static func minColumns(scale: Double) -> Int {
        max(2, Int((3 * scale).rounded()))
    }

    /// Overlapping occurrences, so a repeated probe still counts each echo.
    static func occurrences(of needle: String, in text: String) -> Int {
        guard !needle.isEmpty, text.count >= needle.count else { return 0 }
        let chars = Array(text)
        let target = Array(needle)
        var count = 0
        for start in 0...(chars.count - target.count) where Array(chars[start..<start + target.count]) == target {
            count += 1
        }
        return count
    }

    /// One probe's latency, or nil when it was lost. The nil keeps the probe's slot: C3 needs the order.
    static func probeLatency(postNs: UInt64, echoNs: UInt64?) -> Double? {
        guard let echoNs, !isLost(echoNs: echoNs, deadlineNs: deadline(postNs: postNs)) else { return nil }
        return Clock.nsToMs(echoNs >= postNs ? echoNs - postNs : 0)
    }

    /// One entry per probe, in post order: the latency, or nil when the probe was lost.
    static func probeLatencies(postNs: [UInt64], echoNs: [UInt64?]) -> [Double?] {
        zip(postNs, echoNs).map { probeLatency(postNs: $0, echoNs: $1) }
    }
}
