import Foundation

/// The pinned state of one sender as the receive pipeline needs it.
public struct PinState: Sendable {
    public var id: PeerId
    public var signPub: Data
    public var encPub: Data
    public var pairingId: Data
    public var ruling: PeerState
    public init(id: PeerId, signPub: Data, encPub: Data, pairingId: Data, ruling: PeerState) {
        self.id = id
        self.signPub = signPub
        self.encPub = encPub
        self.pairingId = pairingId
        self.ruling = ruling
    }
}

/// Steps 4-9 of ios 6.1 for an inner message, as a pure function of the receiver state
/// (catalog Inner message, Replay window, Receiver acceptance). The store layer persists
/// the result in one transaction.
public enum ReceivePipeline {
    public enum Outcome: Equatable, Sendable {
        /// Accepted: the window advanced; apply the message.
        case accept
        /// A replay: "Invalid message received" (notice and History event).
        case invalid
        /// A seen n of url/text/tel with a History row: re-present that row, nothing else.
        case represent
        /// A seen n of a control type: silent duplicate, no state change.
        case noop
        /// Every other drop: generic "could not read".
        case unreadable
    }

    public struct Result: Sendable {
        public var outcome: Outcome
        /// Set once the signature verified (rows name the peer only then).
        public var verifiedFrom: PeerId?
        /// The from id when no pin exists for it (an unknown sender sets fetch_due).
        public var unknownFrom: PeerId?
        public var json: InnerJSON?
        /// approve / rename: the verified name.
        public var name: String?
        public var windowAfter: ReplayWindow?
        public var pairingId: Data?

        static func drop(_ from: PeerId? = nil) -> Result {
            Result(outcome: .unreadable, verifiedFrom: from, unknownFrom: nil, json: nil, name: nil, windowAfter: nil, pairingId: nil)
        }
    }

    public static func isControl(_ c: MessageContent) -> Bool { !c.isContent }

    /// - Parameters:
    ///   - pin: the pinned keys, pairing id and ruling for a from id (nil = not pinned).
    ///   - window: the replay window for a pinned sender.
    ///   - hasHistory: a History row exists for (sender, pairing id, n).
    public static func run(m: String, me: PeerId, key: PADecryptor, pin: (PeerId) -> PinState?,
                           window: (PeerId) -> ReplayWindow?, hasHistory: (PeerId, UInt64) -> Bool) -> Result {
        // step 1 / 4: strict b64url, size, HPKE open
        guard let plain = try? InnerMessage.open(m, me: me, key: key) else { return .drop() }
        // step 5: split, zero padding, length
        guard let sp = try? InnerMessage.split(plain) else { return .drop() }
        // step 6: account prefix, signer, one verify before inflate
        guard sp.from.sameAccount(as: me) else { return .drop() }
        guard let p = pin(sp.from) else {
            var r = Result.drop()
            r.unknownFrom = sp.from
            return r
        }
        let signPub: Data
        if let k = sp.keys {
            // embedded keys must be valid, hash to the from id and equal the pinned keys
            guard PublicKeys.validPair(signPub: k.signPub, encPub: k.encPub), sp.from.matches(signPub: k.signPub, encPub: k.encPub),
                  k.signPub == p.signPub, k.encPub == p.encPub else { return .drop() }
            signPub = k.signPub
        } else {
            signPub = p.signPub
        }
        guard Signatures.verify(sp.sig, data: InnerMessage.signedBytes(recipient: me, tail: sp.tail), publicKey: signPub) else {
            return .drop()
        }
        let from = sp.from
        guard sp.pairingId == p.pairingId, p.ruling != .removed else { return .drop(from) }
        // step 7: inflate with the cap only after the verify; strict JSON
        guard let raw = try? Deflate.inflateRaw(sp.deflated), let j = try? InnerJSON.parse(raw) else { return .drop(from) }
        var isApprove = false
        if case .approve = j.content { isApprove = true }
        guard isApprove == (sp.keys != nil) else { return .drop(from) }
        // step 8: replay window
        guard var w = window(from) else { return .drop(from) }
        var r = Result(outcome: .accept, verifiedFrom: from, unknownFrom: nil, json: j, name: nil, windowAfter: nil,
                       pairingId: p.pairingId)
        switch w.outcome(j.n, control: isControl(j.content), hasHistory: hasHistory(from, j.n)) {
        case .accept: break
        case .invalid: r.outcome = .invalid; return r
        case .represent: r.outcome = .represent; return r
        case .noop: r.outcome = .noop; return r
        }
        // step 9: acceptance table
        switch j.content {
        case .url, .text, .tel, .rename, .remove, .delete, .pause, .unpause, .deny:
            guard p.ruling == .approved else { return .drop(from) }
        case .approve:
            guard p.ruling == .approved || p.ruling == .unruled else { return .drop(from) }
        }
        switch j.content {
        case .approve(let f), .rename(let f):
            guard f.n == j.n, let name = NameEntry.verify(f, owner: from, recipient: me, pairingId: p.pairingId, ownerSignPub: p.signPub) else {
                return .drop(from)
            }
            r.name = name
        case .remove(let id):
            guard PeerId(text: id) != nil else { return .drop(from) }
        default: break
        }
        w.accept(j.n)
        r.windowAfter = w
        return r
    }
}

/// A GET /peers entry check (catalog IDs, Encodings): account prefix, valid 65-byte points,
/// sign_pub != enc_pub, keys hash to the id's keyhash.
public enum PeerEntryCheck {
    public static func valid(id: String, signPub: String, encPub: String, myAccount: Data) -> (PeerId, Data, Data)? {
        guard let pid = PeerId(text: id), pid.account == myAccount,
              let s = B64URL.decode(signPub), let e = B64URL.decode(encPub),
              PublicKeys.validPair(signPub: s, encPub: e), pid.matches(signPub: s, encPub: e) else { return nil }
        return (pid, s, e)
    }
}
