import Foundation
import CoreGraphics

struct RectSpec: Equatable {
    var x: Double
    var y: Double
    var w: Double
    var h: Double

    static func parse(_ text: String, name: String) throws -> RectSpec {
        let parts = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 4 else {
            throw NativeError.badArguments("\(name) must be x,y,w,h")
        }
        let numbers = parts.compactMap { Double($0) }
        guard numbers.count == 4, numbers.allSatisfy({ $0.isFinite }), numbers[2] >= 0, numbers[3] >= 0 else {
            throw NativeError.badArguments("\(name) must be four non-negative numbers")
        }
        return RectSpec(x: numbers[0], y: numbers[1], w: numbers[2], h: numbers[3])
    }

    var cgRect: CGRect { CGRect(x: x, y: y, width: w, height: h) }
}

struct PointSpec: Equatable {
    var x: Double
    var y: Double

    static func parse(_ text: String, name: String) throws -> PointSpec {
        let parts = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2 else { throw NativeError.badArguments("\(name) must be x,y") }
        let numbers = parts.compactMap { Double($0) }
        guard numbers.count == 2, numbers.allSatisfy({ $0.isFinite }) else {
            throw NativeError.badArguments("\(name) must be two numbers")
        }
        return PointSpec(x: numbers[0], y: numbers[1])
    }

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

struct SizeSpec: Equatable {
    var w: Double
    var h: Double

    static func parse(_ text: String, name: String) throws -> SizeSpec {
        let lower = text.lowercased()
        let parts = lower.split(separator: "x").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]), w > 0, h > 0 else {
            throw NativeError.badArguments("\(name) must be WxH with positive numbers")
        }
        return SizeSpec(w: w, h: h)
    }
}

/// Converts between a window's point space and pixel space, both with the window's top-left as origin.
struct WindowSpace {
    let scale: Double
    let pixelWidth: Double
    let pixelHeight: Double

    func pixelRect(for spec: RectSpec) -> CGRect {
        CGRect(x: spec.x * scale, y: spec.y * scale, width: spec.w * scale, height: spec.h * scale)
    }

    func pixelPoint(for spec: PointSpec) -> CGPoint {
        CGPoint(x: spec.x * scale, y: spec.y * scale)
    }

    func screenPoint(windowOrigin: CGPoint, spec: PointSpec) -> CGPoint {
        CGPoint(x: windowOrigin.x + spec.x, y: windowOrigin.y + spec.y)
    }

    /// Vision normalizes from the bottom-left of the image; input rects are top-left based.
    func visionRect(for spec: RectSpec) -> CGRect {
        guard pixelWidth > 0, pixelHeight > 0 else { return CGRect(x: 0, y: 0, width: 1, height: 1) }
        let pixel = pixelRect(for: spec)
        let x = pixel.minX / pixelWidth
        let w = pixel.width / pixelWidth
        let h = pixel.height / pixelHeight
        let y = 1 - (pixel.minY / pixelHeight) - h
        // Vision rejects a region of interest outside the unit square, and the capture path then reads no text at
        // all (pilot 2026-10-20: a region 2 points wider than the window gave empty OCR on every frame). Clip it.
        let clipped = CGRect(x: x, y: y, width: w, height: h).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        return clipped.isNull || clipped.isEmpty ? CGRect(x: 0, y: 0, width: 1, height: 1) : clipped
    }
}
