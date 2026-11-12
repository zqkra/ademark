import Foundation
import CoreGraphics

/// Which dirty rects keep a window busy, and how they are written to the frames file.
/// The probe region counts as a mask for echo's settle rule (TESTS.md §1.3), because the composer's caret blinks
/// there; without it the settle poll waits for its cap in every A1, A2 and A3 run. Nothing else treats the region
/// as a mask, so the ready path is unchanged.
enum DirtyRects {
    /// The frames file lists at most this many rects per frame; `dirty_outside_masks` keeps the full count.
    static let framesFileLimit = 8

    static func masksWithRegion(_ masks: [CGRect], region: CGRect) -> [CGRect] {
        masks + [region]
    }

    /// A rect counts as inside only when one mask fully contains it, like the settle rule reads them.
    static func outsideMasks(_ rects: [CGRect], masks: [CGRect]) -> [CGRect] {
        rects.filter { rect in !masks.contains { $0.contains(rect) } }
    }

    /// Pixel rects to window points, the inverse of `WindowSpace.pixelRect(for:)`.
    static func windowRects(_ pixels: [CGRect], scale: Double, limit: Int = framesFileLimit) -> [RectSpec] {
        let divisor = scale > 0 ? scale : 1
        return pixels.prefix(max(limit, 0)).map { rect in
            RectSpec(x: rect.minX / divisor, y: rect.minY / divisor,
                     w: rect.width / divisor, h: rect.height / divisor)
        }
    }
}
