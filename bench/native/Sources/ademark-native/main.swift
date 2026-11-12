import Foundation

let rawArguments = Array(CommandLine.arguments.dropFirst())
guard let subcommand = rawArguments.first else {
    emit(.object([("error", .string("bad_arguments")), ("message", .string("missing subcommand"))]))
    exit(2)
}
let arguments = Arguments(Array(rawArguments.dropFirst()))

do {
    switch subcommand {
    case "now": try NowCommand.run(arguments)
    case "procs": try ProcsCommand.run(arguments)
    case "sample": try SampleCommand.run(arguments)
    case "window": try WindowCommand.run(arguments)
    case "keys": try KeysCommand.run(arguments)
    case "echo": try EchoCommand.run(arguments)
    case "watch": try WatchCommand.run(arguments)
    case "lag": try LagCommand.run(arguments)
    case "scroll": try ScrollCommand.run(arguments)
    case "idle": try IdleCommand.run(arguments)
    case "permissions": try PermissionsCommand.run(arguments)
    case "cover": try CoverCommand.run(arguments)
    case "ocr": try OcrCommand.run(arguments)
    case "screenshot": try ScreenshotCommand.run(arguments)
    case "ax-tree": try AxTreeCommand.run(arguments)
    case "menu-shortcuts": try MenuShortcutsCommand.run(arguments)
    case "ax-press": try AxPressCommand.run(arguments)
    case "click": try ClickCommand.run(arguments)
    case "probe-region": try ProbeRegionCommand.run(arguments)
    case "selftest": try SelfTestCommand.run(arguments)
    default:
        throw NativeError.badArguments("unknown subcommand: \(subcommand)")
    }
    exit(0)
} catch let error as NativeError {
    fail(error)
} catch {
    fail(.runtime(code: "runtime_error", message: "\(error)"))
}
