import Foundation
import CoreMedia
import CoreVideo
import ScreenCaptureKit

struct CapturedFrame {
    let tNs: UInt64
    let source: FrameTimeSource
    let lines: [String]
    /// Dirty rects outside the masks, still in the captured frame's pixels.
    let dirtyRects: [CGRect]
    let columns: [UInt32]?
    /// The second region of the same frame, read only when the caller's test asked for it (echo --absent-region).
    var secondaryLines: [String]? = nil
}

/// A second OCR region read from the same pixels as the main one, only on frames `shouldRead` picks from the main
/// region's lines. ADEMARK-40: A3 reads the transcript only on a frame whose composer would be Ready, so every other
/// frame costs what it cost before.
struct SecondaryRead {
    let region: RectSpec
    let shouldRead: ([String]) -> Bool
}

struct CaptureTarget {
    let window: SCWindow
    let filter: SCContentFilter
    let pixelSize: CGSize
    let scale: Double
    let windowFrame: CGRect
    /// The window's rect in its display's points: the stream records the app's windows on that display, cropped here.
    let sourceRect: CGRect
}

enum CaptureTargetResolver {
    static func resolve(pid: Int32) throws -> CaptureTarget {
        let content: SCShareableContent
        do {
            content = try runBlocking(timeoutNs: 10_000_000_000) {
                try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            }
        } catch let error as NativeError {
            throw error
        } catch {
            throw NativeError.runtime(code: "capture_failed", message: error.localizedDescription)
        }
        let windows = content.windows.filter { window in
            window.owningApplication?.processID == pid && window.windowLayer == 0 &&
            window.frame.width >= 1 && window.frame.height >= 1
        }
        guard let window = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw NativeError.runtime(code: "window_not_found", message: "pid \(pid) has no on-screen window at layer 0")
        }
        // Pilot 2026-10-20: a window filter follows one window, and each Ghostty tab is its own window, so a tab switch
        // left the capture on a hidden tab (and moving it cost a stream restart inside the timed span). Recording all of
        // the app's windows on the display, cropped to the measured window's rect, shows whichever tab is in front.
        guard let app = window.owningApplication,
              let display = content.displays.first(where: { $0.frame.intersects(window.frame) }) else {
            throw NativeError.runtime(code: "window_not_found", message: "pid \(pid): no display shows its window")
        }
        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        let scale = max(Double(filter.pointPixelScale), 1)
        return CaptureTarget(
            window: window,
            filter: filter,
            pixelSize: CGSize(width: (window.frame.width * scale).rounded(), height: (window.frame.height * scale).rounded()),
            scale: scale,
            windowFrame: window.frame,
            sourceRect: window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        )
    }
}

final class CaptureSession: NSObject, SCStreamOutput {
    private let stream: SCStream
    private let handlerQueue: DispatchQueue
    private let visionRegion: CGRect
    private let signatureRect: CGRect?
    private let secondaryRegion: CGRect?
    private let shouldReadSecondary: (([String]) -> Bool)?
    private let masksPixels: [CGRect]
    private let handler: (CapturedFrame) -> Void
    private let videoPath: String?
    private let delegate: StreamDelegate
    private let stopSemaphore = DispatchSemaphore(value: 0)
    private var writer: VideoWriter?
    private var writerFailed = false
    private let stateLock = NSLock()
    private var stopping = false
    private var finished = false

    private final class StreamDelegate: NSObject, SCStreamDelegate {
        weak var session: CaptureSession?

        func stream(_ stream: SCStream, didStopWithError error: Error) {
            session?.streamStopped()
        }
    }

