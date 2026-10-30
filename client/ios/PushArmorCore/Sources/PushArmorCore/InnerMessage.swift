import Foundation

/// The signed name field carried by approve, rename and name entries:
/// {"name": "$b64url-of-name", "n": $counter-n, "s": "$signature"}.
public struct NameField: Equatable, Sendable {
    public let name: String   // b64url of the name, as sent
    public let n: UInt64
    public let s: String      // b64url of the 64-byte signature, as sent

    public init(name: String, n: UInt64, s: String) {
        self.name = name
        self.n = n
        self.s = s
    }

    public var json: String {
        "{\"name\":" + StrictJSON.quote(name) + ",\"n\":" + String(n) + ",\"s\":" + StrictJSON.quote(s) + "}"
    }

    /// Exactly the keys name, n, s with the right types.
    public static func from(_ v: JSONValue) -> NameField? {
        guard let m = v.objectMembers, m.count == 3,
              let name = v["name"]?.stringValue, let n = v["n"]?.counterValue,
              let s = v["s"]?.stringValue else { return nil }
        return NameField(name: name, n: n, s: s)
    }
}

/// One inner message type (catalog Inner message JSON).
public enum MessageContent: Equatable, Sendable {
    case url(String)
    case text(String)
    case tel(String)
    case approve(NameField)
    case deny
    case remove(String)
    case rename(NameField)
    case delete
    case logout
    case login

    public var typeKey: String {
        switch self {
        case .url: return "url"
        case .text: return "text"
        case .tel: return "tel"
        case .approve: return "approve"
        case .deny: return "deny"
        case .remove: return "remove"
        case .rename: return "rename"
        case .delete: return "delete"
        case .logout: return "logout"
        case .login: return "login"
        }
    }

    /// url, text, tel: the types that write a History row.
    public var isContent: Bool {
        switch self {
        case .url, .text, .tel: return true
        default: return false
        }
    }

    var valueJSON: String {
        switch self {
        case .url(let s), .text(let s), .tel(let s), .remove(let s): return StrictJSON.quote(s)
        case .approve(let f), .rename(let f): return f.json
        case .deny, .delete, .logout, .login: return "1"
        }
    }
}

/// Inner message JSON {"n": .., one type key}.
public struct InnerJSON: Equatable, Sendable {
    public static let contentCap = 2048
    public let n: UInt64
    public let content: MessageContent

    public init(n: UInt64, content: MessageContent) {
        self.n = n
        self.content = content
    }

    public func encode() -> Data {
        Data(("{\"n\":" + String(n) + "," + StrictJSON.quote(content.typeKey) + ":" + content.valueJSON + "}").utf8)
    }

    public enum Failure: Error { case json, shape, counter, value, tooLong }

    /// Strict parse: n plus exactly one type key, no unknown keys, n a JSON integer
    /// in 1 ... 2^53 - 1 on the raw token, no duplicate keys, content <= 2048 bytes.
    public static func parse(_ data: Data) throws -> InnerJSON {
        guard let v = try? StrictJSON.parse(data), let m = v.objectMembers else { throw Failure.json }
        guard m.count == 2, let nv = v["n"] else { throw Failure.shape }
        guard let n = nv.counterValue else { throw Failure.counter }
        guard let (key, val) = m.first(where: { $0.0 != "n" }) else { throw Failure.shape }
        let c: MessageContent
        func str() throws -> String {
            guard let s = val.stringValue else { throw Failure.value }
            return s
        }
        func one() throws {
            guard case .number("1") = val else { throw Failure.value }
        }
        switch key {
        case "url": c = .url(try str())
        case "text": c = .text(try str())
        case "tel": c = .tel(try str())
        case "remove":
            let id = try str()
            guard PeerId(text: id) != nil else { throw Failure.value }   // at parse, before the replay window (I320)
            c = .remove(id)
        case "approve", "rename":
            guard let f = NameField.from(val) else { throw Failure.value }
            c = key == "approve" ? .approve(f) : .rename(f)
        case "deny": try one(); c = .deny
        case "delete": try one(); c = .delete
        case "logout": try one(); c = .logout
        case "login": try one(); c = .login
        default: throw Failure.shape
        }
        switch c {
        case .url(let s), .text(let s), .tel(let s):
            if s.utf8.count > contentCap { throw Failure.tooLong }
        default: break
        }
        return InnerJSON(n: n, content: c)
    }
}

