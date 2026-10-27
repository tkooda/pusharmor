import Foundation

/// A peer id: 30 raw bytes = account(9) || keyhash(12) || mac(9); 40 b64url chars on the wire.
public struct PeerId: Hashable, Comparable, CustomStringConvertible, Sendable {
    public static let rawLength = 30
    public static let textLength = 40
    public let raw: Data
    public let text: String

    public init?(text: String) {
        guard text.utf8.count == PeerId.textLength, let r = B64URL.decode(text), r.count == PeerId.rawLength else {
            return nil
        }
        self.raw = r
        self.text = text
    }

    public init?(raw: Data) {
        guard raw.count == PeerId.rawLength else { return nil }
        self.raw = Data(raw)
        self.text = B64URL.encode(raw)
    }

    public var account: Data { raw.subdata(in: raw.startIndex ..< raw.startIndex + 9) }
    public var keyhash: Data { raw.subdata(in: raw.startIndex + 9 ..< raw.startIndex + 21) }
    public var description: String { text }

    /// Same account(9) prefix (catalog IDs: mismatch = drop).
    public func sameAccount(as other: PeerId) -> Bool { account == other.account }

    /// The keys hash to this id's keyhash.
    public func matches(signPub: Data, encPub: Data) -> Bool {
        Ids.keyhash(signPub: signPub, encPub: encPub) == keyhash
    }

    /// Unsigned lexicographic compare of the 30 raw bytes (I232).
    public static func < (a: PeerId, b: PeerId) -> Bool { Ids.idLess(a.raw, b.raw) }
}

public enum Ids {
    /// keyhash = sha256("PA-ID1\n" || sign_pub || enc_pub)[0..12]
    public static func keyhash(signPub: Data, encPub: Data) -> Data {
        Bytes.sha256(Bytes.ascii("PA-ID1\n"), signPub, encPub).prefix(12)
    }

    /// Unsigned lexicographic compare of raw bytes; true if a < b.
    public static func idLess(_ a: Data, _ b: Data) -> Bool {
        let x = [UInt8](a), y = [UInt8](b)
        for i in 0 ..< min(x.count, y.count) where x[i] != y[i] {
            return x[i] < y[i]
        }
        return x.count < y.count
    }

    /// Email normalization (catalog Auth): trim, ASCII lowercase only; nil if any byte is
    /// outside ASCII.
    public static func normalizeEmail(_ email: String) -> String? {
        let u = Array(email.utf8)
        if u.contains(where: { $0 > 0x7f }) { return nil }
        func ws(_ c: UInt8) -> Bool { c == 0x20 || (c >= 0x09 && c <= 0x0d) }
        var lo = 0, hi = u.count
        while lo < hi && ws(u[lo]) { lo += 1 }
        while hi > lo && ws(u[hi - 1]) { hi -= 1 }
        let lower = u[lo ..< hi].map { ($0 >= 0x41 && $0 <= 0x5a) ? $0 + 0x20 : $0 }
        return String(decoding: lower, as: UTF8.self)
    }

    /// email_hash = sha256("PA-ACCT1\n" || normalized email)
    public static func emailHash(normalized: String) -> Data {
        Bytes.sha256(Bytes.ascii("PA-ACCT1\n"), Bytes.ascii(normalized))
    }

    /// k = b64url(sha256(sign_pub)) (OAuth and auth query parameter).
    public static func k(signPub: Data) -> String { B64URL.encode(Bytes.sha256(signPub)) }

    /// OAuth nonce = b64url(sha256("PA-NONCE1\n" + purpose + "\n" + k)).
    public static func oauthNonce(purpose: String, signPub: Data) -> String {
        B64URL.encode(Bytes.sha256(Bytes.ascii("PA-NONCE1\n" + purpose + "\n" + k(signPub: signPub))))
    }

    /// my_push_sha256 = b64url(first 16 bytes of sha256(push string)).
    public static func pushSha256(_ push: PushInfo) -> String {
        B64URL.encode(Bytes.sha256(Data(push.hashString.utf8)).prefix(16))
    }
}

/// The APNs push registration of this device.
public struct PushInfo: Equatable, Sendable {
    public enum Kind: String, Sendable { case apns, apnsSandbox = "apns-sandbox" }
    public let type: Kind
    public let token: String   // lowercase hex

    public init(type: Kind, token: String) {
        self.type = type
        self.token = token
    }

    public init(type: Kind, tokenBytes: Data) {
        self.init(type: type, token: Bytes.hex(tokenBytes))
    }

    /// fcm, apns: type + "\n" + token
    public var hashString: String { type.rawValue + "\n" + token }

    /// {"type": .., "token": ..}
    public var json: [String: String] { ["type": type.rawValue, "token": token] }
}

/// Public key checks (catalog Encodings).
public enum PublicKeys {
    /// A 65-byte uncompressed SEC1 point on P-256.
    public static func isValid(_ k: Data) -> Bool {
        guard k.count == 65, k.first == 0x04 else { return false }
        return (try? P256.Signing.PublicKey(x963Representation: k)) != nil
    }

    /// Both keys valid and sign_pub != enc_pub.
    public static func validPair(signPub: Data, encPub: Data) -> Bool {
        isValid(signPub) && isValid(encPub) && signPub != encPub
    }
}
