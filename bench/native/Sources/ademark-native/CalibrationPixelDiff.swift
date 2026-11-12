import Foundation
import CoreGraphics
import CoreVideo

/// Pixels of one window crop in 32BGRA rows, top-left origin, so two frames can be compared without keeping the
/// capture buffers alive.
struct PixelFrame: Equatable {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let bytes: [UInt8]

    init(width: Int, height: Int, bytesPerRow: Int? = nil, bytes: [UInt8]) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow ?? width * 4
        self.bytes = bytes
    }

    static func from(_ buffer: CVPixelBuffer, rect: CGRect) -> PixelFrame? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else { return nil }
        let bounds = CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer))
        let clipped = rect.integral.intersection(bounds)
        guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let sourceRowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let source = base.assumingMemoryBound(to: UInt8.self)
        let x0 = Int(clipped.minX)
        let y0 = Int(clipped.minY)
        let w = Int(clipped.width)
        let h = Int(clipped.height)
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        bytes.withUnsafeMutableBufferPointer { destination in
            guard let out = destination.baseAddress else { return }
            for y in 0..<h {
                let row = source + (y0 + y) * sourceRowBytes + x0 * 4
                UnsafeMutableRawPointer(out.advanced(by: y * w * 4)).copyMemory(from: row, byteCount: w * 4)
            }
        }
        return PixelFrame(width: w, height: h, bytes: bytes)
    }

    func cgImage() -> CGImage? {
        guard bytes.count >= bytesPerRow * height else { return nil }
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little)
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: width,
                       height: height,
                       bitsPerComponent: 8,
                       bitsPerPixel: 32,
                       bytesPerRow: bytesPerRow,
                       space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: info,
                       provider: provider,
                       decode: nil,
                       shouldInterpolate: false,
                       intent: .defaultIntent)
    }
}

enum PixelDiff {
    /// 0 to 255 per channel; a pixel counts as changed above it on any channel.
    static let threshold = 24

    /// The bounding box, in pixels of the same frame, of the pixels inside `region` whose colour changed by more than
    /// `threshold` on any channel. Nil when nothing inside `region` changed.
    static func changedRect(reference: PixelFrame,
                            current: PixelFrame,
                            region: CGRect,
                            threshold: Int = PixelDiff.threshold) -> CGRect? {
        guard reference.width == current.width, reference.height == current.height,
              reference.bytesPerRow == current.bytesPerRow,
              reference.bytes.count >= reference.bytesPerRow * reference.height,
              current.bytes.count >= current.bytesPerRow * current.height else {
            return nil
        }
        let bounds = CGRect(x: 0, y: 0, width: reference.width, height: reference.height)
        let clipped = region.integral.intersection(bounds)
        guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { return nil }
        var minX = Int.max
        var minY = Int.max
        var maxX = -1
        var maxY = -1
        for y in Int(clipped.minY)..<Int(clipped.maxY) {
            let rowOffset = y * reference.bytesPerRow
            for x in Int(clipped.minX)..<Int(clipped.maxX) {
                let offset = rowOffset + x * 4
                if changed(reference.bytes, current.bytes, at: offset, threshold: threshold) {
                    minX = min(minX, x)
                    maxX = max(maxX, x)
                    minY = min(minY, y)
                    maxY = max(maxY, y)
                }
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }

    private static func changed(_ reference: [UInt8], _ current: [UInt8], at offset: Int, threshold: Int) -> Bool {
        for channel in 0..<4 where abs(Int(reference[offset + channel]) - Int(current[offset + channel])) > threshold {
            return true
        }
        return false
    }
}