/// Envelope of an inner message (catalog Inner message, Size cap).
public enum InnerMessage {
    public static let info = Bytes.ascii("PA-MSG1")
    public static let buckets = [512, 1024, 2048, 3800]
    public static let maxWire = 3800
    static let overhead = HPKEWire.encLength + HPKEWire.tagLength   // 81

    public enum Failure: Error { case tooLarge, short, keysFlag, length, padding, keys }

    /// "PA-MSG1\n" + recipient id + "\n" + every plaintext byte after sig.
    public static func signedBytes(recipient: PeerId, tail: Data) -> Data {
        Bytes.ascii("PA-MSG1\n" + recipient.text + "\n") + tail
    }

    /// The bucket for an unpadded wire length, nil = the sender refuses (> 3800).
    public static func bucket(unpaddedChars: Int) -> Int? { buckets.first { $0 >= unpaddedChars } }

    /// The plaintext length a message of `minPlaintext` bytes is padded to.
    public static func paddedPlaintextLength(minPlaintext: Int, approve: Bool) throws -> Int {
        let need = B64URL.encodedLength(overhead + minPlaintext)
        for b in buckets where b >= need && (!approve || b >= 1024) {
            return b * 3 / 4 - overhead
        }
        throw Failure.tooLarge
    }

    /// Body = from id || pairing id || keys flag [|| keys] || u16 len || deflated, padded with
    /// zeros to the bucket. Returns the padded body (the part covered by the signature).
    public static func paddedBody(from: PeerId, pairingId: Data, keys: (Data, Data)?, deflated: Data,
                                  approve: Bool) throws -> Data {
        precondition(pairingId.count == 8)
        var body = from.raw + pairingId
        if let (s, e) = keys {
            body.append(1)
            body += s
            body += e
        } else {
            body.append(0)
        }
        guard deflated.count <= 0xffff else { throw Failure.tooLarge }
        body += Bytes.u16(deflated.count)
        body += deflated
        let total = try paddedPlaintextLength(minPlaintext: 64 + body.count, approve: approve)
        body += Data(count: total - 64 - body.count)
        return body
    }

    /// Build, pad, sign and seal one message to one recipient. Returns the b64url wire string.
    public static func seal(_ json: InnerJSON, signer: PASigner, from: PeerId, to: PeerId, toEncPub: Data,
                            pairingId: Data, keys: (Data, Data)?) throws -> String {
        let deflated = try Deflate.deflateRaw(json.encode())
        var approve = false
        if case .approve = json.content { approve = true }
        let body = try paddedBody(from: from, pairingId: pairingId, keys: keys, deflated: deflated, approve: approve)
        let sig = try signer.sign(signedBytes(recipient: to, tail: body))
        let wire = try HPKEWire.seal(sig + body, to: toEncPub, info: info, aad: Bytes.ascii(to.text))
        let m = B64URL.encode(wire)
        guard m.utf8.count <= maxWire else { throw Failure.tooLarge }
        return m
    }

    /// The split plaintext; nothing is verified yet.
    public struct Split: Sendable {
        public let sig: Data
        public let tail: Data          // every byte after sig (signed)
        public let from: PeerId
        public let pairingId: Data
        public let keys: (signPub: Data, encPub: Data)?
        public let deflated: Data
    }

    /// Split sig || from id || pairing id || keys flag [+ keys] || u16 len || deflated || padding.
    /// Checks the padding bytes are zero and the length fits.
    public static func split(_ p: Data) throws -> Split {
        let b = [UInt8](p)
        var i = 64 + 30 + 8 + 1
        guard b.count >= i + 2 else { throw Failure.short }
        let from = PeerId(raw: Data(b[64 ..< 94]))!
        let pid = Data(b[94 ..< 102])
        var keys: (Data, Data)? = nil
        switch b[102] {
        case 0: break
        case 1:
            guard b.count >= i + 130 + 2 else { throw Failure.short }
            keys = (Data(b[i ..< i + 65]), Data(b[i + 65 ..< i + 130]))
            i += 130
        default: throw Failure.keysFlag
        }
        let len = Int(b[i]) << 8 | Int(b[i + 1])
        i += 2
        guard b.count >= i + len else { throw Failure.length }
        let deflated = Data(b[i ..< i + len])
        guard b[(i + len)...].allSatisfy({ $0 == 0 }) else { throw Failure.padding }
        return Split(sig: Data(b[0 ..< 64]), tail: Data(b[64...]), from: from, pairingId: pid,
                     keys: keys.map { (signPub: $0.0, encPub: $0.1) }, deflated: deflated)
    }

