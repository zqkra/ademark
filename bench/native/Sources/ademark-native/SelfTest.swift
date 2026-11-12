import Foundation
import CoreGraphics
import CoreText
import CoreMedia

struct SelfTestReport {
    private(set) var passed = 0
    private(set) var failed = 0
    private(set) var failures: [String] = []

    mutating func check(_ name: String, _ condition: Bool) {
        if condition {
            passed += 1
        } else {
            failed += 1
            failures.append(name)
        }
    }

    mutating func check(_ name: String, _ body: () throws -> Bool) {
        do {
            check(name, try body())
        } catch {
            failed += 1
            failures.append("\(name): \(error)")
        }
    }
}

enum SelfTest {
    static func run() -> SelfTestReport {
        var report = SelfTestReport()
        testKeyCombos(&report)
        testProbeMatcher(&report)
        testAttribution(&report)
        testClockConversion(&report)
        testStats(&report)
        testCanPost(&report)
        testFrameTime(&report)
        testLagRule(&report)
        testFramesFile(&report)
        testTriggerOutcome(&report)
        testSettled(&report)
        testFrameGaps(&report)
        testScreenGeometry(&report)
        testSampleDuration(&report)
        SelfTestTiming.tests(&report)
        testOcrRoundTrip(&report)
        SelfTestCalibration.run(&report)
        return report
    }

    private static func testKeyCombos(_ report: inout SelfTestReport) {
        let cases: [(String, [CGEventFlags], CGKeyCode)] = [
            ("cmd+shift+n", [.maskCommand, .maskShift], 0x2D),
            ("a", [], 0x00),
            ("alt+enter", [.maskAlternate], 0x24),
            ("option+tab", [.maskAlternate], 0x30),
            ("ctrl+space", [.maskControl], 0x31),
            ("cmd+0", [.maskCommand], 0x1D),
            ("escape", [], 0x35),
            ("cmd+delete", [.maskCommand], 0x33),
            ("shift+up", [.maskShift], 0x7E),
            ("cmd+ctrl+alt+shift+z", [.maskCommand, .maskControl, .maskAlternate, .maskShift], 0x06),
        ]
        for (text, flags, code) in cases {
            report.check("combo \(text)") {
                let combo = try KeyCombo.parse(text)
                return combo.eventFlags == flags.reduce(into: CGEventFlags()) { $0.insert($1) }
                    && combo.virtualKeyCode == code
            }
        }
        report.check("combo rejects unknown modifier") {
            do { _ = try KeyCombo.parse("nonsense+zz"); return false } catch { return true }
        }
        report.check("combo rejects unknown key") {
            do { _ = try KeyCombo.parse("cmd+notakey"); return false } catch { return true }
        }
        report.check("combo rejects empty") {
            do { _ = try KeyCombo.parse("  "); return false } catch { return true }
        }
    }

