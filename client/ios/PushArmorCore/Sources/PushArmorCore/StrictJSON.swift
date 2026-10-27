import Foundation

/// A strict JSON reader that keeps number tokens raw and rejects duplicate keys
/// (catalog Encodings: n is checked on the raw token; a duplicate key drops).
public indirect enum JSONValue: Equatable, Sendable {
    case object([(String, JSONValue)])
    case array([JSONValue])
    case string(String)
    case number(String)   // raw token as sent
    case bool(Bool)
    case null

    public static func == (a: JSONValue, b: JSONValue) -> Bool {
        switch (a, b) {
        case (.object(let x), .object(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        case (.array(let x), .array(let y)): return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.number(let x), .number(let y)): return x == y
        case (.bool(let x), .bool(let y)): return x == y
        case (.null, .null): return true
        default: return false
        }
    }

    public var objectMembers: [(String, JSONValue)]? {
        if case .object(let m) = self { return m }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        objectMembers?.first(where: { $0.0 == key })?.1
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// A JSON integer in 1 ... 2^53 - 1 whose raw token matches ^[1-9][0-9]*$.
    public var counterValue: UInt64? {
        guard case .number(let t) = self else { return nil }
        return Counter.parse(t)
    }
}

public enum Counter {
    public static let max: UInt64 = (1 << 53) - 1

    /// Parse a raw token per catalog Encodings; nil if not a valid counter.
    public static func parse(_ t: String) -> UInt64? {
        let u = Array(t.utf8)
        guard let f = u.first, f >= 0x31 && f <= 0x39, u.count <= 16,
              u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let v = UInt64(t), v <= max else { return nil }
        return v
    }
}

public enum StrictJSON {
    public enum Failure: Error { case syntax, duplicateKey, depth, encoding }

    public static func parse(_ data: Data) throws -> JSONValue {
        var p = Parser(bytes: [UInt8](data))
        p.skipWS()
        let v = try p.value(depth: 0)
        p.skipWS()
        guard p.i == p.b.count else { throw Failure.syntax }
        return v
    }

    private struct Parser {
        let b: [UInt8]
        var i = 0
        init(bytes: [UInt8]) { b = bytes }

        mutating func skipWS() {
            while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0a || b[i] == 0x0d { i += 1 }
        }

        mutating func expect(_ s: String) throws {
            for c in s.utf8 {
                guard i < b.count, b[i] == c else { throw Failure.syntax }
                i += 1
            }
        }

        mutating func value(depth: Int) throws -> JSONValue {
            guard depth < 32 else { throw Failure.depth }
            guard i < b.count else { throw Failure.syntax }
            switch b[i] {
            case 0x7b: return try object(depth: depth)
            case 0x5b: return try array(depth: depth)
            case 0x22: return .string(try string())
            case 0x74: try expect("true"); return .bool(true)
            case 0x66: try expect("false"); return .bool(false)
            case 0x6e: try expect("null"); return .null
            default: return .number(try number())
            }
        }

        mutating func object(depth: Int) throws -> JSONValue {
            i += 1
            var members: [(String, JSONValue)] = []
            var seen = Set<String>()
            skipWS()
            if i < b.count, b[i] == 0x7d { i += 1; return .object(members) }
            while true {
                skipWS()
                guard i < b.count, b[i] == 0x22 else { throw Failure.syntax }
                let k = try string()
                guard seen.insert(k).inserted else { throw Failure.duplicateKey }
                skipWS()
                try expect(":")
                skipWS()
                members.append((k, try value(depth: depth + 1)))
                skipWS()
                guard i < b.count else { throw Failure.syntax }
                if b[i] == 0x2c { i += 1; continue }
                if b[i] == 0x7d { i += 1; return .object(members) }
                throw Failure.syntax
            }
        }

        mutating func array(depth: Int) throws -> JSONValue {
            i += 1
            var items: [JSONValue] = []
            skipWS()
            if i < b.count, b[i] == 0x5d { i += 1; return .array(items) }
            while true {
                skipWS()
                items.append(try value(depth: depth + 1))
                skipWS()
                guard i < b.count else { throw Failure.syntax }
                if b[i] == 0x2c { i += 1; continue }
                if b[i] == 0x5d { i += 1; return .array(items) }
                throw Failure.syntax
            }
        }

        mutating func number() throws -> String {
            let start = i
            if i < b.count, b[i] == 0x2d { i += 1 }
            guard i < b.count else { throw Failure.syntax }
            if b[i] == 0x30 {
                i += 1
            } else if b[i] >= 0x31 && b[i] <= 0x39 {
                while i < b.count, b[i] >= 0x30 && b[i] <= 0x39 { i += 1 }
            } else {
                throw Failure.syntax
            }
            if i < b.count, b[i] == 0x2e {
                i += 1
                let s = i
                while i < b.count, b[i] >= 0x30 && b[i] <= 0x39 { i += 1 }
                guard i > s else { throw Failure.syntax }
            }
            if i < b.count, b[i] == 0x65 || b[i] == 0x45 {
                i += 1
                if i < b.count, b[i] == 0x2b || b[i] == 0x2d { i += 1 }
                let s = i
                while i < b.count, b[i] >= 0x30 && b[i] <= 0x39 { i += 1 }
                guard i > s else { throw Failure.syntax }
            }
            return String(decoding: b[start ..< i], as: UTF8.self)
        }

        mutating func hex4() throws -> UInt32 {
            guard i + 4 <= b.count else { throw Failure.syntax }
            var v: UInt32 = 0
            for _ in 0 ..< 4 {
                let c = b[i]
                let d: UInt32
                switch c {
                case 0x30...0x39: d = UInt32(c - 0x30)
                case 0x61...0x66: d = UInt32(c - 0x61 + 10)
                case 0x41...0x46: d = UInt32(c - 0x41 + 10)
                default: throw Failure.syntax
                }
                v = v << 4 | d
                i += 1
            }
            return v
        }

        mutating func string() throws -> String {
            i += 1
            var out = [UInt8]()
            while true {
                guard i < b.count else { throw Failure.syntax }
                let c = b[i]
                if c == 0x22 { i += 1; break }
                if c < 0x20 { throw Failure.syntax }
                if c != 0x5c { out.append(c); i += 1; continue }
                i += 1
                guard i < b.count else { throw Failure.syntax }
                let e = b[i]
                i += 1
                switch e {
                case 0x22: out.append(0x22)
                case 0x5c: out.append(0x5c)
                case 0x2f: out.append(0x2f)
                case 0x62: out.append(0x08)
                case 0x66: out.append(0x0c)
                case 0x6e: out.append(0x0a)
                case 0x72: out.append(0x0d)
                case 0x74: out.append(0x09)
                case 0x75:
                    var u = try hex4()
                    if u >= 0xd800 && u <= 0xdbff {
                        try expect("\\u")
                        let lo = try hex4()
                        guard lo >= 0xdc00 && lo <= 0xdfff else { throw Failure.encoding }
                        u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00)
                    } else if u >= 0xdc00 && u <= 0xdfff {
                        throw Failure.encoding
                    }
                    out.append(contentsOf: Array(String(Character(Unicode.Scalar(u)!)).utf8))
                default: throw Failure.syntax
                }
            }
            // reject invalid UTF-8
            guard let s = String(validatingUTF8CString: out) else { throw Failure.encoding }
            return s
        }
    }

    /// JSON string literal (quotes included) with minimal escapes.
    public static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }
}

private extension String {
    /// Validating UTF-8 decode of raw bytes (no NUL handling needed: a NUL can only
    /// come from \u0000, which stays a valid scalar).
    init?(validatingUTF8CString bytes: [UInt8]) {
        var it = bytes.makeIterator()
        var dec = UTF8()
        var s = ""
        loop: while true {
            switch dec.decode(&it) {
            case .scalarValue(let v): s.unicodeScalars.append(v)
            case .emptyInput: break loop
            case .error: return nil
            }
        }
        self = s
    }
}
