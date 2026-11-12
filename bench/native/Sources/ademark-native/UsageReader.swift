import Foundation
import Darwin

struct ProcessUsage {
    let physFootprint: Int64
    let lifetimeMax: Int64
    let cpuUserNs: UInt64
    let cpuSysNs: UInt64
    let wakeupsIdle: Int64
    let wakeupsIrq: Int64
    let energyNj: Int64
}

enum UsageReader {
    static func read(_ pid: Int32) -> ProcessUsage? {
        var info = rusage_info_v6()
        let ok: Bool = withUnsafeMutablePointer(to: &info) { pointer in
            let raw = UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: rusage_info_t?.self)
            return proc_pid_rusage(pid, RUSAGE_INFO_V6, raw) == 0
        }
        guard ok else { return nil }
        return ProcessUsage(
            physFootprint: Int64(bitPattern: info.ri_phys_footprint),
            lifetimeMax: Int64(bitPattern: info.ri_lifetime_max_phys_footprint),
            cpuUserNs: Clock.ticksToNs(info.ri_user_time),
            cpuSysNs: Clock.ticksToNs(info.ri_system_time),
            wakeupsIdle: Int64(bitPattern: info.ri_pkg_idle_wkups),
            wakeupsIrq: Int64(bitPattern: info.ri_interrupt_wkups),
            energyNj: Int64(bitPattern: info.ri_energy_nj)
        )
    }
}