    private static func testProbeMatcher(_ report: inout SelfTestReport) {
        let probe = "ademarkqz"
        report.check("probe finds a run", ProbeMatcher.matches(texts: ["x ade x"], probe: probe))
        report.check("probe finds a short run", ProbeMatcher.matches(texts: ["DEM"], probe: probe))
        report.check("probe finds a run on a later line", ProbeMatcher.matches(texts: ["nothing", "adem"], probe: probe))
        report.check("probe ignores case", ProbeMatcher.matches(texts: ["ADEM"], probe: probe))
        report.check("probe rejects a single character", !ProbeMatcher.matches(texts: ["a"], probe: probe))
        report.check("probe rejects unrelated text", !ProbeMatcher.matches(texts: ["hello world"], probe: probe))
        report.check("probe rejects empty probe", !ProbeMatcher.matches(texts: ["ad"], probe: ""))
        report.check("probe rejects non-adjacent characters", !ProbeMatcher.matches(texts: ["a-x-d"], probe: probe))
        report.check("probe rejects a run split across lines", !ProbeMatcher.matches(texts: ["a", "d"], probe: probe))
        report.check("a bullet reads back as e", ProbeMatcher.normalize("ad•m") == "adem")
        report.check("probe ignores spaces inside a run", ProbeMatcher.matches(texts: ["a d e"], probe: probe))
        var placeholder = EchoReadiness(probe: probe)
        placeholder.absorb(["Try \"how does <filepath> work?\""])
        for character in "ademark" { placeholder.typedCharacter(character) }
        report.check("echo ignores a probe run that was on screen before probing",
                     !placeholder.isReady(["Ti'y 'how does <filepath> workR'"]))
        report.check("echo accepts the typed characters", placeholder.isReady(["ad"]))
        var early = EchoReadiness(probe: probe)
        early.absorb([])
        early.typedCharacter("a")
        report.check("echo rejects a run not typed yet", !early.isReady(["xd market"]))
        early.typedCharacter("d")
        report.check("echo accepts the first typed run", early.isReady(["ad"]))
        var late = EchoReadiness(probe: probe)
        for character in "ademarkqz" { late.typedCharacter(character) }
        report.check("echo treats a new window's first frame as its start", !late.isReady(["mark this work"]))
        report.check("echo then accepts a fresh run", late.isReady(["mark this work", "qz"]))
        var moved = EchoReadiness(probe: probe, absent: "HOLLOWPINE")
        moved.absorb(["HOLLOWPINE"])
        for character in "ademark" { moved.typedCharacter(character) }
        report.check("echo rejects an echo next to the old thread's draft", !moved.isReady(["HOLLOW PINE ademark"]))
        report.check("echo accepts it once the draft is gone", moved.isReady(["ademark"]))
        // ADEMARK-40: the old thread's marker in its own region (the transcript) of the same frame.
        var marked = EchoReadiness(probe: probe, absent: "unchanged", absentHasRegion: true)
        marked.absorb([])
        for character in "ademark" { marked.typedCharacter(character) }
        report.check("echo with an absent region is not Ready while the marker is there",
                     !marked.isReady(["ademark"], absentLines: ["The repository is unchanged."]))
        report.check("echo with an absent region is Ready once the marker is gone",
                     marked.isReady(["ademark"], absentLines: ["New thread"]))
        report.check("echo with an absent region still sees the marker with one misread letter",
                     !marked.isReady(["ademark"], absentLines: ["repository Is unch3nged."]))
        report.check("echo with an absent region is not Ready when the region was not read",
                     !marked.isReady(["ademark"], absentLines: nil))
        report.check("echo with an absent region does not look for the marker in the composer",
                     marked.isReady(["unchanged ademark"], absentLines: []))
        report.check("echo with an absent region never takes changed for the marker",
                     marked.isReady(["ademark"], absentLines: ["3 files changed"]))
        report.check("the capture reads the absent region only on a frame that echoes",
                     marked.echoes(["ademark"]) && !marked.echoes(["nothing typed here"]))
        // Offline, with OCR read on the real screen on 2026-11-09 and 10. The absent region errs toward seeing the
        // marker: one wrong, missing or extra letter still counts, and a longer text covers two wrong letters.
        let draft = EchoReadiness(probe: probe, absent: "HOLLOWPINE", absentHasRegion: true)
        report.check("9 Nov OCR: Paseo's HOLLOWPINO is the marker", draft.regionMarkerShown(["HOLLOWPINO"]))
        report.check("9 Nov OCR: MonoCode's HOLLOWPINd is the marker", draft.regionMarkerShown(["HOLLOWPINd"]))
        report.check("9 Nov OCR: Claude desktop's INEHOLLOWPINEHOLLOWPIN holds the marker",
                     draft.regionMarkerShown(["INEHOLLOWPINEHOLLOWPIN"]))
        report.check("9 Nov OCR: Paseo's deHOLLOWPIN lost a letter and is still the marker",
                     draft.regionMarkerShown(["deHOLLOWPIN"]))
        let realLine = "Seeded. Thls thre&d is open and th2 repository is unch&nged."
        report.check("10 Nov OCR, real window: unch&nged is the marker", marked.regionMarkerShown([realLine]))
        report.check("a dropped letter is the marker", marked.regionMarkerShown(["repository is unchnged"]))
        report.check("an extra letter is the marker", marked.regionMarkerShown(["repository is unchaanged"]))
        report.check("two wrong letters in the word alone are not the marker", !marked.regionMarkerShown(["is unch&ng2d."]))
        let lined = EchoReadiness(probe: probe, absent: "unchanged", absentHasRegion: true,
                                  absentAlso: "repository is unchanged")
        report.check("two wrong letters are the marker when the line is read",
                     lined.regionMarkerShown(["and th2 repository is unch&ng2d."]))
        report.check("the marker line wrapped over two lines is the marker",
                     lined.regionMarkerShown(["open and the reposit0ry is", "unch&ng2d."]))
        for line in ["3 files changed", "2 files changed, 14 insertions", "exchanged", "What do you want to build?",
                     "Message the agent, tag @files, or use /commands", "No repository selected"] {
            report.check("not the marker: \(line)", !lined.regionMarkerShown([line]))
        }
        let seedTexts = ["unchanged", "repository is unchanged"]
        report.check("watch --nearly reads the real window's unch&nged",
                     TextMatcher.firstNearly([realLine], needles: seedTexts) == "unchanged")
        report.check("watch --nearly reads the line when the word has two wrong letters",
                     TextMatcher.firstNearly(["th2 repository is unch&ng2d."], needles: seedTexts) == "repository is unchanged")
        report.check("watch --nearly does not read the marker in a new thread",
                     TextMatcher.firstNearly(["What do you want to build?", "3 files changed"], needles: seedTexts) == nil)
        report.check("nearlyContains: exact", TextMatcher.nearlyContains(Array("xxunchangedxx"), Array("unchanged"), maxEdits: 0))
        report.check("nearlyContains: empty text", !TextMatcher.nearlyContains([], Array("unchanged"), maxEdits: 1))
        report.check("nearlyContains: changed alone is two edits away",
                     !TextMatcher.nearlyContains(Array("fileschanged"), Array("unchanged"), maxEdits: 1))
        report.check("9 Nov OCR: Bare CLI's transcript line holds the seed marker",
                     marked.regionMarkerShown(["Seeded. This thpead is open and the pepositopy is unchanged."]))
        var fresh = EchoReadiness(probe: probe, absent: "unchanged", absentHasRegion: true)
        report.check("the capture does not read the absent region of the first frame", !fresh.echoes(["ademark"]))
        fresh.absorb([])
        report.check("typing posts the real key for a letter", KeyPoster.physicalKey(for: "d").0 == 0x02)
        report.check("typing adds Shift for a capital", KeyPoster.physicalKey(for: "H") == (0x04, .maskShift))
        report.check("typing keeps key code 0 for other text", KeyPoster.physicalKey(for: "é").0 == 0)
        report.check("text matcher finds a word", TextMatcher.contains(["the LEDGERMARK token"], needle: "ledgermark"))
        report.check("text matcher rejects a miss", !TextMatcher.contains(["other"], needle: "ledgermark"))
        report.check("text matcher reads a misread long marker",
                     TextMatcher.contains(["LEDGEPNARK. Hi! How can I help"], needle: "LEDGERMARK", maxSubstitutions: 2))
        report.check("text matcher reads unch3nged", TextMatcher.contains(["repository Is unch3nged."], needle: "unchanged", maxSubstitutions: 1))
        report.check("text matcher is exact by default", !TextMatcher.contains(["LEDGEPNARK"], needle: "LEDGERMARK"))
        report.check("text matcher never takes threaded for THREAD-END", !TextMatcher.contains(["Threaded view"], needle: "THREAD-END", maxSubstitutions: 1))
        report.check("text matcher never takes changed for unchanged", !TextMatcher.contains(["3 files changed"], needle: "unchanged", maxSubstitutions: 1))
        report.check("text matcher rejects knowledge for a long marker", !TextMatcher.contains(["Acknowledge the knowledge base"], needle: "LEDGERMARK", maxSubstitutions: 2))
        report.check("text matcher rejects three misreads", !TextMatcher.contains(["LXDGXPNARK"], needle: "LEDGERMARK", maxSubstitutions: 2))
        let ends = ["THREAD-END", "NGTHREAEND", "NGTHREAFEND"]
        report.check("9 Nov OCR: Orca's L(NGTHREA&END matches its end text",
                     TextMatcher.firstNeedle(["L(NGTHREA&END. That ts every IMe of src/Mvoice5.t5."], needles: ends) == "NGTHREAEND")
        report.check("8 Nov OCR: Orca's L(NGTHREAFEND matches its end text",
                     TextMatcher.firstNeedle(["L(NGTHREAFEND. That is every line of 5rc/invoices.ts"], needles: ends) == "NGTHREAFEND")
        report.check("Loading thread is never the end marker",
                     TextMatcher.firstNeedle(["Loading thread...", "Opening thread"], needles: ends) == nil)
        report.check("Switching threads is never the end marker",
                     TextMatcher.firstNeedle(["Switching threads"], needles: ends) == nil)
        report.check("the Ghostty pilot's LONfjTHREAD-END matches the first end text",
                     TextMatcher.firstNeedle(["LONfjTHREAD-END. That is every line"], needles: ends) == "THREAD-END")
        report.check("a list prefers its first text when a frame shows both",
                     TextMatcher.firstNeedle(["LONGTHREAD-END."], needles: ends) == "THREAD-END")
        report.check("a list matches nothing in a frame without its texts",
                     TextMatcher.firstNeedle(["Step 1000 of 1000", "Threaded view"], needles: ends) == nil)
        report.check("watch takes one --text as before", (try? WatchTexts.parse(text: "LEDGERMARK", texts: nil)) == ["LEDGERMARK"])
        report.check("watch takes a --texts list in order",
                     (try? WatchTexts.parse(text: nil, texts: "[\"THREAD-END\",\"NGTHREAEND\",\"NGTHREAFEND\"]")) == ends)
        report.check("watch refuses --text with --texts", (try? WatchTexts.parse(text: "a", texts: "[\"b\"]")) == nil)
        report.check("watch refuses an empty --texts list", (try? WatchTexts.parse(text: nil, texts: "[]")) == nil)
        report.check("watch refuses an empty text in --texts", (try? WatchTexts.parse(text: nil, texts: "[\"a\",\"\"]")) == nil)
        report.check("watch needs --text or --texts", (try? WatchTexts.parse(text: nil, texts: nil)) == nil)
    }

