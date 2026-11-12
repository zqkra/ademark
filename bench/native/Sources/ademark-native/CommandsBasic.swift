import Foundation

enum NowCommand {
    static func run(_ arguments: Arguments) throws {
        emit(.object([("t_ns", .uint(Clock.nowNs()))]))
    }
}

enum ProcsCommand {
    static func run(_ arguments: Arguments) throws {
        let entries = ProcessTable.all()
            .sorted { $0.pid < $1.pid }
            .map { entry in
                JSONValue.object([
                    ("pid", .int(Int64(entry.pid))),
                    ("ppid", .int(Int64(entry.ppid))),
                    ("path", .string(entry.path)),
                    ("name", .string(entry.name)),
                    ("responsible_pid", entry.responsiblePid.map { JSONValue.int(Int64($0)) } ?? .null),
                ])
            }
        emit(.array(entries))
    }
}
