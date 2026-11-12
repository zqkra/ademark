import Foundation

struct Arguments {
    private var values: [String: String] = [:]
    private var flags: Set<String> = []
    private var positional: [String] = []

    init(_ tokens: [String]) {
        var index = 0
        while index < tokens.count {
            let token = tokens[index]
            if token.hasPrefix("--") {
                if let equals = token.firstIndex(of: "=") {
                    let name = String(token[token.startIndex..<equals])
                    values[name] = String(token[token.index(after: equals)...])
                } else if index + 1 < tokens.count && !tokens[index + 1].hasPrefix("--") {
                    values[token] = tokens[index + 1]
                    index += 1
                } else {
                    flags.insert(token)
                }
            } else {
                positional.append(token)
            }
            index += 1
        }
    }

    func has(_ name: String) -> Bool {
        flags.contains(name) || values[name] != nil
    }

    func optionalString(_ name: String) -> String? {
        values[name]
    }

    func string(_ name: String) throws -> String {
        guard let value = values[name], !value.isEmpty else {
            throw NativeError.badArguments("missing \(name)")
        }
        return value
    }

    func int(_ name: String) throws -> Int {
        guard let value = Int(try string(name)) else {
            throw NativeError.badArguments("\(name) must be an integer")
        }
        return value
    }

    func pid(_ name: String) throws -> Int32 {
        guard let raw = Int(try string(name)), raw >= 0, raw <= Int(Int32.max) else {
            throw NativeError.badArguments("\(name) must be 0 or a positive pid")
        }
        return Int32(raw)
    }

    func int32(_ name: String) throws -> Int32 {
        let value = try int(name)
        guard value > 0 && value <= Int(Int32.max) else {
            throw NativeError.badArguments("\(name) must be a positive pid")
        }
        return Int32(value)
    }

    func double(_ name: String) throws -> Double {
        guard let value = Double(try string(name)), value.isFinite else {
            throw NativeError.badArguments("\(name) must be a number")
        }
        return value
    }
}
