import Foundation

/// Row notes kept on a peer after a pairing ends visibly.
public enum PairNote: String, Sendable {
    case failed      // "Pairing failed. Start again on the new peer."
    case timedOut    // "Pairing timed out. Tap Pair to start again."
    case pairAgain   // the half-state notice fired: the row offers Pair again
}

/// Result of one POST /pair.
public enum PairSendResult: Equatable, Sendable {
    case sent
    case result(String)          // denied | gone | unknown | logged out | failed[:..]
    case rateLimited(Int64)      // not_before (unix s)
    case waiting(Int64)          // not_before not reached, nothing sent
    case network
    case error(Int)
}

extension Core {
    var myKeys: (sign: Data, enc: Data) { (keys.signer.publicKey, keys.decryptor.publicKey) }

    // MARK: pair messages in (NSE and drain)

    func receivePair(_ m: String, me: PeerId, mode: ReceiveMode) async -> ReceiveResult {
        guard let pm = try? PairMessage.open(m, me: me, key: keys.decryptor) else { return drop(mode) }
        switch pm.body {
        case .commit(let cN): return await onCommit(from: pm.from, cN: cN, me: me, mode: mode)
        case .reply(let s, let e, let r): return await onReply(from: pm.from, signPub: s, encPub: e, rX: r, me: me, mode: mode)
        case .open(let s, let e, let r): return onOpen(from: pm.from, signPub: s, encPub: e, rN: r, me: me, mode: mode)
        }
    }

    func pairBanner(_ body: String, n: PeerId, x: PeerId, peer: PeerId, category: BannerCategory = .event) -> Banner {
        Banner(body: body, locKey: nil, category: category, threadId: PairingCrypto.pairingKey(nId: n, xId: x), rowid: nil,
               tap: .peers(peer.text))
    }

    /// X on a commit push (catalog Pairing flow step 3, rules a-e).
    func onCommit(from: PeerId, cN: Data, me: PeerId, mode: ReceiveMode) async -> ReceiveResult {
        let now = clock()
        var listed: PairDecide.Listed = ((try? store.peer(from))?.listed ?? false) ? .yes : .no
        if listed == .no {
            // one fetch, then still absent: drop
            _ = await fetchPeers(force: false, nse: mode == .nse)
            listed = ((try? store.peer(from))?.listed ?? false) ? .afterFetch : .no
        }
        let decided: (PairDecide.Output, PairingEntry?, Peer?)
        do {
            decided = try store.db.write {
                let e = try store.pairing(from)
                let p = try store.peer(from)
                let input = PairDecide.Input(
                    ownId: me, fromId: from, commitCN: cN,
                    entry: e.map { PairDecide.Entry(role: $0.role, state: $0.state, cN: $0.cN, replyAuthorized: $0.authorized) },
                    pinned: p?.pinned ?? false, approved: p?.state == .approved, approveVerified: p?.approveVerified ?? false,
                    approvesMe: p?.getApprovesMe, getAfterVerify: p?.getAfterVerify ?? false, listed: listed,
                    openEntries: try store.pairings().count, cap: try store.capTimestamps(), now: now)
                let out = PairDecide.decide(input)
                func newX(authorized: Bool) throws {
                    try store.savePairing(PairingEntry(peerId: from, role: .x, state: .prompted, r: PairingCrypto.randomR(), cN: cN,
                                                       authorized: authorized, unsent: authorized, startedAt: now, notBefore: 0,
                                                       lastSendAt: 0))
                    if var q = try store.peer(from) { q.note = nil; try store.savePeer(q) }
                }
                switch out.entry {
                case .createdReplied:
                    try newX(authorized: true)
                    try store.appendCap(now)     // counts when the entry persists, before the send (I235)
                case .createdPrompted:
                    try newX(authorized: false)
                case .nWipedXReplied:
                    try store.deletePairing(from)
                    try newX(authorized: true)   // a tapped reply: not counted in the cap
                case .aborted:
                    try store.deletePairing(from)
                    if var q = p { q.note = PairNote.failed.rawValue; try store.savePeer(q) }
                case .unchanged, .none:
                    break
                }
                if out.notice == .halfState, var q = try store.peer(from) {
                    q.note = PairNote.pairAgain.rawValue
                    try store.savePeer(q)
                }
                return (out, try store.pairing(from), try store.peer(from))
            }
        } catch {
            return drop(mode, fault: true)
        }
        let (out, entry, peer) = decided
        var banner: Banner?
        switch out.notice {
        case .commit:
            banner = pairBanner(S.pairCommit, n: from, x: me, peer: from)
        case .represent:
            if entry?.state == .shown, let fp = peer?.fingerprint {
                banner = pairBanner(S.pairOpen(fp), n: from, x: me, peer: from)
            } else {
                banner = pairBanner(S.pairCommit, n: from, x: me, peer: from)
            }
        case .halfState:
            banner = pairBanner(S.pairAgain(PeerLabel.label(peer)), n: from, x: me, peer: from, category: .notice)
        case .crossing:
            banner = pairBanner(S.pairCrossing(PeerLabel.label(peer)), n: me, x: from, peer: from)
        case .couldNotRead:
            return drop(mode)
        }
        if out.action == .reply, let e = entry {
            _ = await sendReply(e, nse: mode == .nse)
        }
        return .plain(mode == .nse ? banner : nil)
    }