    private static func testAttribution(_ report: inout SelfTestReport) {
        let home = "/Users/tester"
        let rules = SampleRules(
            rootPids: [100],
            bundlePaths: ["/Applications/Test.app"],
            vendorDirs: ["~/.test/vendor"],
            agentExecutables: ["claude", "/opt/agent/bin"],
            excludeNames: ["customhelper"]
        )
        let processes: [ProcessInfoEntry] = [
            ProcessInfoEntry(pid: 100, ppid: 1, path: "/Applications/Test.app/Contents/MacOS/Test", name: "Test", responsiblePid: nil),
            ProcessInfoEntry(pid: 101, ppid: 100, path: "/Applications/Test.app/Contents/Frameworks/Helper", name: "Helper", responsiblePid: nil),
            ProcessInfoEntry(pid: 102, ppid: 1, path: "/Users/tester/.test/vendor/bin/vendord", name: "vendord", responsiblePid: nil),
            ProcessInfoEntry(pid: 103, ppid: 1, path: "/usr/local/bin/loose", name: "loose", responsiblePid: 100),
            ProcessInfoEntry(pid: 104, ppid: 103, path: "/usr/local/bin/child", name: "child", responsiblePid: nil),
            ProcessInfoEntry(pid: 105, ppid: 1, path: "/usr/bin/customhelper", name: "customhelper", responsiblePid: 100),
            ProcessInfoEntry(pid: 106, ppid: 1, path: "/usr/libexec/WindowServer", name: "WindowServer", responsiblePid: nil),
            ProcessInfoEntry(pid: 107, ppid: 100, path: "/opt/homebrew/bin/claude", name: "claude", responsiblePid: nil),
            ProcessInfoEntry(pid: 108, ppid: 107, path: "/usr/bin/git", name: "git", responsiblePid: nil),
            ProcessInfoEntry(pid: 109, ppid: 1, path: "/opt/agent/bin/runner", name: "runner", responsiblePid: 100),
            ProcessInfoEntry(pid: 110, ppid: 1, path: "/usr/bin/unrelated", name: "unrelated", responsiblePid: nil),
        ]
        let result = Attribution.attribute(rules, processes: processes, home: home)
        report.check("root pid is attributed", result.groupByPid[100] == .app)
        report.check("bundle path is attributed", result.groupByPid[101] == .app)
        report.check("vendor dir with tilde is attributed", result.groupByPid[102] == .app)
        report.check("responsible pid is attributed", result.groupByPid[103] == .app)
        report.check("parent chain is attributed", result.groupByPid[104] == .app)
        report.check("exclude name is not attributed", result.groupByPid[105] == nil)
        report.check("fixed system list is not attributed", result.groupByPid[106] == nil)
        report.check("agents group by basename", result.groupByPid[107] == .agents)
        report.check("agents group by parent", result.groupByPid[108] == .agents)
        report.check("agents group by executable directory", result.groupByPid[109] == .agents)
        report.check("unattributed process stays out", result.groupByPid[110] == nil)
        report.check("excluded pid is reported", result.excludedPids.contains(105))
        let terminal = SampleRules(rootPids: [200], bundlePaths: ["/Applications/Term.app"], vendorDirs: [], agentExecutables: ["claude"], excludeNames: [], harnessPids: [203])
        let tabs: [ProcessInfoEntry] = [
            ProcessInfoEntry(pid: 200, ppid: 1, path: "/Applications/Term.app/Contents/MacOS/term", name: "term", responsiblePid: nil),
            ProcessInfoEntry(pid: 201, ppid: 200, path: "/usr/bin/login", name: "login", responsiblePid: nil),
            ProcessInfoEntry(pid: 202, ppid: 201, path: "/bin/zsh", name: "zsh", responsiblePid: nil),
            ProcessInfoEntry(pid: 203, ppid: 202, path: "/opt/homebrew/bin/bun", name: "bun", responsiblePid: nil),
            ProcessInfoEntry(pid: 204, ppid: 203, path: "/opt/homebrew/bin/bun", name: "bun", responsiblePid: nil),
            ProcessInfoEntry(pid: 205, ppid: 204, path: "/x/ademark-native", name: "ademark-native", responsiblePid: nil),
            ProcessInfoEntry(pid: 206, ppid: 200, path: "/usr/bin/login", name: "login", responsiblePid: nil),
            ProcessInfoEntry(pid: 207, ppid: 206, path: "/bin/zsh", name: "zsh", responsiblePid: nil),
            ProcessInfoEntry(pid: 208, ppid: 207, path: "/opt/bin/claude", name: "claude", responsiblePid: nil),
        ]
        let tabResult = Attribution.attribute(terminal, processes: tabs, home: home)
        report.check("measured terminal stays the app", tabResult.groupByPid[200] == .app)
        report.check("harness is not the app", tabResult.groupByPid[203] == nil && tabResult.groupByPid[204] == nil)
        report.check("harness helper is not the app", tabResult.groupByPid[205] == nil)
        report.check("harness shell chain is not the app", tabResult.groupByPid[201] == nil && tabResult.groupByPid[202] == nil)
        report.check("measured tab stays the app", tabResult.groupByPid[206] == .app && tabResult.groupByPid[207] == .app)
        report.check("agent in a measured tab stays an agent", tabResult.groupByPid[208] == .agents)
        report.check("prefix matches on a path boundary") {
            Attribution.matchesPrefix("/Applications/Test.app", "/Applications/Test.app") &&
            Attribution.matchesPrefix("/Applications/Test.app/Contents/MacOS/Test", "/Applications/Test.app")
        }
        report.check("prefix rejects a longer sibling name") {
            !Attribution.matchesPrefix("/Applications/T3 Code (Beta).app.old/Contents/MacOS/x",
                                       "/Applications/T3 Code (Beta).app")
        }
        report.check("prefix rejects a partial name") {
            !Attribution.matchesPrefix("/Applications/Test.apprentice/x", "/Applications/Test.app")
        }
        report.check("tilde prefix expands") {
            Attribution.normalizePrefix("~/Library/", home: home) == "/Users/tester/Library"
        }
    }

