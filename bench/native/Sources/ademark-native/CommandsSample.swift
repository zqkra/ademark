import Foundation

enum SampleDuration {
    static let maxS: Double = 86_400

    static func validate(_ durationS: Double) throws -> Double {
        guard durationS >= 0, durationS <= maxS else {
            throw NativeError.badArguments("--duration-s must be between 0 and 86400")
        }
        return durationS
    }

    /// Zero is the background mode: the sampler runs until SIGINT or SIGTERM. A positive value is a
    /// fixed window, as before.
    static func runsUntilSignal(_ durationS: Double) -> Bool {
        durationS == 0
    }
}

enum SampleCommand {
    static let columns = [
        "t_ns", "pid", "ppid", "group", "exe", "phys_footprint_b", "lifetime_max_b",
        "cpu_user_ns", "cpu_sys_ns", "wakeups_idle", "wakeups_irq", "energy_nj",
    ]

    static func run(_ arguments: Arguments) throws {
        let rulesPath = try arguments.string("--rules")
        let hz = try arguments.double("--hz")
        let durationS = try SampleDuration.validate(try arguments.double("--duration-s"))
        let csvPath = try arguments.string("--csv")
        guard hz > 0, hz <= 1000 else {
            throw NativeError.badArguments("--hz must be greater than 0 and at most 1000")
        }
        let rules = try SampleRules.load(path: rulesPath)

        let stop = SignalStop()
        let csv = try SampleCsv(path: csvPath, header: columns.joined(separator: ","))

        let started = Clock.nowNs()
        let intervalNs = max(UInt64(1_000_000_000 / hz), 1)
        let fixedEnd: UInt64? = SampleDuration.runsUntilSignal(durationS)
            ? nil
            : started + UInt64(durationS * 1_000_000_000)

        var tick = 0
        var rowCount = 0
        var pidsSeen = Set<Int32>()
        var attribution: AttributionResult = .init(groupByPid: [:], excludedPids: [])
        var entriesByPid: [Int32: ProcessInfoEntry] = [:]
        var nextRefresh = started

        var appSums: [Int64] = []
        var agentsSums: [Int64] = []
        var totalSums: [Int64] = []

        while !stop.isRequested {
            if let fixedEnd, Clock.nowNs() >= fixedEnd { break }

            let tickNs = Clock.nowNs()
            if tickNs >= nextRefresh || tick == 0 {
                let processes = ProcessTable.all()
                entriesByPid = Dictionary(processes.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
                attribution = Attribution.attribute(rules, processes: processes)
                nextRefresh = tickNs + 1_000_000_000
            }

            var appSum: Int64 = 0
            var agentsSum: Int64 = 0
            var rows: [String] = []
            for (pid, group) in attribution.groupByPid.sorted(by: { $0.key < $1.key }) {
                guard let entry = entriesByPid[pid], let usage = UsageReader.read(pid) else { continue }
                let groupName = group.rawValue
                if group == .app { appSum += usage.physFootprint } else { agentsSum += usage.physFootprint }
                pidsSeen.insert(pid)
                rows.append([
                    String(tickNs),
                    String(pid),
                    String(entry.ppid),
                    groupName,
                    csvEscape(entry.path),
                    String(usage.physFootprint),
                    String(usage.lifetimeMax),
                    String(usage.cpuUserNs),
                    String(usage.cpuSysNs),
                    String(usage.wakeupsIdle),
                    String(usage.wakeupsIrq),
                    String(usage.energyNj),
                ].joined(separator: ","))
                rowCount += 1
            }
            try csv.append(rows)
            appSums.append(appSum)
            agentsSums.append(agentsSum)
            totalSums.append(appSum + agentsSum)
            tick += 1

            let nextTick = started + UInt64(tick) * intervalNs
            sleepUntil(nextTick, stopping: stop)
        }

        csv.close()
        emit(.object([
            ("ticks", .int(Int64(tick))),
            ("rows", .int(Int64(rowCount))),
            ("pids", .int(Int64(pidsSeen.count))),
            ("app_median_b", .int(Stats.median(appSums))),
            ("app_p95_b", .int(Stats.percentile(appSums, 0.95))),
            ("agents_median_b", .int(Stats.median(agentsSums))),
            ("total_median_b", .int(Stats.median(totalSums))),
            ("total_p95_b", .int(Stats.percentile(totalSums, 0.95))),
        ]))
    }

    /// Sleeps in short slices so a signal is noticed between ticks instead of after the whole interval.
    private static func sleepUntil(_ deadline: UInt64, stopping stop: SignalStop) {
        while !stop.isRequested {
            let now = Clock.nowNs()
            if now >= deadline { return }
            Clock.sleepNs(min(deadline - now, 50_000_000))
        }
    }

    static func csvEscape(_ value: String) -> String {
        if value.contains(",") || value.contains("\"") || value.contains("\n") {
            return "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return value
    }
}