    /// N on a reply (step 4): only in state committed; pin X's keys, store the pairing id,
    /// persist, then send the open.
    func onReply(from: PeerId, signPub: Data, encPub: Data, rX: Data, me: PeerId, mode: ReceiveMode) async -> ReceiveResult {
        let now = clock()
        let my = myKeys
        let e: PairingEntry?
        do {
            e = try store.db.write {
                guard var e = try store.pairing(from), e.role == .n, e.state == .committed, let rN = e.r else { return nil }
                let pid = PairingCrypto.pairingId(rN: rN, rX: rX)
                let fp = PairingCrypto.fingerprint(signPubN: my.sign, encPubN: my.enc, signPubX: signPub, encPubX: encPub, rN: rN, rX: rX)
                try store.pin(from, signPub: signPub, encPub: encPub, pairingId: pid, fingerprint: fp)
                e.state = .shown
                try store.savePairing(e)
                return e
            }
        } catch {
            return drop(mode, fault: true)
        }
        guard let entry = e else { return drop(mode) }
        _ = await sendOpen(entry, nse: mode == .nse)
        return .plain(mode == .nse ? pairBanner(S.pairReply, n: me, x: from, peer: from) : nil)
    }

    /// X on an open (step 5): only in state replied; check c_N, pin exactly these keys.
    func onOpen(from: PeerId, signPub: Data, encPub: Data, rN: Data, me: PeerId, mode: ReceiveMode) -> ReceiveResult {
        enum R { case drop, abort, shown(String) }
        let my = myKeys
        let r: R
        do { r = try store.db.write { () -> R in
            guard var e = try store.pairing(from), e.role == .x, let cN = e.cN, let rX = e.r else { return .drop }
            let matches = PairingCrypto.commit(signPubN: signPub, encPubN: encPub, rN: rN) == cN
            if e.state == .shown {
                // an open identical to the accepted one re-presents the notice
                guard matches, let p = try store.peer(from), p.signPub == signPub, let fp = p.fingerprint else { return .drop }
                return .shown(fp)
            }
            guard e.state == .replied || (e.state == .prompted && e.authorized) else { return .drop }
            guard matches else {
                try store.deletePairing(from)
                if var p = try store.peer(from) { p.note = PairNote.failed.rawValue; try store.savePeer(p) }
                return .abort
            }
            let pid = PairingCrypto.pairingId(rN: rN, rX: rX)
            let fp = PairingCrypto.fingerprint(signPubN: signPub, encPubN: encPub, signPubX: my.sign, encPubX: my.enc, rN: rN, rX: rX)
            try store.pin(from, signPub: signPub, encPub: encPub, pairingId: pid, fingerprint: fp)
            e.state = .shown
            e.unsent = false
            try store.savePairing(e)
            return .shown(fp)
        } } catch {
            return drop(mode, fault: true)
        }
        switch r {
        case .drop, .abort: return drop(mode)
        case .shown(let fp): return .plain(mode == .nse ? pairBanner(S.pairOpen(fp), n: from, x: me, peer: from) : nil)
        }
    }

    // MARK: pair sends

    func postPair(_ to: PeerId, kind: String, c: String, nse: Bool) async -> PairSendResult {
        let body = JOut.obj([("k", .str(kind)), ("c", .str(c))]).data
        let out = await signed("POST", "/v1/pair/" + to.text, body: body, retry: !nse, timeout: nse ? 8 : 15)
        guard let r = out.reply else { return .network }
        if r.status == 429 {
            let nb = clock() + Int64(r.retryAfter ?? 60)
            try? store.db.write {
                if var e = try store.pairing(to) { e.notBefore = nb; try store.savePairing(e) }
            }
            return .rateLimited(nb)
        }
        guard r.ok, let res = r.json?["r"]?.stringValue else { return .error(r.status) }
        return res == "sent" ? .sent : .result(res)
    }