    private static func testClockConversion(_ report: inout SelfTestReport) {
        report.check("clock moves forward") {
            let first = Clock.nowNs()
            Clock.sleepNs(2_000_000)
            return Clock.nowNs() > first
        }
        report.check("tick conversion keeps 125/3 ns") {
            let ticks: UInt64 = 3_000_000
            return Clock.ticksToNs(ticks) == 125_000_000
        }
        report.check("tick conversion of zero") { Clock.ticksToNs(0) == 0 }
        report.check("seconds to ns") { Clock.secondsToNs(1.5) == 1_500_000_000 }
        report.check("ns to ms") { Clock.nsToMs(2_500_000) == 2.5 }
    }

    private static func testCanPost(_ report: inout SelfTestReport) {
        report.check("canPost true for the frontmost pid") { canPost(frontmostPid: 42, target: 42) }
        report.check("canPost false for another pid") { !canPost(frontmostPid: 42, target: 43) }
        report.check("canPost false without a frontmost app") { !canPost(frontmostPid: nil, target: 42) }
        report.check("canPost false for a stale frontmost pid") { !canPost(frontmostPid: 0, target: 42) }
    }

    private static func testFrameTime(_ report: inout SelfTestReport) {
        report.check("frame time prefers the presentation time") {
            let picked = FrameTimeSelector.select(ptsNs: 5_000, displayTicks: 3_000, arrivalNs: 9_000)
            return picked.tNs == 5_000 && picked.source == .pts
        }
        report.check("frame time falls back to display ticks") {
            let picked = FrameTimeSelector.select(ptsNs: nil, displayTicks: 3_000, arrivalNs: 9_000)
            return picked.tNs == Clock.ticksToNs(3_000) && picked.source == .display
        }
        report.check("frame time falls back to arrival last") {
            let picked = FrameTimeSelector.select(ptsNs: nil, displayTicks: nil, arrivalNs: 9_000)
            return picked.tNs == 9_000 && picked.source == .arrival
        }
        report.check("frame time ignores a zero presentation time") {
            let picked = FrameTimeSelector.select(ptsNs: 0, displayTicks: 0, arrivalNs: 9_000)
            return picked.source == .arrival
        }
        report.check("cmTimeToNs rejects an invalid time") {
            Clock.cmTimeToNs(CMTime.invalid) == nil && Clock.cmTimeToNs(.zero) == nil
        }
        report.check("cmTimeToNs converts a valid time") {
            Clock.cmTimeToNs(CMTime(value: 1, timescale: 1_000)) == 1_000_000
        }
    }

