import Foundation

enum NativeError: Error {
    case badArguments(String)
    case permission(code: String, message: String)
    case runtime(code: String, message: String)

    static func runtime(_ message: String) -> NativeError {
        .runtime(code: "runtime_error", message: message)
    }

    static func io(_ message: String) -> NativeError {
        .runtime(code: "io_error", message: message)
    }

    var code: String {
        switch self {
        case .badArguments: return "bad_arguments"
        case .permission(let code, _): return code
        case .runtime(let code, _): return code
        }
    }

    var message: String {
        switch self {
        case .badArguments(let message): return message
        case .permission(_, let message): return message
        case .runtime(_, let message): return message
        }
    }

    var exitCode: Int32 {
        switch self {
        case .badArguments: return 2
        case .permission: return 3
        case .runtime: return 4
        }
    }
}

func fail(_ error: NativeError) -> Never {
    emit(.object([("error", .string(error.code)), ("message", .string(error.message))]))
    exit(error.exitCode)
}

/// A file named on the command line: missing or unreadable is bad input, not a runtime failure.
func requireFile(_ path: String) throws -> Data {
    guard let data = FileManager.default.contents(atPath: (path as NSString).expandingTildeInPath) else {
        throw NativeError.badArguments("cannot read \(path)")
    }
    return data
}

func writeFile(_ path: String, _ data: Data) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    do {
        try data.write(to: url)
    } catch {
        throw NativeError.io("cannot write \(path): \(error.localizedDescription)")
    }
}

func writeText(_ path: String, _ text: String) throws {
    try writeFile(path, Data(text.utf8))
}
