import Foundation
import CoreGraphics
import ImageIO

enum WindowCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let size = try SizeSpec.parse(try arguments.string("--size"), name: "--size")
        let shouldFront = arguments.has("--front")

        try Permissions.requireAccessibility()
        guard ProcessTable.isAlive(pid) else {
            throw NativeError.runtime(code: "process_not_found", message: "pid \(pid) is not running")
        }
        guard let window = AxWindow.firstStandardWindow(pid: pid) else {
            throw NativeError.runtime(code: "window_not_found", message: "pid \(pid) has no standard window")
        }
        let frame = AxWindow.apply(position: CGPoint(x: 80, y: 60), size: CGSize(width: size.w, height: size.h), to: window)
        if shouldFront {
            AxWindow.raise(window, pid: pid)
        }
        Clock.sleepNs(150_000_000)
        let windowID = WindowFinder.frontmost(pid: pid)?.windowID ?? 0
        let finalFrame = WindowFinder.frontmost(pid: pid)?.frame ?? frame
        emit(.object([
            ("window_id", .uint(UInt64(windowID))),
            ("frame", .object([
                ("x", .double(Double(finalFrame.origin.x))),
                ("y", .double(Double(finalFrame.origin.y))),
                ("w", .double(Double(finalFrame.size.width))),
                ("h", .double(Double(finalFrame.size.height))),
            ])),
        ]))
    }
}

enum KeysCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let text = arguments.optionalString("--text")
        let combo = arguments.optionalString("--combo")
        let enter = arguments.has("--enter")

        let chosen = [text != nil, combo != nil, enter].filter { $0 }.count
        guard chosen == 1 else {
            throw NativeError.badArguments("keys needs exactly one of --text, --combo, --enter")
        }
        // Validate the combo before any event is posted.
        let parsedCombo = try combo.map { try KeyCombo.parseArgument($0) }

        try Permissions.requireAccessibility()
        guard ProcessTable.isAlive(pid) else {
            throw NativeError.runtime(code: "process_not_found", message: "pid \(pid) is not running")
        }
        // Events go to the HID tap, so they would land in whatever app is frontmost. Refuse rather
        // than type into the wrong app.
        guard Frontmost.isFrontmost(pid) else {
            throw NativeError.runtime(code: "not_frontmost",
                                      message: "pid \(pid) is not the frontmost application; nothing was posted")
        }

        let t = Clock.nowNs()
        if let text {
            KeyPoster.typeText(text)
        } else if let parsedCombo {
            KeyPoster.press(parsedCombo)
        } else {
            KeyPoster.press(KeyCombo(modifiers: [], key: .named(.enter)))
        }
        emit(.object([("t_ns", .uint(t))]))
    }
}

enum OcrCommand {
    static func run(_ arguments: Arguments) throws {
        let image = try arguments.string("--image")
        let region = try arguments.optionalString("--region").map { try RectSpec.parse($0, name: "--region") }
        let data = try requireFile(image)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NativeError.badArguments("not a readable image: \(image)")
        }
        let space = WindowSpace(scale: 1, pixelWidth: Double(cgImage.width), pixelHeight: Double(cgImage.height))
        let visionRegion = region.map { space.visionRect(for: $0) }
        let lines = Ocr.lines(in: cgImage, region: visionRegion)
        emit(.object([("lines", .array(lines.map { .string($0) }))]))
    }
}
