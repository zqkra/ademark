import Foundation
import Darwin

/// Cumulative CPU ticks of the whole machine. The four counters wrap at 32 bits on macOS, so deltas are taken in
/// wrapping arithmetic; at 100 Hz a wrap is hundreds of days away.
struct CpuTicks: Equatable {
    var user: UInt32
    var system: UInt32
    var idle: UInt32
    var nice: UInt32
}

enum HostCpu {
    static var logicalCpuCount: Int {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctlbyname("hw.logicalcpu", &value, &size, nil, 0) == 0, value > 0 else {
            return max(ProcessInfo.processInfo.processorCount, 1)
        }
        return Int(value)
    }

    static func ticks() -> CpuTicks? {
        var info = host_cpu_load_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<host_cpu_load_info_data_t>.stride / MemoryLayout<integer_t>.stride
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, rebound, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return CpuTicks(user: info.cpu_ticks.0, system: info.cpu_ticks.1,
                        idle: info.cpu_ticks.2, nice: info.cpu_ticks.3)
    }
}