    /// HPKE open of a received "m" (strict b64url, <= 3800 chars).
    public static func open(_ m: String, me: PeerId, key: PADecryptor) throws -> Data {
        guard m.utf8.count <= maxWire, let wire = B64URL.decode(m) else { throw Failure.short }
        return try key.hpkeOpen(wire: wire, info: info, aad: Bytes.ascii(me.text))
    }
}

/// Name entries (catalog Name entries).
public enum NameEntry {
    public static let info = Bytes.ascii("PA-NAME1")
    public static let maxWire = 1024

    /// 1..32 printable ASCII, no double quote.
    public static func isValidName(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return (1 ... 32).contains(u.count) && u.allSatisfy { $0 >= 0x20 && $0 <= 0x7e && $0 != 0x22 }
    }

    /// "PA-NAME1\n" + owner id + "\n" + recipient id + "\n" + pairing id + "\n" + n + "\n" + name
    public static func signedBytes(owner: PeerId, recipient: PeerId, pairingId: Data, n: UInt64, nameB64: String) -> Data {
        Bytes.ascii("PA-NAME1\n" + owner.text + "\n" + recipient.text + "\n" + B64URL.encode(pairingId)
                    + "\n" + String(n) + "\n" + nameB64)
    }

    public static func make(name: String, n: UInt64, owner: PeerId, recipient: PeerId, pairingId: Data,
                            signer: PASigner) throws -> NameField {
        let nb = B64URL.encode(Data(name.utf8))
        let sig = try signer.sign(signedBytes(owner: owner, recipient: recipient, pairingId: pairingId, n: n, nameB64: nb))
        return NameField(name: nb, n: n, s: B64URL.encode(sig))
    }

    /// Verify a name field from `owner` (its pinned sign_pub); returns the decoded name.
    public static func verify(_ f: NameField, owner: PeerId, recipient: PeerId, pairingId: Data,
                              ownerSignPub: Data) -> String? {
        guard let sig = B64URL.decode(f.s), sig.count == 64,
              Signatures.verify(sig, data: signedBytes(owner: owner, recipient: recipient, pairingId: pairingId,
                                                     n: f.n, nameB64: f.name), publicKey: ownerSignPub),
              let raw = B64URL.decode(f.name) else { return nil }
        let name = String(decoding: raw, as: UTF8.self)
        return isValidName(name) && Data(name.utf8) == raw ? name : nil
    }

    /// b64url(enc || ct+tag) of the cleartext JSON, HPKE info "PA-NAME1", aad = recipient id.
    public static func seal(_ f: NameField, recipient: PeerId, recipientEncPub: Data) throws -> String {
        let w = B64URL.encode(try HPKEWire.seal(Data(f.json.utf8), to: recipientEncPub, info: info,
                                                aad: Bytes.ascii(recipient.text)))
        guard w.utf8.count <= maxWire else { throw InnerMessage.Failure.tooLarge }
        return w
    }

    /// Open, parse and verify an entry from `owner` (pinned sign_pub and pairing id);
    /// returns the name and n, nil on any failure.
    public static func openVerified(_ c: String, me: PeerId, key: PADecryptor, owner: PeerId, ownerSignPub: Data,
                                    pairingId: Data) -> (name: String, n: UInt64)? {
        guard let f = open(c, me: me, key: key),
              let name = verify(f, owner: owner, recipient: me, pairingId: pairingId, ownerSignPub: ownerSignPub) else { return nil }
        return (name, f.n)
    }

    /// Open an entry addressed to me; strict JSON; nil on any failure.
    public static func open(_ c: String, me: PeerId, key: PADecryptor) -> NameField? {
        guard c.utf8.count <= maxWire, let w = B64URL.decode(c),
              let p = try? key.hpkeOpen(wire: w, info: info, aad: Bytes.ascii(me.text)),
              let v = try? StrictJSON.parse(p) else { return nil }
        return NameField.from(v)
    }
}
