import Foundation

struct SampleRules {
    var rootPids: [Int32]
    var bundlePaths: [String]
    var vendorDirs: [String]
    var agentExecutables: [String]
    var excludeNames: [String]
    var harnessPids: [Int32] = []

    static let empty = SampleRules(rootPids: [], bundlePaths: [], vendorDirs: [], agentExecutables: [], excludeNames: [])

    static func load(path: String) throws -> SampleRules {
        let data = try requireFile(path)
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw NativeError.badArguments("rules file is not a JSON object: \(path)")
        }
        return SampleRules(
            rootPids: (object["rootPids"] as? [Any])?.compactMap { ($0 as? NSNumber)?.int32Value } ?? [],
            bundlePaths: (object["bundlePaths"] as? [Any])?.compactMap { $0 as? String } ?? [],
            vendorDirs: (object["vendorDirs"] as? [Any])?.compactMap { $0 as? String } ?? [],
            agentExecutables: (object["agentExecutables"] as? [Any])?.compactMap { $0 as? String } ?? [],
            excludeNames: (object["excludeNames"] as? [Any])?.compactMap { $0 as? String } ?? [],
            harnessPids: (object["harnessPids"] as? [Any])?.compactMap { ($0 as? NSNumber)?.int32Value } ?? []
        )
    }
}

enum ProcessGroup: String {
    case app
    case agents
}

struct AttributionResult {
    let groupByPid: [Int32: ProcessGroup]
    let excludedPids: Set<Int32>
}

enum Attribution {
    static let fixedExcludedNames: [String] = [
        "kernel_task", "launchd", "WindowServer", "mds", "mds_stores", "mdworker",
        "mdworker_shared", "trustd", "opendirectoryd", "logd", "cfprefsd", "distnoted",
        "coreaudiod", "syslogd",
    ]

    static func attribute(_ rules: SampleRules, processes: [ProcessInfoEntry], home: String = NSHomeDirectory()) -> AttributionResult {
        let byPid = Dictionary(processes.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        let excludedNames = Set((rules.excludeNames + fixedExcludedNames).map { $0.lowercased() })
        let prefixes = (rules.bundlePaths + rules.vendorDirs).map { normalizePrefix($0, home: home) }.filter { !$0.isEmpty }

        var excluded = Set<Int32>()
        for process in processes where isExcluded(process, names: excludedNames) {
            excluded.insert(process.pid)
        }

        excluded.formUnion(harnessTree(rules, processes: processes, byPid: byPid, prefixes: prefixes))

        var attributed = Set<Int32>()
        for process in processes where !excluded.contains(process.pid) {
            if rules.rootPids.contains(process.pid) || prefixes.contains(where: { matchesPrefix(process.path, $0) }) {
                attributed.insert(process.pid)
            }
        }

        var changed = true
        while changed {
            changed = false
            for process in processes where !excluded.contains(process.pid) && !attributed.contains(process.pid) {
                if let responsible = process.responsiblePid, attributed.contains(responsible) {
                    attributed.insert(process.pid)
                    changed = true
                    continue
                }
                if parentChain(process.pid, byPid: byPid).contains(where: { attributed.contains($0) }) {
                    attributed.insert(process.pid)
                    changed = true
                }
            }
        }

        var agentSeeds = Set<Int32>()
        for pid in attributed {
            guard let process = byPid[pid] else { continue }
            if matchesAgentExecutable(process, entries: rules.agentExecutables) {
                agentSeeds.insert(pid)
            }
        }

        var groups: [Int32: ProcessGroup] = [:]
        for pid in attributed {
            let ancestorIsAgent = parentChain(pid, byPid: byPid).contains(where: { agentSeeds.contains($0) })
            groups[pid] = (agentSeeds.contains(pid) || ancestorIsAgent) ? .agents : .app
        }
        return AttributionResult(groupByPid: groups, excludedPids: excluded)
    }

    /// The harness can run in a tab of the measured terminal, so the parent chain would book it as the app. This covers
    /// the harness, everything it started, and the shell chain up to the app. A root pid inside the tree stays measured.
    static func harnessTree(_ rules: SampleRules, processes: [ProcessInfoEntry], byPid: [Int32: ProcessInfoEntry], prefixes: [String]) -> Set<Int32> {
        guard !rules.harnessPids.isEmpty else { return [] }
        let roots = Set(rules.rootPids)
        var tree = Set<Int32>()
        for pid in rules.harnessPids where byPid[pid] != nil && !roots.contains(pid) {
            tree.insert(pid)
            for ancestor in parentChain(pid, byPid: byPid) {
                guard let process = byPid[ancestor], !roots.contains(ancestor), ancestor != 1,
                      !prefixes.contains(where: { matchesPrefix(process.path, $0) }) else { break }
                tree.insert(ancestor)
            }
        }
        let harnessRoots = Set(rules.harnessPids)
        for process in processes where !tree.contains(process.pid) && !roots.contains(process.pid) {
            let chain = parentChain(process.pid, byPid: byPid)
            let nearestRoot = chain.firstIndex(where: { roots.contains($0) }) ?? chain.count
            if chain.prefix(nearestRoot).contains(where: { harnessRoots.contains($0) }) {
                tree.insert(process.pid)
            }
        }
        return tree
    }

    static func isExcluded(_ process: ProcessInfoEntry, names: Set<String>) -> Bool {
        if names.contains(process.name.lowercased()) { return true }
        return names.contains(ProcessTable.basename(process.path).lowercased())
    }

    /// A path matches a prefix only on a path boundary: `/x/App.app` matches itself and
    /// `/x/App.app/Contents/...`, never `/x/App.app.old/...`.
    static func matchesPrefix(_ path: String, _ prefix: String) -> Bool {
        guard !prefix.isEmpty else { return false }
        if path == prefix { return true }
        let directory = prefix.hasSuffix("/") ? prefix : prefix + "/"
        return path.hasPrefix(directory)
    }

    static func normalizePrefix(_ prefix: String, home: String) -> String {
        var value = prefix.trimmingCharacters(in: .whitespaces)
        if value == "~" { value = home }
        else if value.hasPrefix("~/") { value = home + value.dropFirst(1) }
        while value.count > 1 && value.hasSuffix("/") { value.removeLast() }
        return value
    }

    /// Ancestors of `pid`, nearest first. Stops on cycles or a missing parent.
    static func parentChain(_ pid: Int32, byPid: [Int32: ProcessInfoEntry]) -> [Int32] {
        var chain: [Int32] = []
        var seen: Set<Int32> = [pid]
        var current = byPid[pid]?.ppid
        while let parent = current, parent > 0, !seen.contains(parent) {
            chain.append(parent)
            seen.insert(parent)
            current = byPid[parent]?.ppid
        }
        return chain
    }

    static func matchesAgentExecutable(_ process: ProcessInfoEntry, entries: [String]) -> Bool {
        let base = ProcessTable.basename(process.path)
        for entry in entries {
            let trimmed = entry.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if trimmed.contains("/") {
                let directory = trimmed.hasSuffix("/") ? trimmed : trimmed + "/"
                if process.path == trimmed || process.path.hasPrefix(directory) { return true }
            } else if base == trimmed || process.name == trimmed {
                return true
            }
        }
        return false
    }
}