    init(target: CaptureTarget,
         region: CGRect,
         masks: [CGRect],
         videoPath: String?,
         signatureRect: CGRect? = nil,
         secondaryRegion: CGRect? = nil,
         shouldReadSecondary: (([String]) -> Bool)? = nil,
         handler: @escaping (CapturedFrame) -> Void) throws {
        self.visionRegion = region
        self.secondaryRegion = secondaryRegion
        self.shouldReadSecondary = shouldReadSecondary
        self.signatureRect = signatureRect
        self.masksPixels = masks
        self.videoPath = videoPath
        self.handler = handler
        handlerQueue = DispatchQueue(label: "ademark.native.frames", qos: .userInteractive)
        delegate = StreamDelegate()

        let configuration = SCStreamConfiguration()
        configuration.width = Int(target.pixelSize.width)
        configuration.height = Int(target.pixelSize.height)
        configuration.sourceRect = target.sourceRect
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        configuration.shouldBeOpaque = true
        configuration.capturesAudio = false

        stream = SCStream(filter: target.filter, configuration: configuration, delegate: delegate)
        super.init()
        delegate.session = self
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: handlerQueue)
        } catch {
            throw NativeError.runtime(code: "capture_failed", message: error.localizedDescription)
        }
    }

    func start(timeoutNs: UInt64 = 10_000_000_000) throws {
        let stream = self.stream
        do {
            try runBlocking(timeoutNs: timeoutNs) { try await stream.startCapture() }
        } catch let error as NativeError {
            throw error
        } catch {
            throw NativeError.runtime(code: "capture_failed", message: error.localizedDescription)
        }
    }

    func stop() {
        stateLock.lock()
        if stopping || finished {
            stateLock.unlock()
            return
        }
        stopping = true
        stateLock.unlock()
        let stream = self.stream
        Task.detached(priority: .userInitiated) { [weak self] in
            try? await stream.stopCapture()
            self?.finish()
        }
    }

    func waitForStop(timeoutNs: UInt64 = 10_000_000_000) -> Bool {
        if stopSemaphore.wait(timeout: .now() + .nanoseconds(Int(timeoutNs))) == .success { return true }
        stop()
        return stopSemaphore.wait(timeout: .now() + .seconds(2)) == .success
    }

    private func finish() {
        stateLock.lock()
        if finished {
            stateLock.unlock()
            return
        }
        finished = true
        stateLock.unlock()
        // The writer is only touched on the handler queue, and this must not block it.
        handlerQueue.async { [weak self] in
            guard let self else { return }
            self.writer?.finish()
            self.writer = nil
            self.stopSemaphore.signal()
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let frameTime = CaptureSession.frameTime(sampleBuffer, arrivalNs: Clock.nowNs())
        let dirtyRects = dirtyRectsOutsideMasks(sampleBuffer)
        if let videoPath, writer == nil, !writerFailed {
            do {
                writer = try VideoWriter(path: videoPath,
                                         width: CVPixelBufferGetWidth(pixelBuffer),
                                         height: CVPixelBufferGetHeight(pixelBuffer))
            } catch {
                writerFailed = true
            }
        }
        writer?.append(sampleBuffer)
        let lines = Ocr.lines(in: pixelBuffer, region: visionRegion)
        let columns = signatureRect.flatMap { ColumnSignature.compute(pixelBuffer, rect: $0) }
        var secondaryLines: [String]?
        if let secondaryRegion, let shouldReadSecondary, shouldReadSecondary(lines) {
            secondaryLines = Ocr.lines(in: pixelBuffer, region: secondaryRegion)
        }
        handler(CapturedFrame(tNs: frameTime.tNs, source: frameTime.source,
                              lines: lines, dirtyRects: dirtyRects, columns: columns, secondaryLines: secondaryLines))
    }

    fileprivate func streamStopped() {
        finish()
    }

    /// PTS first, then `displayTime` read as mach ticks, then arrival. The choice itself is pure
    /// (`FrameTimeSelector`); this only reads the sample buffer.
    static func frameTime(_ sampleBuffer: CMSampleBuffer, arrivalNs: UInt64) -> FrameTimestamp {
        let ptsNs = Clock.cmTimeToNs(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        var displayTicks: UInt64?
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let info = attachments.first,
           let raw = info[SCStreamFrameInfo.displayTime] as? NSNumber {
            displayTicks = raw.uint64Value
        }
        return FrameTimeSelector.select(ptsNs: ptsNs, displayTicks: displayTicks, arrivalNs: arrivalNs)
    }

    private func dirtyRectsOutsideMasks(_ sampleBuffer: CMSampleBuffer) -> [CGRect] {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let info = attachments.first else { return [] }
        return DirtyRects.outsideMasks(CaptureSession.rectList(info[SCStreamFrameInfo.dirtyRects]),
                                       masks: masksPixels)
    }

    static func rectList(_ raw: Any?) -> [CGRect] {
        guard let raw else { return [] }
        if let values = raw as? [NSValue] {
            return values.map { $0.rectValue }.filter { $0.width > 0 && $0.height > 0 }
        }
        if let array = raw as? NSArray {
            var result: [CGRect] = []
            for item in array {
                if let value = item as? NSValue {
                    result.append(value.rectValue)
                } else if let dictionary = item as? [String: Any],
                          let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) {
                    result.append(bounds)
                }
            }
            return result.filter { $0.width > 0 && $0.height > 0 }
        }
        return []
    }
}
