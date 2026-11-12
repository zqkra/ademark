import Foundation
import CoreGraphics
import CoreVideo

/// One hash per pixel column of a region, so two frames can be compared column by column without keeping their pixels.
enum ColumnSignature {
    /// Luma quantized to 32 levels, hashed (FNV-1a) down each column of `rect` in a 32BGRA buffer. Nil when the rect is
    /// outside the buffer or the buffer is not 32BGRA.
    static func compute(_ buffer: CVPixelBuffer, rect: CGRect) -> [UInt32]? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let clipped = rect.integral.intersection(CGRect(x: 0, y: 0, width: width, height: height))
        guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        let x0 = Int(clipped.minX), x1 = Int(clipped.maxX)
        let y0 = Int(clipped.minY), y1 = Int(clipped.maxY)
        var hashes = [UInt32](repeating: 2_166_136_261, count: x1 - x0)
        for y in y0..<y1 {
            let row = bytes + y * rowBytes
            for x in x0..<x1 {
                let pixel = row + x * 4
                let luma = (UInt32(pixel[2]) * 77 + UInt32(pixel[1]) * 150 + UInt32(pixel[0]) * 29) >> 11
                hashes[x - x0] = (hashes[x - x0] ^ luma) &* 16_777_619
            }
        }
        return hashes
    }

    /// Columns that differ between two signatures of the same region.
    static func changedColumns(_ a: [UInt32], _ b: [UInt32]) -> Int {
        guard a.count == b.count else { return max(a.count, b.count) }
        var changed = 0
        for index in a.indices where a[index] != b[index] { changed += 1 }
        return changed
    }
}
