import Foundation
import CoreGraphics

/// Pure checks for ADEMARK-15: the probe region as a settle mask, the settle cap, `dirty_rects`,
/// the A11 scroll window and the `idle` math. No capture, no events, no permission checks.
enum SelfTestTiming {
    static func tests(_ report: inout SelfTestReport) {
        testSettleRegion(report: &report)
        testSettleCap(report: &report)
        testDirtyRects(report: &report)
        testScrollWindow(report: &report)
        testIdleMath(report: &report)
    }

    private static func testSettleRegion(report: inout SelfTestReport) {
        let region = CGRect(x: 80, y: 1_400, width: 2_400, height: 160)
        let caret = CGRect(x: 100, y: 1_420, width: 2, height: 40)
        let elsewhere = CGRect(x: 100, y: 100, width: 2, height: 40)
        let settleMasks = DirtyRects.masksWithRegion([], region: region)
        report.check("a caret inside the probe region is not dirty") {
            DirtyRects.outsideMasks([caret], masks: settleMasks).isEmpty
        }
        report.check("the same caret outside the region and every mask is dirty") {
            DirtyRects.outsideMasks([elsewhere], masks: settleMasks) == [elsewhere]
        }

        func samples(masks: [CGRect], caret: CGRect) -> [DirtySample] {
            (0...20).map { index in
                let tNs = UInt64(index) * 100_000_000
                let up = (tNs / 500_000_000) % 2 == 0
                let rects = up ? [caret] : []
                return DirtySample(tNs: tNs, dirtyOutsideMasks: DirtyRects.outsideMasks(rects, masks: masks).count)
            }
        }
        let quiet: UInt64 = 1_000_000_000
        report.check("a caret blinking inside the region still settles") {
            SettledFinder.firstSettled(samples: samples(masks: settleMasks, caret: caret), t0: 0,
                                       capNs: 30_000_000_000, quietNs: quiet) == 0
        }
        report.check("a blinking caret outside every mask never settles") {
            SettledFinder.firstSettled(samples: samples(masks: settleMasks, caret: elsewhere), t0: 0,
                                       capNs: 30_000_000_000, quietNs: quiet) == nil
        }
    }

    private static func testSettleCap(report: inout SelfTestReport) {
        func sample(_ ms: UInt64, _ dirty: Int) -> DirtySample {
            DirtySample(tNs: ms * 1_000_000, dirtyOutsideMasks: dirty)
        }
        let busyFor6s = (0...48).map { step in
            let ms = UInt64(step) * 250
            return sample(ms, ms < 6_000 ? 1 : 0)
        }
        report.check("a window busy for 6 s returns no settle at cap 5") {
            SettledFinder.firstSettled(samples: busyFor6s, t0: 0, capNs: 5_000_000_000,
                                       quietNs: 1_000_000_000) == nil
        }
        report.check("the same window settles at cap 10") {
            SettledFinder.firstSettled(samples: busyFor6s, t0: 0, capNs: 10_000_000_000,
                                       quietNs: 1_000_000_000) == 6_000_000_000
        }
        report.check("settle cap defaults to 5 s") {
            try EchoCommand.settleCapNs(nil) == 5_000_000_000
        }
        report.check("settle cap keeps a fractional value") {
            try EchoCommand.settleCapNs("1.5") == 1_500_000_000
        }
        report.check("settle cap rejects zero") {
            do { _ = try EchoCommand.settleCapNs("0"); return false } catch { return true }
        }
        report.check("settle cap rejects more than 30 s") {
            do { _ = try EchoCommand.settleCapNs("31"); return false } catch { return true }
        }
    }

    private static func testDirtyRects(report: inout SelfTestReport) {
        let pixels = (0..<10).map { CGRect(x: Double($0) * 20, y: 4, width: 20, height: 10) }
        let points = DirtyRects.windowRects(pixels, scale: 2)
        report.check("dirty_rects keeps the first 8 of 10") {
            points.count == DirtyRects.framesFileLimit && points[7].x == 70 && points[7].w == 10 && points[7].h == 5
        }
        report.check("dirty_rects converts pixels to points like the masks") {
            let space = WindowSpace(scale: 2, pixelWidth: 1_000, pixelHeight: 1_000)
            return points[3].x == 30 && points[3].y == 2 && space.pixelRect(for: points[3]) == pixels[3]
        }
        report.check("a frame with no dirty rect writes an empty array") {
            let path = NSTemporaryDirectory() + "ademark-selftest-dirty-none-\(getpid()).json"
            defer { try? FileManager.default.removeItem(atPath: path) }
            let record = FrameRecord(tNs: 10, lines: [], dirtyOutsideMasks: 0)
            try FramesFile.write(path: path, records: [record], cleared: nil)
            let data = try requireFile(path)
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let frames = root["frames"] as? [[String: Any]] else { return false }
            return (frames[0]["dirty_rects"] as? [Any])?.isEmpty == true
        }
        report.check("a frame with a dirty rect writes x, y, w, h in points") {
            let path = NSTemporaryDirectory() + "ademark-selftest-dirty-one-\(getpid()).json"
            defer { try? FileManager.default.removeItem(atPath: path) }
            let rect = RectSpec(x: 1.5, y: 2, w: 3, h: 4)
            let record = FrameRecord(tNs: 10, lines: [], dirtyOutsideMasks: 9, dirtyRects: [rect])
            try FramesFile.write(path: path, records: [record], cleared: nil)
            let data = try requireFile(path)
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let frames = root["frames"] as? [[String: Any]],
                  let rects = frames[0]["dirty_rects"] as? [[String: Any]] else { return false }
            return (frames[0]["dirty_outside_masks"] as? Int) == 9
                && rects.count == 1
                && (rects[0]["x"] as? Double) == 1.5
                && (rects[0]["y"] as? Double) == 2
                && (rects[0]["w"] as? Double) == 3
                && (rects[0]["h"] as? Double) == 4
        }
    }

