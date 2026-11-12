import Foundation
import CoreGraphics

struct FrameRecord {
    let tNs: UInt64
    let source: FrameTimeSource
    let lines: [String]
    let dirtyOutsideMasks: Int
    /// Window points, at most `DirtyRects.framesFileLimit` per frame, the first ones as captured.
    let dirtyRects: [RectSpec]
    let normalizedText: String
    let columns: [UInt32]?
    /// echo --absent-region: that region of this frame, read only when the frame's composer would be Ready.
    let absentLines: [String]?

    init(tNs: UInt64, source: FrameTimeSource = .pts, lines: [String], dirtyOutsideMasks: Int,
         dirtyRects: [RectSpec] = [], columns: [UInt32]? = nil, absentLines: [String]? = nil) {
        self.absentLines = absentLines
        self.tNs = tNs
        self.source = source
        self.lines = lines
        self.dirtyOutsideMasks = dirtyOutsideMasks
        self.dirtyRects = dirtyRects
        self.columns = columns
        normalizedText = ProbeMatcher.normalize(lines.joined(separator: " "))
    }

    var normalizedLength: Int { normalizedText.count }
    var dirtySample: DirtySample { DirtySample(tNs: tNs, dirtyOutsideMasks: dirtyOutsideMasks) }
}

final class FrameStore {
    private let lock = NSLock()
    private var records: [FrameRecord] = []
    private var dirty: [DirtySample] = []

    func append(_ record: FrameRecord) {
        lock.lock()
        records.append(record)
        dirty.append(record.dirtySample)
        lock.unlock()
    }

    func snapshot() -> [FrameRecord] {
        lock.lock()
        defer { lock.unlock() }
        return records
    }

    func dirtySamples() -> [DirtySample] {
        lock.lock()
        defer { lock.unlock() }
        return dirty
    }

    /// Scans frames from `index` onward and returns the first match plus the index to resume from.
    func firstMatching(from index: Int, _ predicate: (FrameRecord) -> Bool) -> (frame: FrameRecord?, nextIndex: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard index < records.count else { return (nil, records.count) }
        for position in index..<records.count where predicate(records[position]) {
            return (records[position], position + 1)
        }
        return (nil, records.count)
    }

    func firstSettled(t0: UInt64, capNs: UInt64, quietNs: UInt64) -> UInt64? {
        SettledFinder.firstSettled(samples: dirtySamples(), t0: t0, capNs: capNs, quietNs: quietNs)
    }
}

enum FramesFile {
    /// `cleared` is nil for runs that never clear the field (watch, lag). `time_sources` counts how
    /// each frame got its timestamp, so a silent fall back to arrival time cannot go unnoticed.
    static func write(path: String, records: [FrameRecord], cleared: Bool?) throws {
        var counts: [FrameTimeSource: Int] = [:]
        for record in records { counts[record.source, default: 0] += 1 }
        let frames = records.map { record in
            var fields: [(String, JSONValue)] = [
                ("t_ns", .uint(record.tNs)),
                ("source", .string(record.source.rawValue)),
                ("ocr", .array(record.lines.map { .string($0) })),
                ("dirty_outside_masks", .int(Int64(record.dirtyOutsideMasks))),
                ("dirty_rects", .array(record.dirtyRects.map(rectJSON))),
            ]
            if let absent = record.absentLines { fields.append(("absent_ocr", .array(absent.map { .string($0) }))) }
            return JSONValue.object(fields)
        }
        let document = JSONValue.object([
            ("cleared", cleared.map { JSONValue.bool($0) } ?? .null),
            ("time_sources", .object([
                ("pts", .int(Int64(counts[.pts] ?? 0))),
                ("display", .int(Int64(counts[.display] ?? 0))),
                ("arrival", .int(Int64(counts[.arrival] ?? 0))),
            ])),
            ("frames", .array(frames)),
        ])
        try writeText(path, document.serialized() + "\n")
    }

    private static func rectJSON(_ rect: RectSpec) -> JSONValue {
        .object([
            ("x", .double(rect.x)),
            ("y", .double(rect.y)),
            ("w", .double(rect.w)),
            ("h", .double(rect.h)),
        ])
    }
}