    private static func testLagRule(_ report: inout SelfTestReport) {
        report.check("lag miss window is 2 s") { LagRule.missNs == 2_000_000_000 }
        report.check("lag counts an echo inside the window") {
            !LagRule.isLost(echoNs: 500, deadlineNs: 2_000)
        }
        report.check("lag counts no echo as lost") {
            LagRule.isLost(echoNs: nil, deadlineNs: 2_000)
        }
        report.check("lag counts a late echo as lost") {
            LagRule.isLost(echoNs: 2_500, deadlineNs: 2_000)
        }
        report.check("lag deadline is post plus 2 s") {
            LagRule.deadline(postNs: 1_000) == 1_000 + LagRule.missNs
        }
        report.check("lag probe array keeps an echo in its slot") {
            let probes = LagRule.probeLatencies(postNs: [1_000, 5_000, 9_000],
                                                echoNs: [1_751_000, nil, 9_000 + LagRule.missNs + 1])
            guard probes.count == 3, let first = probes[0] else { return false }
            return abs(first - 1.75) < 0.000_1 && probes[1] == nil && probes[2] == nil
        }
        report.check("lag probe array still counts an echo at the deadline") {
            let probes = LagRule.probeLatencies(postNs: [1_000], echoNs: [1_000 + LagRule.missNs])
            guard let only = probes.first ?? nil else { return false }
            return probes.count == 1 && abs(only - 2_000) < 0.000_1
        }
        report.check("lag counts grown text as an echo") {
            LagRule.echoed(frameText: "promptad", baselineText: "prompta", typed: "ad")
        }
        report.check("lag counts a cursor letter replaced by the typed one as an echo") {
            LagRule.echoed(frameText: "promptade", baselineText: "promptadl", typed: "ade")
        }
        report.check("lag counts unchanged text as no echo") {
            !LagRule.echoed(frameText: "promptadl", baselineText: "promptadl", typed: "ade")
        }
        report.check("pixel echo: a blinking caret's two states are both recent, so neither is an echo") {
            let off: [UInt32] = [1, 1, 1, 1, 1, 1, 1, 1]
            let on: [UInt32] = [1, 1, 1, 9, 1, 1, 1, 1]
            return !LagRule.pixelEchoed(frame: on, recent: [off, on], minColumns: 3)
                && !LagRule.pixelEchoed(frame: off, recent: [off, on], minColumns: 3)
        }
        report.check("pixel echo: a new glyph differs from every recent frame by enough columns") {
            let off: [UInt32] = [1, 1, 1, 1, 1, 1, 1, 1]
            let on: [UInt32] = [1, 1, 1, 9, 1, 1, 1, 1]
            let glyph: [UInt32] = [1, 1, 1, 5, 6, 7, 9, 1]
            return LagRule.pixelEchoed(frame: glyph, recent: [off, on], minColumns: 3)
        }
        report.check("pixel echo: a caret alone is too narrow, and no recent frame means no pixel echo") {
            let off: [UInt32] = [1, 1, 1, 1]
            let on: [UInt32] = [1, 9, 1, 1]
            return !LagRule.pixelEchoed(frame: on, recent: [off], minColumns: 3)
                && !LagRule.pixelEchoed(frame: on, recent: [], minColumns: 3)
        }
        report.check("jittered cadence stays within ±20 %") {
            (0..<200).map { _ in Clock.jittered(250_000_000) }.allSatisfy { $0 >= 200_000_000 && $0 <= 300_000_000 }
        }
        report.check("pixel echo: 3 points of columns, at least 2") {
            LagRule.minColumns(scale: 2) == 6 && LagRule.minColumns(scale: 1) == 3 && LagRule.minColumns(scale: 0.5) == 2
        }
        report.check("lag counts a repeated probe pair only once more than before") {
            LagRule.echoed(frameText: "ademarkqzadl", baselineText: "ademarkqzal", typed: "ademarkqzad")
                && !LagRule.echoed(frameText: "ademarkqzal", baselineText: "ademarkqzal", typed: "ademarkqzad")
        }
    }

