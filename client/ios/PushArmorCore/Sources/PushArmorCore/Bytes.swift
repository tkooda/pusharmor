import Foundation

/// Small byte helpers used across the codec.
public enum Bytes {
    public static func ascii(_ s: String) -> Data { Data(s.utf8) }

    public static func sha256(_ parts: Data...) -> Data {
        var h = SHA256()
        for p in parts { h.update(data: p) }
        return Data(h.finalize())
    }

    public static func hex(_ d: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(d.count * 2)
        for b in d {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Lowercase or uppercase hex to bytes; nil on any other input.
    public static func fromHex(_ s: String) -> Data? {
        let u = Array(s.utf8)
        guard u.count % 2 == 0 else { return nil }
        func v(_ c: UInt8) -> UInt8? {
            switch c {
            case 0x30...0x39: return c - 0x30
            case 0x61...0x66: return c - 0x61 + 10
            case 0x41...0x46: return c - 0x41 + 10
            default: return nil
            }
        }
        var out = Data(capacity: u.count / 2)
        var i = 0
        while i < u.count {
            guard let hi = v(u[i]), let lo = v(u[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    /// Big-endian u16.
    public static func u16(_ v: Int) -> Data { Data([UInt8((v >> 8) & 0xff), UInt8(v & 0xff)]) }

    /// Constant-time-ish equality for short secrets and hashes.
    public static func equal(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var r: UInt8 = 0
        for (x, y) in zip(a, b) { r |= x ^ y }
        return r == 0
    }
}
