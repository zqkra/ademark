import Foundation
import CoreGraphics
import AppKit

/// Global CG coordinates put the origin at the top-left of the primary display; AppKit puts it at
/// the bottom-left of the primary display. A window on a display above the primary one therefore
/// moves from a negative CG y to a y above the primary height.
enum ScreenGeometry {
    static var primaryHeight: Double {
        if let screen = NSScreen.screens.first { return Double(screen.frame.height) }
        return Double(CGDisplayBounds(CGMainDisplayID()).height)
    }

    static func appKitFrame(cgFrame: CGRect, primaryHeight: Double) -> CGRect {
        CGRect(x: cgFrame.origin.x,
               y: primaryHeight - cgFrame.origin.y - cgFrame.height,
               width: cgFrame.width,
               height: cgFrame.height)
    }
}
