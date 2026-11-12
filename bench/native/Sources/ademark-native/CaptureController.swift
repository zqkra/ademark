import Foundation
import CoreGraphics

final class CaptureController {
    let pid: Int32
    let region: RectSpec
    let masks: [RectSpec]
    let videoPath: String?
    /// Echo's settle rule treats the probe region as a mask (TESTS.md §1.3), so a caret blinking there is not busy.
    let regionIsSettleMask: Bool
    /// Column signatures of the region on every frame (A8 echo by pixels).
    let signatures: Bool
    let secondary: SecondaryRead?
    let store: FrameStore
    private(set) var session: CaptureSession?
    private(set) var target: CaptureTarget?

    init(pid: Int32, region: RectSpec, masks: [RectSpec], videoPath: String?, baselineNs: UInt64,
         signatures: Bool = false, regionIsSettleMask: Bool = false, secondary: SecondaryRead? = nil) {
        self.pid = pid
        self.secondary = secondary
        self.signatures = signatures
        self.region = region
        self.masks = masks
        self.videoPath = videoPath
        self.regionIsSettleMask = regionIsSettleMask
        store = FrameStore()
    }

    var isRunning: Bool { session != nil }

    /// Waits until the pid owns a layer-0 window, then starts the stream.
    @discardableResult
    func waitAndStart(deadline: UInt64) throws -> Bool {
        if session != nil { return true }
        guard WindowFinder.wait(pid: pid, until: deadline) != nil else { return false }
        try start()
        return true
    }

    func start(_ known: CaptureTarget? = nil) throws {
        let resolved = try known ?? CaptureTargetResolver.resolve(pid: pid)
        target = resolved
        let space = WindowSpace(scale: resolved.scale,
                                pixelWidth: resolved.pixelSize.width,
                                pixelHeight: resolved.pixelSize.height)
        let pixelMasks = masks.map { space.pixelRect(for: $0) }
        let settleMasks = regionIsSettleMask
            ? DirtyRects.masksWithRegion(pixelMasks, region: space.pixelRect(for: region))
            : pixelMasks
        let session = try CaptureSession(
            target: resolved,
            region: space.visionRect(for: region),
            masks: settleMasks,
            videoPath: videoPath,
            signatureRect: signatures ? space.pixelRect(for: region) : nil,
            secondaryRegion: secondary.map { space.visionRect(for: $0.region) },
            shouldReadSecondary: secondary?.shouldRead
        ) { [store] frame in
            let dirtyRects = DirtyRects.windowRects(frame.dirtyRects, scale: space.scale)
            store.append(FrameRecord(tNs: frame.tNs, source: frame.source, lines: frame.lines,
                                     dirtyOutsideMasks: frame.dirtyRects.count, dirtyRects: dirtyRects,
                                     columns: frame.columns, absentLines: frame.secondaryLines))
        }
        try session.start()
        self.session = session
    }

    /// Moves the stream when the app's main window now sits elsewhere (a tab in the same place needs no move, the
    /// capture shows all of the app's windows there); frames keep going to the same store. Returns the time it moved:
    /// every frame from then on is from the new place.
    func followWindow() throws -> UInt64? {
        guard let current = target?.windowFrame else { return nil }
        let resolved = try CaptureTargetResolver.resolve(pid: pid)
        guard resolved.windowFrame != current else { return nil }
        session?.stop()
        _ = session?.waitForStop()
        session = nil
        let moved = Clock.nowNs()
        try start(resolved)
        return moved
    }

    func stop() {
        session?.stop()
    }

    func waitForStop(timeoutNs: UInt64 = 5_000_000_000) -> Bool {
        session?.waitForStop(timeoutNs: timeoutNs) ?? true
    }

    func windowFrame() -> CGRect? {
        if let target { return target.windowFrame }
        return WindowFinder.frontmost(pid: pid)?.frame
    }
}
