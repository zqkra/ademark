import Foundation
import CoreGraphics
import ApplicationServices

enum Permissions {
    /// Read with the preflight call only: it reports the grant and never opens a permission dialog.
    static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    /// `CGPreflightScreenCaptureAccess` never prompts, unlike `CGRequestScreenCaptureAccess`.
    static var screenRecordingGranted: Bool { CGPreflightScreenCaptureAccess() }

    static func requireAccessibility() throws {
        guard accessibilityGranted else {
            throw NativeError.permission(code: "accessibility_not_granted",
                                         message: "Accessibility permission is required for this subcommand")
        }
    }

    static func requireScreenRecording() throws {
        guard screenRecordingGranted else {
            throw NativeError.permission(code: "screen_recording_not_granted",
                                         message: "Screen Recording permission is required for this subcommand")
        }
    }
}