    /// X: send (or re-send) the reply of an entry with the same r_X. Waits for not_before.
    public func sendReply(_ e: PairingEntry, nse: Bool = false) async -> PairSendResult {
        let now = clock()
        guard now >= e.notBefore else { return .waiting(e.notBefore) }
        guard let me = try? myId(), let p = try? store.peer(e.peerId), let enc = p.listEncPub, let rX = e.r,
              let c = try? PairMessage.seal(from: me, to: e.peerId, recipientEncPub: enc,
                                            body: .reply(signPub: myKeys.sign, encPub: myKeys.enc, r: rX)) else { return .error(0) }
        let res = await postPair(e.peerId, kind: "reply", c: c, nse: nse)
        try? store.db.write {
            guard var cur = try store.pairing(e.peerId), cur.role == .x, cur.r == rX else { return }
            cur.lastSendAt = now
            if res == .sent {
                cur.unsent = false
                if cur.state == .prompted { cur.state = .replied }
            }
            try store.savePairing(cur)
        }
        return res
    }

    /// N: send the open (r_N kept until the pairing ends).
    func sendOpen(_ e: PairingEntry, nse: Bool = false) async -> PairSendResult {
        let now = clock()
        guard now >= e.notBefore else { return .waiting(e.notBefore) }
        guard let me = try? myId(), let p = try? store.peer(e.peerId), let enc = p.encPub, let rN = e.r,
              let c = try? PairMessage.seal(from: me, to: e.peerId, recipientEncPub: enc,
                                            body: .open(signPub: myKeys.sign, encPub: myKeys.enc, r: rN)) else { return .error(0) }
        let res = await postPair(e.peerId, kind: "open", c: c, nse: nse)
        try? store.db.write {
            if var cur = try store.pairing(e.peerId) { cur.lastSendAt = now; try store.savePairing(cur) }
        }
        return res
    }

    func sendCommit(_ e: PairingEntry) async -> PairSendResult {
        let now = clock()
        guard now >= e.notBefore else { return .waiting(e.notBefore) }
        guard let me = try? myId(), let p = try? store.peer(e.peerId), let enc = p.listEncPub, let rN = e.r else { return .error(0) }
        let cN = PairingCrypto.commit(signPubN: myKeys.sign, encPubN: myKeys.enc, rN: rN)
        guard let c = try? PairMessage.seal(from: me, to: e.peerId, recipientEncPub: enc, body: .commit(cN: cN)) else { return .error(0) }
        let res = await postPair(e.peerId, kind: "commit", c: c, nse: false)
        try? store.db.write {
            if var cur = try store.pairing(e.peerId) { cur.lastSendAt = now; try store.savePairing(cur) }
        }
        return res
    }

    // MARK: user actions

    public enum PairStartError: Error, Equatable { case pinned, openEntry, tooManyOpen, notListed, notOffered }

    /// [Pair] on an unpinned row (step 2): persist (r_N, c_N) before the commit send.
    /// Refuses to overwrite an open entry (I234).
    public func startPair(_ x: PeerId) async throws -> PairSendResult {
        let now = clock()
        let my = myKeys
        let e: PairingEntry = try store.db.write {
            guard var p = try store.peer(x), p.listEncPub != nil else { throw PairStartError.notListed }
            guard !p.pinned else { throw PairStartError.pinned }
            guard try store.pairing(x) == nil else { throw PairStartError.openEntry }
            guard try store.pairings().count < PairDecide.maxOpenEntries else { throw PairStartError.tooManyOpen }
            let rN = PairingCrypto.randomR()
            let e = PairingEntry(peerId: x, role: .n, state: .committed, r: rN,
                                 cN: PairingCrypto.commit(signPubN: my.sign, encPubN: my.enc, rN: rN),
                                 authorized: false, unsent: false, startedAt: now, notBefore: 0, lastSendAt: 0)
            try store.savePairing(e)
            p.note = nil
            try store.savePeer(p)
            return e
        }
        return await sendCommit(e)
    }

    /// [Send again] on N (step 8): committed re-sends the same commit, shown re-sends the
    /// open until X's approve verifies. Offered 60 s after the last send.
    public func sendAgain(_ x: PeerId) async -> PairSendResult? {
        guard let e = try? store.pairing(x), e.role == .n, clock() >= e.lastSendAt + 60 else { return nil }
        switch e.state {
        case .committed: return await sendCommit(e)
        case .shown: return await sendOpen(e)
        default: return nil
        }
    }

    /// Whether [Send again] is enabled now (greyed 60 s after the last send).
    public func canSendAgain(_ e: PairingEntry) -> Bool {
        e.role == .n && (e.state == .committed || e.state == .shown) && clock() >= max(e.lastSendAt + 60, e.notBefore)
    }

    /// [Reply] on a prompted X row: one tap sends it (not counted in the cap).
    public func tapReply(_ x: PeerId) async -> PairSendResult? {
        let e: PairingEntry? = try? store.db.write {
            guard var e = try store.pairing(x), e.role == .x, e.state == .prompted else { return nil }
            e.authorized = true
            e.unsent = true
            try store.savePairing(e)
            return e
        }
        guard let entry = e else { return nil }
        return await sendReply(entry)
    }

