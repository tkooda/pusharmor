import Foundation

/// Per-sender anti-replay window (catalog Replay window): highest accepted n (h) and a
/// 100-bit bitmap where bit k marks n = h - k. Stored as a 13-byte BLOB, bit k in byte k / 8,
/// mask 1 << (k % 8).
public struct ReplayWindow: Equatable, Sendable {
    public static let size: UInt64 = 100
    public static let blobLength = 13

    public private(set) var h: UInt64
    public private(set) var bitmap: [UInt8]

    /// Fresh state when a pairing pins the sender: h = 0, bitmap clear.
    public init() {
        h = 0
        bitmap = [UInt8](repeating: 0, count: ReplayWindow.blobLength)
    }

    public init?(h: UInt64, blob: Data) {
        guard blob.count == ReplayWindow.blobLength else { return nil }
        self.h = h
        self.bitmap = [UInt8](blob)
    }

    public var blob: Data { Data(bitmap) }

    /// From h and the seen n values (tests and debugging).
    public init(h: UInt64, seen: [UInt64]) {
        self.init()
        self.h = h
        for n in seen where n <= h && h - n < ReplayWindow.size { setBit(h - n) }
    }

    /// The seen n values, high to low.
    public var seen: [UInt64] {
        (0 ..< min(ReplayWindow.size, h)).filter { bit($0) }.map { h - $0 }
    }

    /// Replay decision (catalog Replay window): accept; a rejected n <= h - 100 is invalid; a
    /// seen n of a control type is a no-op; a seen n of url/text/tel with a History row is
    /// re-presented; else invalid.
    public enum Outcome: String, Sendable { case accept, invalid, represent, noop }

    public func outcome(_ n: UInt64, control: Bool, hasHistory: Bool) -> Outcome {
        switch check(n) {
        case .accept: return .accept
        case .tooOld: return .invalid
        case .seen: return control ? .noop : (hasHistory ? .represent : .invalid)
        }
    }

    public enum Verdict: Equatable, Sendable {
        case accept
        case seen      // bit set (a duplicate or a replay)
        case tooOld    // n <= h - 100
    }

    private func bit(_ k: UInt64) -> Bool { bitmap[Int(k / 8)] & (1 << UInt8(k % 8)) != 0 }
    private mutating func setBit(_ k: UInt64) { bitmap[Int(k / 8)] |= 1 << UInt8(k % 8) }

    /// Accept iff n > h - 100 and the bit for n is not set.
    public func check(_ n: UInt64) -> Verdict {
        if n > h { return .accept }
        let k = h - n
        if k >= ReplayWindow.size { return .tooOld }
        return bit(k) ? .seen : .accept
    }

    /// Apply an accepted n: if n > h shift left by n - h, set h = n, set bit 0; else set bit h - n.
    public mutating func accept(_ n: UInt64) {
        precondition(check(n) == .accept)
        if n > h {
            let shift = n - h
            if shift >= ReplayWindow.size {
                bitmap = [UInt8](repeating: 0, count: ReplayWindow.blobLength)
            } else {
                var nb = [UInt8](repeating: 0, count: ReplayWindow.blobLength)
                for k in 0 ..< ReplayWindow.size - shift where bit(k) {
                    let t = k + shift
                    nb[Int(t / 8)] |= 1 << UInt8(t % 8)
                }
                bitmap = nb
            }
            h = n
            setBit(0)
        } else {
            setBit(h - n)
        }
    }
}
