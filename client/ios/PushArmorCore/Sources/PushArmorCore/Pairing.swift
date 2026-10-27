import Foundation

/// Crockford base32 alphabet used by the pairing fingerprint and the email code.
public enum Crockford {
    public static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// First `chars` 5-bit groups of `data`, MSB first.
    public static func encodePrefix(_ data: Data, chars: Int) -> String {
        let b = [UInt8](data)
        var out = ""
        for i in 0 ..< chars {
            var v = 0
            for j in 0 ..< 5 {
                let bit = i * 5 + j
                v = v << 1 | Int(b[bit / 8] >> (7 - UInt8(bit % 8)) & 1)
            }
            out.append(alphabet[v])
        }
        return out
    }
}

/// Pairing crypto (catalog Pairing fingerprint, Pairing, Pairing flow).
public enum PairingCrypto {
    public static let rLength = 32

    /// 32 bytes from the OS CSPRNG.
    public static func randomR() -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0 ..< rLength).map { _ in UInt8.random(in: 0 ... 255, using: &g) })
    }

    /// c_N = sha256("PA-SAS1C\n" || sign_pub_N || enc_pub_N || r_N)
    public static func commit(signPubN: Data, encPubN: Data, rN: Data) -> Data {
        Bytes.sha256(Bytes.ascii("PA-SAS1C\n"), signPubN, encPubN, rN)
    }

    /// 4 Crockford chars from the first 20 bits of
    /// sha256("PA-SAS1\n" || sign_pub_N || enc_pub_N || sign_pub_X || enc_pub_X || r_N || r_X)
    public static func fingerprint(signPubN: Data, encPubN: Data, signPubX: Data, encPubX: Data,
                                   rN: Data, rX: Data) -> String {
        let h = Bytes.sha256(Bytes.ascii("PA-SAS1\n"), signPubN, encPubN, signPubX, encPubX, rN, rX)
        return Crockford.encodePrefix(h, chars: 4)
    }

    /// pairing id = first 8 bytes of sha256("PA-PAIRID1\n" || r_N || r_X)
    public static func pairingId(rN: Data, rX: Data) -> Data {
        Bytes.sha256(Bytes.ascii("PA-PAIRID1\n"), rN, rX).prefix(8)
    }

    /// pk = b64url(first 16 bytes of sha256("PA-PAIRKEY1\n" || N id || X id)), 22 chars.
    public static func pairingKey(nId: PeerId, xId: PeerId) -> String {
        B64URL.encode(Bytes.sha256(Bytes.ascii("PA-PAIRKEY1\n"), nId.raw, xId.raw).prefix(16))
    }
}

/// Pair message (catalog Pairing): b64url(enc || ct+tag), HPKE info "PA-PAIR1",
/// aad = recipient id; plaintext 193 bytes = kind(1) || from id(30) || body(162).
public enum PairMessage {
    public enum Kind: UInt8, Sendable { case commit = 1, reply = 2, open = 3 }
    public static let info = Bytes.ascii("PA-PAIR1")
    public static let plaintextLength = 193
    public static let wireLength = 366

    public enum Body: Equatable, Sendable {
        case commit(cN: Data)
        case reply(signPub: Data, encPub: Data, r: Data)
        case open(signPub: Data, encPub: Data, r: Data)

        public var kind: Kind {
            switch self {
            case .commit: return .commit
            case .reply: return .reply
            case .open: return .open
            }
        }
    }

    public struct Parsed: Equatable, Sendable {
        public let from: PeerId
        public let body: Body
    }

    public static func plaintext(from: PeerId, body: Body) -> Data {
        var p = Data([body.kind.rawValue])
        p += from.raw
        switch body {
        case .commit(let c):
            p += c
            p += Data(count: 130)
        case .reply(let s, let e, let r), .open(let s, let e, let r):
            p += s
            p += e
            p += r
        }
        precondition(p.count == plaintextLength)
        return p
    }

    public static func seal(from: PeerId, to: PeerId, recipientEncPub: Data, body: Body) throws -> String {
        let wire = try HPKEWire.seal(plaintext(from: from, body: body), to: recipientEncPub,
                                     info: info, aad: Bytes.ascii(to.text))
        return B64URL.encode(wire)
    }

    public enum ParseError: Error { case length, kind, padding, fromAccount, keys }

    /// Parse and check an opened plaintext. `me` gives the account check.
    /// Reply and open keys must hash to the from id and sign_pub != enc_pub.
    public static func parse(_ p: Data, me: PeerId) throws -> Parsed {
        let b = [UInt8](p)
        guard b.count == plaintextLength else { throw ParseError.length }
        guard let kind = Kind(rawValue: b[0]) else { throw ParseError.kind }
        guard let from = PeerId(raw: Data(b[1 ..< 31])) else { throw ParseError.length }
        guard from.sameAccount(as: me) else { throw ParseError.fromAccount }
        let body = Data(b[31...])
        switch kind {
        case .commit:
            guard body.suffix(130).allSatisfy({ $0 == 0 }) else { throw ParseError.padding }
            return Parsed(from: from, body: .commit(cN: body.prefix(32)))
        case .reply, .open:
            let s = Data(body.prefix(65)), e = Data(body.dropFirst(65).prefix(65)), r = Data(body.suffix(32))
            guard PublicKeys.validPair(signPub: s, encPub: e), from.matches(signPub: s, encPub: e) else {
                throw ParseError.keys
            }
            return Parsed(from: from, body: kind == .reply ? .reply(signPub: s, encPub: e, r: r)
                                                          : .open(signPub: s, encPub: e, r: r))
        }
    }

    /// Open a received "m" that is exactly 366 chars. Throws on any failure.
    public static func open(_ m: String, me: PeerId, key: PADecryptor) throws -> Parsed {
        guard m.utf8.count == wireLength, let wire = B64URL.decode(m) else { throw ParseError.length }
        let p = try key.hpkeOpen(wire: wire, info: info, aad: Bytes.ascii(me.text))
        return try parse(p, me: me)
    }
}