    private static func testStats(_ report: inout SelfTestReport) {
        report.check("median of odd count") { Stats.median([3, 1, 2]) == 2 }
        report.check("median of even count") { Stats.median([1, 2, 3, 4]) == 2 }
        report.check("median of empty") { Stats.median([]) == 0 }
        report.check("p95 of 1...100") { Stats.percentile(Array(1...100).map(Int64.init), 0.95) == 95 }
        report.check("p95 of a single value") { Stats.percentile([7], 0.95) == 7 }
        report.check("p50 of 1...9") { Stats.percentile(Array(1...9).map(Int64.init), 0.5) == 5 }
        report.check("percentile clamps") { Stats.percentile([1, 2], 1.5) == 2 }
    }

    private static func testSettled(_ report: inout SelfTestReport) {
        func sample(_ ms: UInt64, _ dirty: Int) -> DirtySample {
            DirtySample(tNs: ms * 1_000_000, dirtyOutsideMasks: dirty)
        }
        let cap: UInt64 = 30_000_000_000
        let quiet: UInt64 = 1_000_000_000
        report.check("settled needs a quiet second") {
            let samples = [sample(0, 1), sample(500, 0), sample(900, 0), sample(1_600, 0)]
            return SettledFinder.firstSettled(samples: samples, t0: 0, capNs: cap, quietNs: quiet) == 500_000_000
        }
        report.check("settled skips a later dirty frame") {
            let samples = [sample(0, 0), sample(700, 2), sample(1_800, 0), sample(3_000, 0)]
            return SettledFinder.firstSettled(samples: samples, t0: 0, capNs: cap, quietNs: quiet) == 1_800_000_000
        }
        report.check("settled is nil without a quiet second") {
            let samples = [sample(0, 1), sample(400, 1)]
            return SettledFinder.firstSettled(samples: samples, t0: 0, capNs: cap, quietNs: quiet) == nil
        }
        report.check("settled respects the cap") {
            let samples = [sample(0, 0), sample(40_000, 0)]
            return SettledFinder.firstSettled(samples: samples, t0: 0, capNs: cap, quietNs: quiet) == nil
        }
        report.check("settled ignores samples before t0") {
            let samples = [sample(0, 0), sample(1_000, 0), sample(2_100, 0)]
            return SettledFinder.firstSettled(samples: samples, t0: 1_500_000_000, capNs: cap,
                                              quietNs: quiet) == nil
        }
    }

