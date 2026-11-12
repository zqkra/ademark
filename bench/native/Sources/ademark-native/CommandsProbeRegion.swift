import Foundation
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit

enum ProbeRegionCommand {
    /// Room around `--search` for the 8-point OCR padding.
    static let marginPoints: Double = 16
    /// A frame younger than this can still be one the app drew before the last key.
    static let settleNs: UInt64 = 300_000_000
    static let referenceTimeoutNs: UInt64 = 10_000_000_000
    static let typedTimeoutNs: UInt64 = 8_000_000_000
    static let ocrPaddingPoints: Double = 8

    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let search = try RectSpec.parse(try arguments.string("--search"), name: "--search")
        guard search.w > 0, search.h > 0 else {
            throw NativeError.badArguments("--search needs a positive width and height")
        }
        let text = try arguments.string("--text")
        let clear = try ClearKeys.parse(arguments.optionalString("--clear"))

        try Permissions.requireAccessibility()
        try Permissions.requireScreenRecording()
        guard ProcessTable.isAlive(pid) else {
            throw NativeError.runtime(code: "process_not_found", message: "pid \(pid) is not running")
        }
        // ScreenCaptureKit needs a window-server connection first (see screenshot).
        _ = CGMainDisplayID()

        let target = try CaptureTargetResolver.resolve(pid: pid)
        let space = WindowSpace(scale: target.scale,
                                pixelWidth: target.pixelSize.width,
                                pixelHeight: target.pixelSize.height)
        let crop = try cropPixels(search: search, in: target)
        let searchPixels = space.pixelRect(for: search).offsetBy(dx: -crop.minX, dy: -crop.minY)
        let capture = try ProbeCapture(target: target, crop: crop)
        try capture.start()

        guard let reference = capture.waitForFrame(after: 0, deadline: Clock.nowNs() + referenceTimeoutNs) else {
            capture.stop()
            throw NativeError.runtime(code: "capture_timeout", message: "pid \(pid) showed no frame")
        }
        guard Frontmost.isFrontmost(pid) else {
            capture.stop()
            throw NativeError.runtime(code: "not_frontmost",
                                      message: "pid \(pid) is not the frontmost application; nothing was typed")
        }

        KeyPoster.typeText(text)
        let lastKeyNs = Clock.nowNs()
        Clock.sleepUntil(lastKeyNs + settleNs)
        guard let typed = capture.waitForTypedFrame(lastKeyNs: lastKeyNs, deadline: lastKeyNs + typedTimeoutNs) else {
            capture.stop()
            throw NativeError.runtime(code: "capture_timeout",
                                      message: "no frame of pid \(pid) arrived after the last key")
        }
        capture.stop()

        let changed = PixelDiff.changedRect(reference: reference.pixels, current: typed.pixels, region: searchPixels)
        let rect = changed.map { pixels in
            RectSpec(x: (pixels.minX + crop.minX) / target.scale,
                     y: (pixels.minY + crop.minY) / target.scale,
                     w: pixels.width / target.scale,
                     h: pixels.height / target.scale)
        }
        let ocrFound = changed.map { pixels in
            ProbeOcr.found(pixels, in: typed.pixels, text: text, scale: target.scale)
        } ?? false

        let cleared = Frontmost.isFrontmost(pid)
        if cleared { ClearKeys.press(clear) }
        emit(.object([
            ("rect", CalibrationJSON.rect(rect?.cgRect)),
            ("ocr_found", .bool(ocrFound)),
            ("cleared", .bool(cleared)),
        ]))
    }

    /// `--search` plus the OCR margin, clamped to the window, in the captured image's pixels.
    static func cropPixels(search: RectSpec, in target: CaptureTarget) throws -> CGRect {
        let points = CGRect(x: search.x - marginPoints,
                            y: search.y - marginPoints,
                            width: search.w + 2 * marginPoints,
                            height: search.h + 2 * marginPoints)
        let scale = target.scale
        let pixels = CGRect(x: (points.minX * scale).rounded(.down),
                            y: (points.minY * scale).rounded(.down),
                            width: (points.width * scale).rounded(.up),
                            height: (points.height * scale).rounded(.up))
        let bounds = CGRect(x: 0, y: 0, width: target.pixelSize.width, height: target.pixelSize.height)
        let clipped = pixels.integral.intersection(bounds)
        guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else {
            throw NativeError.runtime(code: "runtime_error", message: "--search does not intersect the window")
        }
        return clipped
    }
}

