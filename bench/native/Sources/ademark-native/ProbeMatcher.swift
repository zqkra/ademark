import Foundation

enum ProbeMatcher {
    /// Ready when one recognized line holds two or more consecutive characters of the probe sequence.
    /// Runs come from the probe repeated twice, and lines are checked apart so characters on different
    /// lines never count as consecutive.
    static func matches(texts: [String], probe: String, minimumRun: Int = 2) -> Bool {
        guard minimumRun > 0 else { return false }
        let needle = normalize(probe)
        guard !needle.isEmpty else { return false }
        let runs = probeRuns(needle, minimumRun: minimumRun)
        guard !runs.isEmpty else { return false }
        return texts.contains { line in
            let haystack = normalize(line)
            return runs.contains { haystack.contains($0) }
        }
    }

    static func probeRuns(_ probe: String, minimumRun: Int = 2) -> [String] {
        let doubled = Array(probe + probe)
        guard doubled.count >= minimumRun else { return [] }
        var seen = Set<String>()
        var runs: [String] = []
        for start in 0...(doubled.count - minimumRun) {
            let run = String(doubled[start..<(start + minimumRun)])
            if seen.insert(run).inserted { runs.append(run) }
        }
        return runs
    }

    /// Pilot 2026-10-20: in Zeron's small composer font Vision reads "e" (and at times "a") as "•" ("ad•m"), so the
    /// typed "e" was lost and A8 counted 14 misses. The probe holds no bullet, so a bullet is read back as "e": it still
    /// counts as a typed character.
    static func normalize(_ text: String) -> String {
        let filtered = text.lowercased().replacingOccurrences(of: "\u{2022}", with: "e").unicodeScalars.filter { scalar in
            CharacterSet.alphanumerics.contains(scalar)
        }
        return String(String.UnicodeScalarView(filtered))
    }
}

/// Ready (TESTS.md §1.3) from frames in arrival order. Pilot 2026-10-20: a 2-character run also matches ordinary text
/// ("rk" in Claude Code's placeholder "how does <filepath> work?"), and probe text left by an earlier run matched at
/// once, giving A3 rows of 10 and 95 ms. So a frame is Ready only when it shows a probe run that is new against
/// everything seen before probing started (and the window's first frame) and that the typed characters can form.
struct EchoReadiness {
    private let runs: Set<String>
    private(set) var baseline = Set<String>()
    private var sawFrame = false
    private var typed: [Character] = []
    private var typedRuns = Set<String>()

    private let absent: String?
    /// echo --absent-region: the marker of the old thread, read in its own region of the same frame. This check must
    /// NOT see the marker for a frame to be Ready, so it errs toward seeing it: a missed marker would publish a time
    /// for a probe that echoed in the old thread, and a marker seen by mistake only makes a row invalid.
    let regionMarker: String?
    /// echo --absent-also: a longer text of the same marker line. The old thread is on screen when either is read.
    let regionAlso: String?

    init(probe: String, absent: String? = nil, absentHasRegion: Bool = false, absentAlso: String? = nil) {
        runs = Set(ProbeMatcher.probeRuns(ProbeMatcher.normalize(probe)))
        let normalized = absent.map { ProbeMatcher.normalize($0) } ?? ""
        let text = normalized.isEmpty ? nil : normalized
        self.absent = absentHasRegion ? nil : text
        regionMarker = absentHasRegion ? text : nil
        let also = absentAlso.map { ProbeMatcher.normalize($0) } ?? ""
        regionAlso = absentHasRegion && !also.isEmpty ? also : nil
    }

    /// Misread, dropped or added letters allowed for a marker of this length: 1 for "unchanged", 3 for a 21 letter line.
    static func regionMarkerEdits(_ marker: String) -> Int {
        max(1, marker.count / 7)
    }

    /// The old thread's marker in the lines of its own region. 2026-11-10, real window: Vision read "unchanged" as
    /// "unch&nged". The normalization drops the "&", so the word lost a letter, the substitution-only rule did not see
    /// it, and a probe beside the marker read as Ready. Edits (a wrong, missing or extra letter) are counted over all
    /// lines joined, and the longer text covers two wrong letters inside the short word.
    func regionMarkerShown(_ lines: [String]) -> Bool {
        guard let regionMarker else { return false }
        let text = Array(ProbeMatcher.normalize(lines.joined(separator: " ")))
        if TextMatcher.nearlyContains(text, Array(regionMarker), maxEdits: EchoReadiness.regionMarkerEdits(regionMarker)) {
            return true
        }
        guard let regionAlso else { return false }
        return TextMatcher.nearlyContains(text, Array(regionAlso), maxEdits: EchoReadiness.regionMarkerEdits(regionAlso))
    }

    /// What the composer lines alone say: a new probe run after the first frame. The capture reads the absent region
    /// only when this holds, so a frame that cannot be Ready costs no second OCR pass.
    func echoes(_ lines: [String]) -> Bool {
        guard sawFrame, !absentStillShown(lines) else { return false }
        return !runsIn(lines).subtracting(baseline).isDisjoint(with: typedRuns)
    }

    /// The old thread's draft is still in the region: whatever echoes there is not the new thread.
    func absentStillShown(_ lines: [String]) -> Bool {
        guard let absent else { return false }
        return ProbeMatcher.normalize(lines.joined(separator: " ")).contains(absent)
    }

