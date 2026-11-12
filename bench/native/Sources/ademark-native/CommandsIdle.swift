import Foundation

struct IdleOptions {
    let cpuCores: Double
    let quietMs: Int
    let capS: Double
}

/// `idle`: waits until the whole machine's CPU use stays under `--cpu-cores` for `--quiet-ms`, or until `--cap-s`.
/// Replaces the fixed sleeps A1 and A2 used after purge and quit.
enum IdleCommand {
    static let sampleIntervalNs: UInt64 = 100_000_000

    static func run(_ arguments: Arguments) throws {
        let options = try parse(arguments)
        let started = Clock.nowNs()
        let deadline = started + Clock.secondsToNs(options.capS)
        let quietNs = UInt64(options.quietMs) * 1_000_000
        let logicalCpus = HostCpu.logicalCpuCount
        guard var previous = HostCpu.ticks() else {
            throw NativeError.runtime(code: "runtime_error", message: "host CPU ticks are unavailable")
        }

        var samples: [CoreSample] = []
        var lastCores = 0.0
        var quiet = false
        while true {
            let now = Clock.nowNs()
            if now >= deadline { break }
            Clock.sleepUntil(min(deadline, now + sampleIntervalNs))
            guard let current = HostCpu.ticks() else {
                throw NativeError.runtime(code: "runtime_error", message: "host CPU ticks are unavailable")
            }
            if let cores = IdleRule.coresBusy(previous: previous, current: current, logicalCpus: logicalCpus) {
                lastCores = cores
                samples.append(CoreSample(tNs: Clock.nowNs(), cores: cores))
            }
            previous = current
            // The cap wins over a quiet window that completes exactly at it: a capped wait reports `quiet: false`.
            if Clock.nowNs() >= deadline { break }
            if IdleRule.isQuiet(samples: samples, threshold: options.cpuCores, quietNs: quietNs) {
                quiet = true
                break
            }
        }

        emit(.object([
            ("waited_ms", .double(Clock.nsToMs(Clock.nowNs() - started))),
            ("quiet", .bool(quiet)),
            ("cores_last", .double(lastCores)),
        ]))
    }

    static func parse(_ arguments: Arguments) throws -> IdleOptions {
        let cpuCores = try arguments.double("--cpu-cores")
        guard cpuCores > 0 else {
            throw NativeError.badArguments("--cpu-cores must be greater than 0")
        }
        let quietMs = try arguments.int("--quiet-ms")
        guard quietMs >= 100 else {
            throw NativeError.badArguments("--quiet-ms must be at least 100")
        }
        let capS = try arguments.double("--cap-s")
        guard capS > 0, capS <= 600 else {
            throw NativeError.badArguments("--cap-s must be greater than 0 and at most 600")
        }
        return IdleOptions(cpuCores: cpuCores, quietMs: quietMs, capS: capS)
    }
}
