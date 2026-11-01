import Foundation

public enum ApproveOutcome: Equatable, Sendable {
    case stored              // "Waiting for $X: open PushArmor there and tap Confirmed."
    case sent                // relayed; a returned c may complete the pairing
    case completed           // a returned c verified: X approves me
    case denied              // "Rejected by $X"
    case result(String)      // gone, unknown, logged out, unapproved, failed..
    case rateLimited(Int64)  // countdown until
    case network
    case error(Int)
}

extension Core {
    // MARK: GET /peers

    /// Fetch triggers with coalescing: at most 1 fetch per 60 s; a trigger inside the window
    /// sets fetch_due for later. In the NSE the fetch has a 5 s cap and one try.
    @discardableResult
    public func fetchPeers(force: Bool = false, nse: Bool = false) async -> Bool {
        let now = clock()
        guard let me = try? store.me(), me.id != nil else { return false }
        if !force && now - me.lastFetchAt < 60 {
            try? store.setMe("fetch_due", .int(1))
            return false
        }
        try? store.setMe("last_fetch_at", .int(now))
        let out = await signed("GET", "/v1/peers", retry: !nse, timeout: nse ? 5 : 15)
        guard let r = out.reply, r.ok, let j = r.json else {
            try? store.setMe("fetch_due", .int(1))
            return false
        }
        try? store.db.write {
            try mergePeerList(j, now: now)
            try store.setMe("fetch_due", .int(0))
        }
        if !nse { await allowReconcile() }
        return true
    }

    /// Merge a GET /peers (or POST /peers) body (catalog Removal rules, GET /peers merge).
    /// Pins never come from this list.
    func mergePeerList(_ j: JSONValue, now: Int64) throws {
        let me = try myId()
        var listedIds = Set<String>()
        if case .array(let list)? = j["peers"] {
            for e in list {
                guard let idT = e["id"]?.stringValue, let sp = e["sign_pub"]?.stringValue, let ep = e["enc_pub"]?.stringValue,
                      let (id, s, en) = PeerEntryCheck.valid(id: idT, signPub: sp, encPub: ep, myAccount: me.account) else { continue }
                if id == me { continue }
                listedIds.insert(id.text)
                var p = try store.peer(id) ?? Peer(id: id)
                if p.state == .removed && !p.pinned { p.state = .unruled }   // listed again after a local Delete
                p.listSignPub = s
                p.listEncPub = en
                p.platform = e["platform"]?.stringValue ?? p.platform
                if case .number(let c)? = e["created"] { p.created = Int64(c) }
                if case .bool(let b)? = e["logged_out"] { p.loggedOut = b }
                if case .bool(let b)? = e["reachable"] { p.reachable = b }
                if case .bool(let b)? = e["listening"] { p.listening = b } else { p.listening = true }
                if case .bool(let b)? = e["approves_me"] { p.getApprovesMe = b }
                if case .bool(let b)? = e["denies_me"] { p.getDeniesMe = b }
                p.getAt = now
                p.listed = true
                p.missing = false
                if let c = e["name_for_me"]?.stringValue, p.pinned,
                   let v = NameEntry.openVerified(c, me: me, key: keys.decryptor, owner: id, ownerSignPub: p.signPub!,
                                                  pairingId: p.pairingId!) {
                    if p.state == .approved {
                        if Int64(v.n) > p.nameN { p.name = v.name; p.nameN = Int64(v.n) }
                    } else if Int64(v.n) > p.pendingN {
                        p.pendingName = v.name
                        p.pendingN = Int64(v.n)
                    }
                }
                try store.savePeer(p)
            }
        }
        for var p in try store.peers() where !listedIds.contains(p.id.text) {
            p.listed = false
            switch p.state {
            case .approved:
                p.missing = true
                try store.savePeer(p)
            case .unruled, .denied:
                try store.dropPin(p.id)
                try store.deletePeer(p.id)
            case .removed:
                try store.savePeer(p)
            }
        }
        if case .array(let a)? = j["my_allow"] { try store.allowReplace(a.compactMap { $0.stringValue }) }
        if case .bool(true)? = j["push_missing"] { try store.setMe("push_missing", .int(1)) }
        if let h = j["my_push_sha256"]?.stringValue {
            try store.setSetting("my_push_sha256", h)
        } else if case .null? = j["my_push_sha256"] {
            try store.setSetting("my_push_sha256", nil)
        }
    }

    // MARK: allow reconcile

