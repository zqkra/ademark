import Foundation
import AVFoundation
import CoreMedia
import CoreVideo

final class VideoWriter {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var started = false
    private(set) var appended = 0

    init(path: String, width: Int, height: Int) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: max(width, 2),
            AVVideoHeightKey: max(height, 2),
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            throw NativeError.runtime(code: "video_failed", message: "asset writer rejected the video input")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw NativeError.runtime(code: "video_failed",
                                      message: writer.error?.localizedDescription ?? "asset writer did not start")
        }
    }

    func append(_ buffer: CMSampleBuffer) {
        if !started {
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(buffer))
            started = true
        }
        guard input.isReadyForMoreMediaData else { return }
        if input.append(buffer) { appended += 1 }
    }

    func finish() {
        guard writer.status == .writing else { return }
        input.markAsFinished()
        let semaphore = DispatchSemaphore(value: 0)
        writer.finishWriting { semaphore.signal() }
        semaphore.wait()
    }
}
