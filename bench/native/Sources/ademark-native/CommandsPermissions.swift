import Foundation

/// `permissions`: the two TCC grants the harness needs, read with the preflight calls only, so it never prompts.
enum PermissionsCommand {
    static func run(_ arguments: Arguments) throws {
        emit(.object([
            ("accessibility", .bool(Permissions.accessibilityGranted)),
            ("screen_recording", .bool(Permissions.screenRecordingGranted)),
        ]))
    }
}