    /// The allow reconcile (catalog Approvals, I277, I278): withdraw every id in the allow
    /// set with no pin here; remove it on 200 or 400, keep it on 429, 5xx or network error.
    /// It never withdraws a pinned id.
    public func allowReconcile() async {
        guard let ids = try? store.allowSet() else { return }
        for t in ids.sorted() {
            guard let id = PeerId(text: t) else { try? store.allowRemove(t); continue }
            if let p = try? store.peer(id), p.pinned { continue }
            let out = await signed("POST", "/v1/deny/" + t, body: JOut.obj([("withdraw", .int(1))]).data)
            guard let r = out.reply else { continue }
            if r.status == 401 && r.error == "unknown peer" { return }
            if r.ok || r.status == 400 { try? store.allowRemove(t) }
        }
    }

    // MARK: approve, deny

    /// Approve (step 7): the id joins the allow set BEFORE the POST; the approve carries my
    /// keys and my name entry under the pairing id.
    public func approve(_ x: PeerId) async -> ApproveOutcome {
        let now = clock()
        do {
            try store.db.write {
                guard var p = try store.peer(x), p.pinned, p.state != .removed else { throw CoreError.notPinned }
                p.state = .approved
                if p.pendingN > 0, let pn = p.pendingName {
                    // a verified approve kept while unruled: X approves me now
                    p.approveVerified = true
                    p.approveVerifiedAt = now
                    p.name = pn
                    p.nameN = p.pendingN
                    p.pendingName = nil
                    p.pendingN = 0
                    try store.deletePairing(x)
                }
                try store.savePeer(p)
            }
            try store.allowAdd([x.text])
        } catch {
            return .error(0)
        }
        return await postApprove(x, fresh: true)
    }

    /// Build a fresh approve (new n, current name) and store it as the bytes to re-send.
    func buildApprove(_ x: PeerId) throws -> Data {
        let me = try store.me()
        guard let myId = me.id, let name = me.name, let p = try store.peer(x), let pid = p.pairingId, let enc = p.encPub else {
            throw CoreError.notPinned
        }
        var nameC = ""
        let c = try buildMessage(to: x, withKeys: true) { n in
            let f = try NameEntry.make(name: name, n: n, owner: myId, recipient: x, pairingId: pid, signer: keys.signer)
            nameC = try NameEntry.seal(f, recipient: x, recipientEncPub: enc)
            return .approve(f)
        }
        try store.db.write {
            guard var q = try store.peer(x) else { return }
            q.approveC = c
            q.approveName = nameC
            q.approveNameRev = me.nameRev
            try store.savePeer(q)
        }
        return JOut.obj([("c", .str(c)), ("name", .str(nameC))]).data
    }

    func storedApproveBody(_ x: PeerId) -> Data? {
        guard let p = try? store.peer(x), let c = p.approveC, let n = p.approveName else { return nil }
        return JOut.obj([("c", .str(c)), ("name", .str(n))]).data
    }

    public func postApprove(_ x: PeerId, fresh: Bool) async -> ApproveOutcome {
        let path = "/v1/approve/" + x.text
        var first = true
        let out: APIOutcome
        do {
            out = try await signedWithMessages("POST", path) {
                defer { first = false }
                if first && !fresh, let b = storedApproveBody(x) { return b }
                return try buildApprove(x)
            }
        } catch {
            return .error(0)
        }
        guard let r = out.reply else { return .network }
        let now = clock()
        if r.status == 429 {
            let nb = now + Int64(r.retryAfter ?? 60)
            try? store.db.write {
                if var p = try store.peer(x) { p.approveResult = "429"; p.approveSentAt = nb; try store.savePeer(p) }
            }
            return .rateLimited(nb)
        }
        guard r.ok, let res = r.json?["r"]?.stringValue else { return .error(r.status) }
        try? store.db.write {
            if var p = try store.peer(x) { p.approveResult = res; p.approveSentAt = now; try store.savePeer(p) }
        }
        var outcome: ApproveOutcome
        switch res {
        case "stored": outcome = .stored
        case "sent": outcome = .sent
        case "denied": outcome = .denied
        default: outcome = .result(res)
        }
        if let c = r.json?["c"]?.stringValue {
            // never trusted: verified exactly as a received approve, silently
            let rr = await receive(c, mode: .returnedC)
            if rr.approveVerified || ((try? store.peer(x))?.approveVerified ?? false) { outcome = .completed }
        }
        return outcome
    }

    /// Re-fetch while "Waiting for $X" (I265, I280): re-send the SAME approve on app open and
    /// Refresh; build a fresh one after a rename. Silent on 429 or network error.
    func resendApprove(_ p: Peer) async -> PairDecide.Resend {
        guard p.state == .approved, !p.approveVerified, p.pinned else { return .other }
        let rev = (try? store.me().nameRev) ?? 0
        let fresh = p.approveC == nil || p.approveNameRev != rev
        let r = await postApprove(p.id, fresh: fresh)
        switch r {
        case .completed: return .cVerified
        case .network: return ((try? store.me().loggedOut) ?? false) ? .loggedOut : .offline
        case .rateLimited: return .rateLimited
        case .error(let s) where s == 401: return .loggedOut
        case .error(let s) where s >= 500: return .serverError
        default: return .other
        }
    }