    private static func testTriggerOutcome(_ report: inout SelfTestReport) {
        report.check("no skipped trigger passes") {
            TriggerOutcome.error(skipped: 0, pid: 42) == nil
        }
        report.check("one skipped trigger fails with trigger_skipped") {
            guard let error = TriggerOutcome.error(skipped: 1, pid: Int32(42)) else { return false }
            return error.code == "trigger_skipped" && error.exitCode == 4 && error.message.contains("42")
        }
        report.check("a skipped trigger with no pid names the app instead") {
            guard let error = TriggerOutcome.error(skipped: 1, pid: nil) else { return false }
            return error.code == "trigger_skipped" && error.message.contains("the app was not frontmost")
        }
        report.check("several skipped triggers pluralize and keep the count") {
            guard let error = TriggerOutcome.error(skipped: 3, pid: Int32(7)) else { return false }
            return error.code == "trigger_skipped" && error.message.contains("3 triggers")
        }
    }

    private static func testFramesFile(_ report: inout SelfTestReport) {
        report.check("frames file carries cleared, time_sources and per-frame source") {
            let records = [
                FrameRecord(tNs: 10, source: .pts, lines: ["a"], dirtyOutsideMasks: 0),
                FrameRecord(tNs: 20, source: .arrival, lines: ["b"], dirtyOutsideMasks: 2),
            ]
            let path = NSTemporaryDirectory() + "ademark-selftest-frames-\(getpid()).json"
            defer { try? FileManager.default.removeItem(atPath: path) }
            try FramesFile.write(path: path, records: records, cleared: false)
            let data = try requireFile(path)
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sources = root["time_sources"] as? [String: Any],
                  let frames = root["frames"] as? [[String: Any]] else { return false }
            return (root["cleared"] as? Bool) == false
                && (sources["pts"] as? Int) == 1
                && (sources["arrival"] as? Int) == 1
                && (sources["display"] as? Int) == 0
                && frames.count == 2
                && (frames[0]["source"] as? String) == "pts"
                && (frames[1]["source"] as? String) == "arrival"
                && (frames[1]["dirty_outside_masks"] as? Int) == 2
        }
        report.check("frames file writes a null cleared for watch and lag") {
            let path = NSTemporaryDirectory() + "ademark-selftest-frames-null-\(getpid()).json"
            defer { try? FileManager.default.removeItem(atPath: path) }
            try FramesFile.write(path: path, records: [], cleared: nil)
            let data = try requireFile(path)
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            return root["cleared"] is NSNull && (root["frames"] as? [Any])?.isEmpty == true
        }
    }

