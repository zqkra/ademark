import Foundation

enum SelfTestCommand {
    static func run(_ arguments: Arguments) throws {
        let report = SelfTest.run()
        emit(.object([
            ("passed", .int(Int64(report.passed))),
            ("failed", .int(Int64(report.failed))),
            ("failures", .array(report.failures.map { .string($0) })),
        ]))
        if report.failed > 0 { exit(4) }
    }
}
