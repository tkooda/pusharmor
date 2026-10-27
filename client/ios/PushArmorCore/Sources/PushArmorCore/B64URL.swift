import Foundation

/// Strict, canonical b64url (RFC 4648 URL alphabet, no padding), per catalog Encodings:
/// reject "=", any char outside A-Z a-z 0-9 - _, length mod 4 = 1 and nonzero spare bits.
public enum B64URL {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
    private static let table: [Int8] = {
        var t = [Int8](repeating: -1, count: 256)
        for (i, c) in alphabet.enumerated() { t[Int(c)] = Int8(i) }
        return t
    }()

    public static func encode(_ data: Data) -> String {
        var out = [UInt8]()
        out.reserveCapacity((data.count * 4 + 2) / 3)
        let b = [UInt8](data)
        var i = 0
        while i + 3 <= b.count {
            let v = UInt32(b[i]) << 16 | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2])
            out.append(alphabet[Int(v >> 18 & 63)])
            out.append(alphabet[Int(v >> 12 & 63)])
            out.append(alphabet[Int(v >> 6 & 63)])
            out.append(alphabet[Int(v & 63)])
            i += 3
        }
        let rest = b.count - i
        if rest == 1 {
            let v = UInt32(b[i]) << 16
            out.append(alphabet[Int(v >> 18 & 63)])
            out.append(alphabet[Int(v >> 12 & 63)])
        } else if rest == 2 {
            let v = UInt32(b[i]) << 16 | UInt32(b[i + 1]) << 8
            out.append(alphabet[Int(v >> 18 & 63)])
            out.append(alphabet[Int(v >> 12 & 63)])
            out.append(alphabet[Int(v >> 6 & 63)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Number of b64url chars for n bytes (no padding).
    public static func encodedLength(_ n: Int) -> Int { (n * 4 + 2) / 3 }

    /// Strict decode; nil on any non-canonical input.
    public static func decode(_ s: String) -> Data? { decode(Array(s.utf8)) }

    public static func decode(_ c: [UInt8]) -> Data? {
        if c.count % 4 == 1 { return nil }
        var out = Data(capacity: c.count * 3 / 4)
        var acc: UInt32 = 0
        var bits = 0
        for ch in c {
            let v = table[Int(ch)]
            if v < 0 { return nil }
            acc = acc << 6 | UInt32(v)
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8(acc >> UInt32(bits) & 0xff))
            }
        }
        // spare bits must be zero
        if bits > 0 && (acc & ((1 << UInt32(bits)) - 1)) != 0 { return nil }
        return out
    }

    /// True if s is strict b64url (used on "m" before anything else).
    public static func isStrict(_ s: String) -> Bool { decode(s) != nil }
}