    private static func testScrollWindow(report: inout SelfTestReport) {
        let scrollNs: UInt64 = 333_000_000
        let frameNs: UInt64 = 16_700_000
        let smooth = (0..<20).map { UInt64($0) * frameNs }
        let smoothSummary = FrameGaps.windowed(frameTimes: smooth, t0Ns: 0, tEndNs: scrollNs)
        report.check("frames every 16.7 ms during a 333 ms scroll give no gaps") {
            smoothSummary.gapsOver33ms == 0
        }
        report.check("a frame after t_end is not part of the scroll") {
            FrameGaps.windowed(frameTimes: smooth + [400_000_000, 700_000_000], t0Ns: 0,
                               tEndNs: scrollNs).gapsOver33ms == 0
        }
        let freeze = [UInt64(0), 16_700_000, 33_400_000, 50_100_000, 66_800_000, 83_500_000,
                      183_500_000, 200_200_000, 216_900_000, 233_600_000, 250_300_000,
                      267_000_000, 283_700_000, 300_400_000, 317_100_000]
        let freezeSummary = FrameGaps.windowed(frameTimes: freeze, t0Ns: 0, tEndNs: scrollNs)
        report.check("a 100 ms freeze inside the scroll is one gap") { freezeSummary.gapsOver33ms == 1 }
        report.check("the freeze is the largest gap") { freezeSummary.maxGapMs == 100 }
        let stalled = [UInt64(0), 16_700_000, 33_400_000, 50_100_000]
        let stalledSummary = FrameGaps.windowed(frameTimes: stalled, t0Ns: 0, tEndNs: scrollNs)
        report.check("no frame after t0 + 50 ms gives a gap ending at t_end") {
            stalledSummary.gapsOver33ms == 1
                && stalledSummary.maxGapMs == Clock.nsToMs(scrollNs - 50_100_000)
        }
        report.check("a pair exactly 33.0 ms apart is not a gap") {
            FrameGaps.windowed(frameTimes: [0, 33_000_000], t0Ns: 0, tEndNs: 33_000_000).gapsOver33ms == 0
        }
        report.check("a scroll window with only frames outside it is one whole-window gap") {
            let summary = FrameGaps.windowed(frameTimes: [0, 16_000_000], t0Ns: 50_000_000, tEndNs: scrollNs)
            return summary.gapsOver33ms == 1 && summary.maxGapMs == Clock.nsToMs(scrollNs - 50_000_000)
        }
        report.check("no frame inside the scroll window is one gap over the whole window") {
            let summary = FrameGaps.windowed(frameTimes: [], t0Ns: 50_000_000, tEndNs: 383_000_000)
            return summary.gapsOver33ms == 1 && summary.maxGapMs == 333
        }
        report.check("a first frame 50 ms after t0 is one gap") {
            let late = (0..<16).map { 50_000_000 + UInt64($0) * frameNs }
            let summary = FrameGaps.windowed(frameTimes: late, t0Ns: 0, tEndNs: scrollNs)
            return summary.gapsOver33ms == 1 && summary.maxGapMs == 50
        }
    }

    private static func testIdleMath(report: inout SelfTestReport) {
        let start = CpuTicks(user: 0, system: 0, idle: 0, nice: 0)
        report.check("cores busy is the busy tick share times the logical CPU count") {
            let end = CpuTicks(user: 600, system: 200, idle: 200, nice: 0)
            guard let cores = IdleRule.coresBusy(previous: start, current: end, logicalCpus: 4) else { return false }
            return abs(cores - 3.2) < 1e-9
        }
        report.check("nice ticks count as busy") {
            let end = CpuTicks(user: 0, system: 0, idle: 100, nice: 100)
            return IdleRule.coresBusy(previous: start, current: end, logicalCpus: 8) == 4
        }
        report.check("an interval without ticks has no busy value") {
            IdleRule.coresBusy(previous: start, current: start, logicalCpus: 8) == nil
        }
        report.check("zero logical CPUs has no busy value") {
            IdleRule.coresBusy(previous: start, current: start, logicalCpus: 0) == nil
        }

        func sample(_ index: Int, _ cores: Double) -> CoreSample {
            CoreSample(tNs: UInt64(index) * 100_000_000, cores: cores)
        }
        let series = [sample(1, 9), sample(2, 9), sample(3, 9), sample(4, 9),
                      sample(5, 1), sample(6, 1), sample(7, 1), sample(8, 1)]
        report.check("a quiet window is quiet when every interval in it is under the threshold") {
            IdleRule.isQuiet(samples: series, threshold: 2, quietNs: 300_000_000)
        }
        report.check("a busy interval inside the quiet window is not quiet") {
            !IdleRule.isQuiet(samples: Array(series.prefix(5)), threshold: 2, quietNs: 300_000_000)
        }
        report.check("a quiet window needs samples covering all of it") {
            !IdleRule.isQuiet(samples: [sample(1, 1), sample(2, 1)], threshold: 2, quietNs: 300_000_000)
        }
        report.check("no samples are not quiet") {
            !IdleRule.isQuiet(samples: [], threshold: 2, quietNs: 300_000_000)
        }
    }
}
