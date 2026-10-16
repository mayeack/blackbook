import Foundation

/// Minimal ordered JSON value used for every collector response.
///
/// Keys keep insertion order (stable golden files) and `nil` is written as an explicit
/// `null`, so nullable fields are always present on the wire, as the zod contract expects.
enum JSON: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSON])
    case object([(String, JSON)])

    static func == (lhs: JSON, rhs: JSON) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case let (.bool(a), .bool(b)): return a == b
        case let (.int(a), .int(b)): return a == b
        case let (.double(a), .double(b)): return a == b
        case let (.string(a), .string(b)): return a == b
        case let (.array(a), .array(b)): return a == b
        case let (.object(a), .object(b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }

    // MARK: Convenience constructors

    static func str(_ value: String?) -> JSON { value.map(JSON.string) ?? .null }
    static func num(_ value: Int) -> JSON { .int(Int64(value)) }
    static func num(_ value: Int64?) -> JSON { value.map { .int($0) } ?? .null }
    static func iso(_ date: Date?) -> JSON { date.map { .string(ISOTime.format($0)) } ?? .null }

    subscript(key: String) -> JSON? {
        guard case let .object(pairs) = self else { return nil }
        return pairs.first(where: { $0.0 == key })?.1
    }

    // MARK: Serialization

    func serialized(pretty: Bool = false) -> Data {
        var out = ""
        write(into: &out, pretty: pretty, indent: 0)
        if pretty { out += "\n" }
        return Data(out.utf8)
    }

    var compactString: String { String(decoding: serialized(), as: UTF8.self) }

    private func write(into out: inout String, pretty: Bool, indent: Int) {
        switch self {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .int(i): out += String(i)
        case let .double(d):
            out += d.isFinite ? String(d) : "null"
        case let .string(s): JSON.writeString(s, into: &out)
        case let .array(items):
            if items.isEmpty { out += "[]"; return }
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                if pretty { out += "\n" + String(repeating: "  ", count: indent + 1) }
                item.write(into: &out, pretty: pretty, indent: indent + 1)
            }
            if pretty { out += "\n" + String(repeating: "  ", count: indent) }
            out += "]"
        case let .object(pairs):
            if pairs.isEmpty { out += "{}"; return }
            out += "{"
            for (i, pair) in pairs.enumerated() {
                if i > 0 { out += "," }
                if pretty { out += "\n" + String(repeating: "  ", count: indent + 1) }
                JSON.writeString(pair.0, into: &out)
                out += pretty ? ": " : ":"
                pair.1.write(into: &out, pretty: pretty, indent: indent + 1)
            }
            if pretty { out += "\n" + String(repeating: "  ", count: indent) }
            out += "}"
        }
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

/// Typed accessors over a decoded JSON request body (`JSONSerialization` output).
struct JSONBody {
    let fields: [String: Any]

    /// Parses a request body that must be a JSON object. Empty bodies become `{}`.
    static func parse(_ data: Data) -> JSONBody? {
        if data.isEmpty { return JSONBody(fields: [:]) }
        guard let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any] else { return nil }
        return JSONBody(fields: dict)
    }

    func string(_ key: String) -> String? { fields[key] as? String }

    /// Integers only: rejects booleans and fractional numbers that NSNumber would coerce.
    func int(_ key: String) -> Int? {
        guard let n = fields[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.rounded() == d, abs(d) < 1e15 else { return nil }
        return n.intValue
    }

    func bool(_ key: String) -> Bool? {
        guard let n = fields[key] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    func has(_ key: String) -> Bool { fields[key] != nil && !(fields[key] is NSNull) }
}