enum ProbeOcr {
    /// OCR the changed pixels padded by 8 points, so a glyph clipped at the box edge still reads.
    static func found(_ changed: CGRect, in frame: PixelFrame, text: String, scale: Double) -> Bool {
        guard let image = frame.cgImage() else { return false }
        let padding = ProbeRegionCommand.ocrPaddingPoints * scale
        let padded = changed.insetBy(dx: -padding, dy: -padding)
        let imageSpace = WindowSpace(scale: 1, pixelWidth: Double(frame.width), pixelHeight: Double(frame.height))
        let spec = RectSpec(x: padded.minX, y: padded.minY, w: padded.width, h: padded.height)
        return TextMatcher.contains(Ocr.lines(in: image, region: imageSpace.visionRect(for: spec)), needle: text)
    }
}

struct ProbeFrame {
    let tNs: UInt64
    let pixels: PixelFrame
}

/// One ScreenCaptureKit stream of the window, cut to `crop`, keeping only the newest frame's pixels.
/// `CaptureController` keeps OCR lines rather than pixels, and the probe compares pixels.
final class ProbeCapture: NSObject, SCStreamOutput {
    private let stream: SCStream
    private let crop: CGRect
    private let queue = DispatchQueue(label: "ademark.native.probe-region", qos: .userInteractive)
    private let delegate = ProbeStreamDelegate()
    private let frameLock = NSLock()
    private var newest: ProbeFrame?
    private let stateLock = NSLock()
    private var stopping = false

    init(target: CaptureTarget, crop: CGRect) throws {
        self.crop = crop
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
        delegate.capture = self
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        } catch {
            throw NativeError.runtime(code: "capture_failed", message: error.localizedDescription)
        }
    }

    func start() throws {
        let stream = self.stream
        do {
            try runBlocking(timeoutNs: 10_000_000_000) { try await stream.startCapture() }
        } catch let error as NativeError {
            throw error
        } catch {
            throw NativeError.runtime(code: "capture_failed", message: error.localizedDescription)
        }
    }

    func stop() {
        stateLock.lock()
        if stopping {
            stateLock.unlock()
            return
        }
        stopping = true
        stateLock.unlock()
        let stream = self.stream
        Task.detached(priority: .userInitiated) { try? await stream.stopCapture() }
    }

    /// The stream can also end on its own; `waitForFrame` then runs into its deadline and the command fails.
    fileprivate func streamStopped() {}

    /// The newest frame at or after `earliest`, waiting until `deadline`.
    func waitForFrame(after earliest: UInt64, deadline: UInt64) -> ProbeFrame? {
        while true {
            if let frame = newestFrame(), frame.tNs >= earliest { return frame }
            if Clock.nowNs() >= deadline { return nil }
            MainLoop.sleep(10_000_000)
        }
    }

    /// The newest frame at or after `lastKeyNs`; waits for one until `deadline` when the window has not drawn since
    /// the key. A composer that draws the text once and has no caret may never send a later frame.
    func waitForTypedFrame(lastKeyNs: UInt64, deadline: UInt64) -> ProbeFrame? {
        while true {
            let now = Clock.nowNs()
            let newest = newestFrame()
            let times = newest.map { [$0.tNs] } ?? []
            if let chosen = ProbeFrameSelector.newestAfterKey(frames: times, lastKeyNs: lastKeyNs, nowNs: now),
               let frame = newest, frame.tNs == chosen {
                return frame
            }
            if now >= deadline { return nil }
            MainLoop.sleep(10_000_000)
        }
    }

    private func newestFrame() -> ProbeFrame? {
        frameLock.lock()
        defer { frameLock.unlock() }
        return newest
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let pixels = PixelFrame.from(buffer, rect: crop) else { return }
        let time = CaptureSession.frameTime(sampleBuffer, arrivalNs: Clock.nowNs())
        frameLock.lock()
        newest = ProbeFrame(tNs: time.tNs, pixels: pixels)
        frameLock.unlock()
    }
}

private final class ProbeStreamDelegate: NSObject, SCStreamDelegate {
    weak var capture: ProbeCapture?

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        capture?.streamStopped()
    }
}
