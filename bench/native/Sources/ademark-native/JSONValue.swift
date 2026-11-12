import Foundation

enum JSONValue {
    case object([(String, JSONValue)])
    case array([JSONValue])
    case string(String)
    case int(Int64)
    case uint(UInt64)
    case double(Double)
    case bool(Bool)
    case null

    func serialized() -> String {
        switch self {
        case .object(let fields):
            let body = fields.map { "\(JSONValue.string($0.0).serialized()):\($0.1.serialized())" }
            return "{" + body.joined(separator: ",") + "}"
        case .array(let items):
            return "[" + items.map { $0.serialized() }.joined(separator: ",") + "]"
        case .string(let value):
            return JSONValue.quote(value)
        case .int(let value):
            return String(value)
        case .uint(let value):
            return String(value)
        case .double(let value):
            return JSONValue.format(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .null:
            return "null"
        }
    }

    private static func quote(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    private static func format(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        if value == value.rounded() && abs(value) < 9e15 {
            return String(Int64(value))
        }
        var text = String(format: "%.3f", value)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }
}

func emit(_ value: JSONValue) {
    print(value.serialized())
}
