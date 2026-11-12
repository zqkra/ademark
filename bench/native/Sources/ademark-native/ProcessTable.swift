import Foundation
import Darwin

struct ProcessInfoEntry {
    let pid: Int32
    let ppid: Int32
    let path: String
    let name: String
    let responsiblePid: Int32?
}

typealias ResponsiblePidFn = @convention(c) (Int32) -> Int32

enum ProcessTable {
    /// Resolved once: the symbol lives in libsystem_coreservices and is not public API.
    private static let responsibleFn: ResponsiblePidFn? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else {
            return nil
        }
        return unsafeBitCast(symbol, to: ResponsiblePidFn.self)
    }()

    static func responsiblePid(_ pid: Int32) -> Int32? {
        guard let fn = responsibleFn else { return nil }
        let value = fn(pid)
        return value > 0 ? value : nil
    }

    static func allPids() -> [Int32] {
        let capacity = max(Int(proc_listallpids(nil, 0)) * 2, 512)
        var pids = [Int32](repeating: 0, count: capacity)
        let count = proc_listallpids(&pids, Int32(capacity * MemoryLayout<Int32>.size))
        guard count > 0 else { return [] }
        return Array(pids.prefix(Int(count))).filter { $0 > 0 }
    }

    static func executablePath(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let written = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard written > 0 else { return nil }
        return String(cString: buffer)
    }

    static func bsdInfo(_ pid: Int32) -> proc_bsdinfo? {
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.size
        let written = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size))
        return written == Int32(size) ? info : nil
    }

    static func entry(_ pid: Int32) -> ProcessInfoEntry? {
        guard var bsd = bsdInfo(pid) else { return nil }
        let path = executablePath(pid) ?? ""
        let commName = fixedString(&bsd.pbi_comm)
        let longName = fixedString(&bsd.pbi_name)
        let name = longName.isEmpty ? (commName.isEmpty ? basename(path) : commName) : longName
        return ProcessInfoEntry(
            pid: pid,
            ppid: Int32(bitPattern: bsd.pbi_ppid),
            path: path,
            name: name,
            responsiblePid: responsiblePid(pid)
        )
    }

    static func all() -> [ProcessInfoEntry] {
        allPids().compactMap { entry($0) }
    }

    static func fixedString<T>(_ tuple: inout T) -> String {
        withUnsafePointer(to: &tuple) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout<T>.size) { String(cString: $0) }
        }
    }

    static func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    static func isAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }
}
