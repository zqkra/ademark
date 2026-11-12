import Foundation
import ScreenCaptureKit
import CoreGraphics

enum ScreenshotCommand {
    static func run(_ arguments: Arguments) throws {
        let pid = try arguments.int32("--pid")
        let out = try arguments.string("--out")
        try Permissions.requireScreenRecording()
        // Pilot 2026-10-20: without a window-server connection first, ScreenCaptureKit aborted this CLI with
        // "Assertion failed: (did_initialize), function CGS_REQUIRE_INIT". Asking for the main display opens it.
        _ = CGMainDisplayID()

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
        guard let window = content.windows.first(where: {
            $0.owningApplication?.processID == pid && $0.windowLayer == 0
        }) else {
            throw NativeError.runtime(code: "window_not_found", message: "pid \(pid) has no on-screen window at layer 0")
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = max(Double(filter.pointPixelScale), 1)
        let configuration = SCStreamConfiguration()
        configuration.width = Int((window.frame.width * scale).rounded())
        configuration.height = Int((window.frame.height * scale).rounded())
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false

        let image: CGImage
        do {
            image = try runBlocking(timeoutNs: 20_000_000_000) {
                try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            }
        } catch let error as NativeError {
            throw error
        } catch {
            throw NativeError.runtime(code: "capture_failed", message: error.localizedDescription)
        }

        let url = URL(fileURLWithPath: out)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            throw NativeError.io("cannot create \(out)")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw NativeError.io("cannot write \(out)")
        }
        emit(.object([("path", .string(out))]))
    }
}