    /// App open and Refresh: re-send every waiting approve.
    public func resendWaitingApproves() async {
        for p in (try? store.peers()) ?? [] where p.state == .approved && !p.approveVerified && p.pinned {
            _ = await resendApprove(p)
        }
    }

    /// Deny. A pinned peer gets a signed deny message; the entry ends. An unpinned row has no
    /// pairing id: its deny is sealed to the listed key under an all-zero pairing id (as webext
    /// and Android); X drops it, but the Worker still records the deny.
    public func deny(_ x: PeerId) async -> ApproveOutcome {
        guard let p = try? store.peer(x) else { return .error(0) }
        let outcome: ApproveOutcome
        do {
            let out = try await signedWithMessages("POST", "/v1/deny/" + x.text) {
                let c = p.pinned ? try buildMessage(to: x) { _ in .deny } : try unpinnedDenyMessage(p)
                return JOut.obj([("c", .str(c))]).data
            }
            guard let r = out.reply else { return .network }
            if r.status == 429 { return .rateLimited(clock() + Int64(r.retryAfter ?? 60)) }
            guard r.ok, let res = r.json?["r"]?.stringValue else { return .error(r.status) }
            outcome = res == "denied" ? .denied : .result(res)
        } catch {
            return .error(0)
        }
        try? store.db.write {
            guard var q = try store.peer(x) else { return }
            q.state = .denied
            try store.savePeer(q)
            try store.deletePairing(x)
            try store.allowRemove(x.text)
        }
        return outcome
    }

    /// Deny for an unpinned row: no pairing id exists, so it is sealed to the listed key with
    /// an all-zero pairing id and n = 1 (no counter exists without a pin; as Android).
    func unpinnedDenyMessage(_ p: Peer) throws -> String {
        guard let enc = p.listEncPub else { throw CoreError.notPinned }
        return try InnerMessage.seal(InnerJSON(n: 1, content: .deny), signer: keys.signer, from: try myId(), to: p.id,
                                     toEncPub: enc, pairingId: Data(count: 8), keys: nil)
    }

    // MARK: rename, remove, local actions

    /// Rename self: PATCH /peers/$my-id with name entries + rename messages to approved peers.
    public func rename(_ name: String) async throws -> APIOutcome {
        guard NameEntry.isValidName(name) else { throw CoreError.refused("name") }
        let me = try myId()
        try store.db.write {
            let m = try store.me()
            try store.setMe("name", .text(name))
            try store.setMe("name_rev", .int(m.nameRev + 1))
        }
        return try await signedWithMessages("PATCH", "/v1/peers/" + me.text) {
            var names: [PeerId: String] = [:]
            let msgs = try allowMessages { id, n in
                guard let p = try store.peer(id), let pid = p.pairingId, let enc = p.encPub else { throw CoreError.notPinned }
                let f = try NameEntry.make(name: name, n: n, owner: me, recipient: id, pairingId: pid, signer: keys.signer)
                names[id] = try NameEntry.seal(f, recipient: id, recipientEncPub: enc)
                return .rename(f)
            }
            return JOut.obj([("name", JOut.messages(names)), ("m", JOut.messages(msgs))]).data
        }
    }

    /// Remove (any peer may remove any peer; account-wide).
    public func removePeer(_ x: PeerId) async throws -> APIOutcome {
        let out = try await signedWithMessages("DELETE", "/v1/peers/" + x.text) {
            JOut.obj([("m", JOut.messages(try allowMessages { _, _ in .remove(x.text) }))]).data
        }
        if out.reply?.ok == true {
            try store.db.write {
                if try store.peer(x) != nil { try store.dropPin(x, state: .removed) }
                try store.allowRemove(x.text)
            }
            await allowReconcile()
        }
        return out
    }

    /// Delete of a missing row: local only (drop the pin, keep history, no Worker call).
    public func localDelete(_ x: PeerId) async {
        try? store.dropPin(x, state: .removed)
        await allowReconcile()
    }

    public func setHidden(_ x: PeerId, _ hidden: Bool) throws {
        try store.db.write {
            guard var p = try store.peer(x) else { return }
            p.hidden = hidden
            try store.savePeer(p)
        }
    }

    public func setPeerSwitches(_ x: PeerId, lockShow: Bool? = nil, showContent: Bool? = nil) throws {
        try store.db.write {
            guard var p = try store.peer(x) else { return }
            if let v = lockShow { p.lockShow = v }
            if let v = showContent { p.showContent = v }
            try store.savePeer(p)
        }
    }

    /// The "All" set (catalog Pairing flow, the one definition).
    public func allSet() throws -> [Peer] { try store.peers().filter { $0.inAll } }
}