    /// App open: retry authorized replies that were not "sent" (same r_X, I237).
    public func retryUnsentReplies() async {
        for e in (try? store.pairings()) ?? [] where e.role == .x && e.authorized && e.unsent {
            _ = await sendReply(e)
        }
    }

    /// Cancel pairing (step 8, I264, I279): local only, then the allow reconcile.
    public func cancelPairing(_ x: PeerId) async {
        try? store.db.write {
            try store.dropPin(x)
            if var p = try store.peer(x) { p.note = nil; try store.savePeer(p) }
        }
        await allowReconcile()
    }

    /// Whether a row offers Cancel pairing.
    public func offersCancel(_ p: Peer) -> Bool {
        (try? store.pairing(p.id)) != nil || p.notPairedOnPeer
    }

    /// Whether a row offers Pair again in place of Cancel pairing: the half-state notice
    /// fired for it and it still offers Cancel pairing.
    public func offersPairAgain(_ p: Peer) -> Bool {
        p.note == PairNote.pairAgain.rawValue && offersCancel(p)
    }

    /// [Pair again] on a half-state row: Cancel pairing (local drop and the allow
    /// reconcile, awaited), then [Pair]. The offer check and the drop are one transaction,
    /// so a second tap while the first runs throws notOffered and changes nothing (I435).
    /// The [Pair] preconditions are checked before the drop, so a refusal keeps the row.
    public func pairAgain(_ x: PeerId) async throws -> PairSendResult {
        try store.db.write {
            guard let p = try store.peer(x), offersPairAgain(p) else { throw PairStartError.notOffered }
            guard p.listEncPub != nil else { throw PairStartError.notListed }
            guard try store.pairings().filter({ $0.peerId != x }).count < PairDecide.maxOpenEntries else {
                throw PairStartError.tooManyOpen
            }
            try store.dropPin(x)
            if var q = try store.peer(x) { q.note = nil; try store.savePeer(q) }
        }
        await allowReconcile()
        return try await startPair(x)
    }

    /// The toast after [Pair again] (I436): nil when the commit went out, is queued, or the
    /// tap was a repeat of one still running.
    public static func pairAgainToast(_ r: Result<PairSendResult, Error>) -> String? {
        switch r {
        case .success(.sent), .success(.waiting), .success(.rateLimited): return nil
        case .success(.network), .success(.error): return S.pairNotSent
        case .success(.result): return S.cannotPairNow
        case .failure(let e as PairStartError) where e == .notOffered: return nil
        case .failure: return S.cannotPairNow
        }
    }

    /// The toast after a Log out, Remove, Deny, or Approve call (I473): nil when it went through,
    /// so a failed call never looks like a silent no-op; the button stays for a retry.
    public static func failText(_ out: APIOutcome?) -> String? {
        guard let out = out else { return S.notDone }
        if out.reply?.ok == true { return nil }
        if out.isClockSkew { return S.clockOff }
        return out.reply == nil ? S.noConnection : S.notDone
    }

    /// Same for an ApproveOutcome (Approve, Deny): the relay server's answers are not failures.
    public static func failText(_ o: ApproveOutcome?) -> String? {
        switch o {
        case .network?: return S.noConnection
        case .error?, nil: return S.notDone
        default: return nil
        }
    }

    /// 14-day timeout check (app open and Refresh; no background timer).
    public func checkTimeouts() async {
        let now = clock()
        var dropped = false
        for e in (try? store.pairings()) ?? [] where Pairing.isExpired(startedAt: e.startedAt, now: now) {
            let p = try? store.peer(e.peerId)
            let verified = p?.approveVerified ?? false
            let approved = p?.state == .approved
            var action = PairDecide.timeout(approveVerified: verified, approved: approved, resend: nil)
            if action == .resend, let pp = p {
                let r = await resendApprove(pp)
                action = PairDecide.timeout(approveVerified: verified, approved: approved, resend: r)
            }
            switch action {
            case .dropPin:
                try? store.db.write {
                    try store.dropPin(e.peerId)
                    if var q = try store.peer(e.peerId) { q.note = PairNote.timedOut.rawValue; try store.savePeer(q) }
                }
                dropped = true
            case .keepPin, .complete:
                try? store.deletePairing(e.peerId)
            case .keepWaiting, .resend:
                break
            }
        }
        if dropped { await allowReconcile() }
    }

    /// The N-side hint line for a committed row.
    public func hintLine(_ e: PairingEntry, peer: Peer) -> String? {
        guard e.role == .n, e.state == .committed else { return nil }
        let x = PeerLabel.label(peer)
        switch PairDecide.hint(approvesMe: peer.getApprovesMe, committedSeconds: clock() - e.startedAt) {
        case .stillHolds?: return S.stillHolds(x)
        case .noReplyYet?: return S.noReplyYet(x)
        case nil: return nil
        }
    }
}