    /// Frames shown before any probe key: their runs can never count as an echo.
    mutating func absorb(_ lines: [String]) {
        baseline.formUnion(runsIn(lines))
        sawFrame = true
    }

    mutating func typedCharacter(_ character: Character) {
        let normalized = ProbeMatcher.normalize(String(character))
        guard let next = normalized.first else { return }
        if let last = typed.last { typedRuns.insert(String([last, next])) }
        typed.append(next)
    }

    /// `absentLines`: the absent region of the same frame, nil when it was not read. With a region marker a frame whose
    /// region was not read is not Ready: the proof is not complete (ADEMARK-40).
    mutating func isReady(_ lines: [String], absentLines: [String]? = nil) -> Bool {
        // The first frame of a window that appeared after probing began is its starting state, not an echo.
        if !sawFrame {
            absorb(lines)
            return false
        }
        guard echoes(lines) else { return false }
        guard regionMarker != nil else { return true }
        guard let absentLines else { return false }
        return !regionMarkerShown(absentLines)
    }

    private func runsIn(_ lines: [String]) -> Set<String> {
        var found = Set<String>()
        for line in lines {
            let characters = Array(ProbeMatcher.normalize(line))
            guard characters.count >= 2 else { continue }
            for start in 0...(characters.count - 2) {
                let run = String(characters[start..<(start + 2)])
                if runs.contains(run) { found.insert(run) }
            }
        }
        return found
    }
}

enum TextMatcher {
    /// `maxSubstitutions` letters may be misread, as substitutions only and never more or fewer letters: Vision read Orca's
    /// "LEDGERMARK" as "LEDGEPNARK" and bb's "unchanged" as "unch3nged" (2026-11-08). The caller asks for it per marker;
    /// the default is exact, because insertions and deletions would let "threaded" stand for "THREAD-END".
    static func contains(_ texts: [String], needle: String, maxSubstitutions: Int = 0) -> Bool {
        let target = Array(ProbeMatcher.normalize(needle))
        guard !target.isEmpty else { return false }
        let exact = String(target)
        return texts.contains { line in
            let text = ProbeMatcher.normalize(line)
            if text.contains(exact) { return true }
            return maxSubstitutions > 0 && withinSubstitutions(Array(text), target, maxSubstitutions)
        }
    }

    /// The first needle, in the caller's order, that `texts` contain. The order is the caller's preference, not the order
    /// on screen: A11 lists the exact "THREAD-END" before Orca's misreads.
    static func firstNeedle(_ texts: [String], needles: [String], maxSubstitutions: Int = 0) -> String? {
        needles.first { contains(texts, needle: $0, maxSubstitutions: maxSubstitutions) }
    }

    /// The first needle, in the caller's order, that the lines joined nearly contain (`watch --nearly`): the same rule
    /// and the same number of edits as the echo's absent region.
    static func firstNearly(_ texts: [String], needles: [String]) -> String? {
        let text = Array(ProbeMatcher.normalize(texts.joined(separator: " ")))
        return needles.first { needle in
            let pattern = ProbeMatcher.normalize(needle)
            return nearlyContains(text, Array(pattern), maxEdits: EchoReadiness.regionMarkerEdits(pattern))
        }
    }

    /// True when some stretch of `text` is within `maxEdits` edits of `pattern` (a wrong, missing or extra letter each
    /// count one). Only the echo's absent region uses it: there a marker seen by mistake is the safe error.
    static func nearlyContains(_ text: [Character], _ pattern: [Character], maxEdits: Int) -> Bool {
        guard !pattern.isEmpty else { return false }
        // Sellers: column j holds the fewest edits between the pattern's first j letters and a stretch ending here.
        var previous = Array(0...pattern.count)
        if previous[pattern.count] <= maxEdits { return true }
        for letter in text {
            var current = [Int](repeating: 0, count: pattern.count + 1)
            for j in 1...pattern.count {
                let swap = previous[j - 1] + (pattern[j - 1] == letter ? 0 : 1)
                current[j] = min(swap, previous[j] + 1, current[j - 1] + 1)
            }
            if current[pattern.count] <= maxEdits { return true }
            previous = current
        }
        return false
    }

    /// True when some window of `text` as long as `target` differs from it in at most `limit` letters.
    static func withinSubstitutions(_ text: [Character], _ target: [Character], _ limit: Int) -> Bool {
        guard text.count >= target.count else { return false }
        for start in 0...(text.count - target.count) {
            var misses = 0
            for index in 0..<target.count where text[start + index] != target[index] {
                misses += 1
                if misses > limit { break }
            }
            if misses <= limit { return true }
        }
        return false
    }
}

/// EchoReadiness shared by the main loop (probe keys, the Ready scan) and the capture's frame queue (which asks whether
/// to read the absent region of a frame).
final class SharedReadiness {
    private let lock = NSLock()
    private var readiness: EchoReadiness

    init(_ readiness: EchoReadiness) {
        self.readiness = readiness
    }

    func absorb(_ lines: [String]) {
        lock.lock(); defer { lock.unlock() }
        readiness.absorb(lines)
    }

    func typedCharacter(_ character: Character) {
        lock.lock(); defer { lock.unlock() }
        readiness.typedCharacter(character)
    }

    func isReady(_ frame: FrameRecord) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return readiness.isReady(frame.lines, absentLines: frame.absentLines)
    }

    func echoes(_ lines: [String]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return readiness.echoes(lines)
    }
}