    private static func testFrameGaps(_ report: inout SelfTestReport) {
        let empty = FrameGaps.windowed(frameTimes: [], t0Ns: 0, tEndNs: 0)
        report.check("gaps of no frames are zero") { empty.gapsOver33ms == 0 && empty.maxGapMs == 0 }
        let smooth = FrameGaps.windowed(frameTimes: [0, 16_000_000, 32_000_000], t0Ns: 0, tEndNs: 32_000_000)
        report.check("gaps ignore frames under 33 ms apart") {
            smooth.gapsOver33ms == 0 && smooth.maxGapMs == 16
        }
        let oneGap = FrameGaps.windowed(frameTimes: [0, 16_000_000, 60_000_000], t0Ns: 0, tEndNs: 60_000_000)
        report.check("gaps count one long pair") {
            oneGap.gapsOver33ms == 1 && oneGap.maxGapMs == 44
        }
        let boundary = FrameGaps.windowed(frameTimes: [0, 33_000_000], t0Ns: 0, tEndNs: 33_000_000)
        report.check("a 33.0 ms pair is not a gap") {
            boundary.gapsOver33ms == 0 && boundary.maxGapMs == 33
        }
        let afterT0 = FrameGaps.windowed(frameTimes: [0, 500_000_000, 520_000_000], t0Ns: 100_000_000,
                                         tEndNs: 520_000_000)
        report.check("gaps include the silence from t0 to the first frame") {
            afterT0.gapsOver33ms == 1 && afterT0.maxGapMs == 400
        }
        let single = FrameGaps.windowed(frameTimes: [7_000_000], t0Ns: 0, tEndNs: 7_000_000)
        report.check("a single frame has no gaps") { single.gapsOver33ms == 0 && single.maxGapMs == 7 }
    }

    private static func testScreenGeometry(_ report: inout SelfTestReport) {
        report.check("cg frame on the main display flips to appkit") {
            ScreenGeometry.appKitFrame(cgFrame: CGRect(x: 100, y: 200, width: 800, height: 600),
                                       primaryHeight: 1080) == CGRect(x: 100, y: 280, width: 800, height: 600)
        }
        report.check("cg frame on a display above the main flips above it") {
            ScreenGeometry.appKitFrame(cgFrame: CGRect(x: 0, y: -900, width: 1920, height: 900),
                                       primaryHeight: 1080) == CGRect(x: 0, y: 1080, width: 1920, height: 900)
        }
        report.check("cg frame on a display left of the main keeps x") {
            ScreenGeometry.appKitFrame(cgFrame: CGRect(x: -1280, y: 100, width: 1280, height: 720),
                                       primaryHeight: 1080) == CGRect(x: -1280, y: 260, width: 1280, height: 720)
        }
        report.check("cg frame at the top of the main display maps to its top") {
            ScreenGeometry.appKitFrame(cgFrame: CGRect(x: 0, y: 0, width: 1080, height: 1080),
                                       primaryHeight: 1080) == CGRect(x: 0, y: 0, width: 1080, height: 1080)
        }
    }

    private static func testSampleDuration(_ report: inout SelfTestReport) {
        report.check("duration 0 runs until a signal") { SampleDuration.runsUntilSignal(0) }
        report.check("a positive duration runs on a timer") {
            !SampleDuration.runsUntilSignal(0.5) && !SampleDuration.runsUntilSignal(600)
        }
        report.check("duration 0 is accepted") { try SampleDuration.validate(0) == 0 }
        report.check("a negative duration is rejected") {
            do { _ = try SampleDuration.validate(-1); return false } catch { return true }
        }
        report.check("a duration over one day is rejected") {
            do { _ = try SampleDuration.validate(86_401); return false } catch { return true }
        }
    }

    private static func testOcrRoundTrip(_ report: inout SelfTestReport) {
        report.check("ocr reads rendered text") {
            guard let image = renderText("ADEMARK LEDGERMARK 4821") else { return false }
            let lines = Ocr.lines(in: image)
            return lines.contains { $0.contains("LEDGERMARK") }
        }
        report.check("ocr region restricts reading") {
            guard let image = renderText("ADEMARK LEDGERMARK 4821") else { return false }
            let lines = Ocr.lines(in: image, region: CGRect(x: 0, y: 0, width: 1, height: 0.25))
            return !lines.contains { $0.contains("LEDGERMARK") }
        }
    }

    static func renderText(_ text: String, width: Int = 1000, height: Int = 240) -> CGImage? {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return nil
        }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 76, nil)
        let attributes: [CFString: Any] = [kCTFontAttributeName: font]
        guard let attributed = CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary) else {
            return nil
        }
        let line = CTLineCreateWithAttributedString(attributed)
        context.textPosition = CGPoint(x: 40, y: 90)
        CTLineDraw(line, context)
        return context.makeImage()
    }
}
