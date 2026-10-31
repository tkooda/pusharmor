import Foundation

public enum RegisterOutcome: Sendable {
    case registered(PeerId)
    /// 409 "peer limit": the fresh 10-min ticket and the listed peers for the picker.
    case peerLimit(ticket: String, peers: [JSONValue])
    case idCollision
    case banned
    case ticketExpired
    case failed(Int, String?)
    case network
}

extension Core {
    /// POST /peers (headers PA-Time + PA-Sig by the NEW key, no PA-ID). push may be nil;
    /// sign-in never waits for the APNs token.
    public func register(ticket: String, push: PushInfo?, evict: [String] = []) async -> RegisterOutcome {
        var fields: [(String, JOut)] = [
            ("ticket", .str(ticket)), ("sign_pub", .str(B64URL.encode(keys.signer.publicKey))),
            ("enc_pub", .str(B64URL.encode(keys.decryptor.publicKey))), ("platform", .str("ios")),
            ("push", push.map { p in JOut.obj([("type", .str(p.type.rawValue)), ("token", .str(p.token))]) } ?? .null),
        ]
        if !evict.isEmpty { fields.append(("evict", .arr(evict.map { .str($0) }))) }
        let body = JOut.obj(fields).data
        var out = await api.call("POST", "/v1/peers", body: body, auth: .signed(keys.signer, nil))
        // the offset is re-synced from the reply; the ticket is still valid, so sign again once
        if out.isClockSkew { out = await api.call("POST", "/v1/peers", body: body, auth: .signed(keys.signer, nil)) }
        guard let r = out.reply else { return .network }
        switch (r.status, r.error) {
        case (403, "banned"?): return .banned
        case (409, "peer limit"?):
            var list: [JSONValue] = []
            if case .array(let a)? = r.json?["peers"] { list = a }
            return .peerLimit(ticket: r.json?["ticket"]?.stringValue ?? "", peers: list)
        case (409, "id collision"?): return .idCollision
        case (401, "ticket expired"?): return .ticketExpired
        default: break
        }
        guard r.ok, let j = r.json, let idT = j["id"]?.stringValue, let id = PeerId(text: idT),
              id.matches(signPub: keys.signer.publicKey, encPub: keys.decryptor.publicKey) else {
            return .failed(r.status, r.error)
        }
        let now = clock()
        do {
            try store.db.write {
                let prev = try store.me()
                if let old = prev.id, old != id { try store.setMe("old_id", .text(old.text)) }
                try store.setMe("id", .text(id.text))
                try store.setMe("sign_pub", .blob(keys.signer.publicKey))
                try store.setMe("enc_pub", .blob(keys.decryptor.publicKey))
                try store.setMe("removed", .int(0))
                try store.setMe("logged_out", .int(0))
                try store.setMe("request_token", .null)
                if let p = push { try store.setMe("last_push_sha256", .text(Ids.pushSha256(p))) }
                try store.setMe("last_fetch_at", .int(now))
                try mergePeerList(j, now: now)
            }
        } catch {
            return .failed(r.status, "store")
        }
        await deleteOldId()
        await allowReconcile()
        return .registered(id)
    }

    /// DELETE /peers/$old-id with empty m after a re-key; old_id is kept until it is done.
    public func deleteOldId() async {
        guard let old = try? store.me().oldId, let oid = PeerId(text: old), oid != (try? myId()) else { return }
        let out = await signed("DELETE", "/v1/peers/" + oid.text, body: JOut.obj([("m", .obj([]))]).data)
        if let r = out.reply, r.ok || r.status == 400 { try? store.setMe("old_id", .null) }
    }

    /// PATCH push (null = no push).
    public func patchPush(_ push: PushInfo?) async -> Bool {
        guard let me = try? myId() else { return false }
        let p: JOut = push.map { JOut.obj([("type", .str($0.type.rawValue)), ("token", .str($0.token))]) } ?? .null
        let out = await signed("PATCH", "/v1/peers/" + me.text, body: JOut.obj([("push", p)]).data)
        guard out.reply?.ok == true else { return false }
        try? store.db.write {
            try store.setMe("last_push_sha256", push.map { .text(Ids.pushSha256($0)) } ?? .null)
            try store.setMe("push_missing", .int(0))
        }
        return true
    }

    /// Reconcile (catalog Gone handling): on launch and foreground compare with the last
    /// PATCHed hash; also PATCH when push_missing is set, and on Refresh when my_push_sha256
    /// differs.
    public func reconcilePush(_ current: PushInfo?, refresh: Bool = false) async {
        guard let cur = current, let me = try? store.me(), me.id != nil, !me.removed, !me.loggedOut else { return }
        let h = Ids.pushSha256(cur)
        var need = me.lastPushSha256 != h || me.pushMissing
        if refresh, let server = try? store.setting("my_push_sha256"), server != h { need = true }
        if refresh, (try? store.setting("my_push_sha256")) == nil { need = true }
        if need { _ = await patchPush(cur) }
    }

    /// Log out = mark this peer logged out, with a logout message for every allowed peer.
    public func logout() async throws -> APIOutcome {
        let me = try myId()
        let out = try await signedWithMessages("POST", "/v1/peers/" + me.text + "/logout") {
            JOut.obj([("m", JOut.messages(try allowMessages { _, _ in .logout }))]).data
        }
        if out.reply?.ok == true { try store.setMe("logged_out", .int(1)) }
        return out
    }

    /// Log out tap (Q368): logged out here at once, with the relay server call kept as
    /// pending so it is sent now and again on later app opens until it goes through.
    public func logoutLocal() throws {
        try store.db.write {
            try store.setMe("logged_out", .int(1))
            try store.setSetting(Core.logoutPendingKey, "1")
        }
    }

    static let logoutPendingKey = "logout_pending"

    public var logoutPending: Bool { (try? store.setting(Core.logoutPendingKey)) != nil }

    /// Sends a pending logout. It stays pending on no reply, 429, 5xx, or clock skew; it is dropped once
    /// the relay server answered otherwise, or when this device was removed or logged in again.
    public func retryPendingLogout() async {
        guard logoutPending else { return }
        guard let me = try? store.me(), me.id != nil, !me.removed, me.loggedOut else {
            try? store.setSetting(Core.logoutPendingKey, nil)
            return
        }
        guard let out = try? await logout(), let r = out.reply, r.status != 429, r.status < 500, !out.isClockSkew else { return }
        try? store.setSetting(Core.logoutPendingKey, nil)
    }

    /// Log in again after a logout: a fresh "login" ticket, login messages, then one
    /// GET /peers and the push reconcile.
    public func login(ticket: String, push: PushInfo?) async throws -> APIOutcome {
        let me = try myId()
        let out = try await signedWithMessages("POST", "/v1/peers/" + me.text + "/login") {
            JOut.obj([("ticket", .str(ticket)), ("m", JOut.messages(try allowMessages { _, _ in .login }))]).data
        }
        if out.reply?.ok == true {
            try store.setMe("logged_out", .int(0))
            try store.setSetting(Core.logoutPendingKey, nil)
            await fetchPeers(force: true)
            await resendWaitingApproves()
            await reconcilePush(push)
        }
        return out
    }

    /// Delete account: DELETE /account with the ticket and delete messages, then the wipe.
    public func deleteAccount(ticket: String) async throws -> APIOutcome {
        let body = { () throws -> Data in
            JOut.obj([("ticket", .str(ticket)), ("sign_pub", .str(B64URL.encode(self.keys.signer.publicKey))),
                      ("m", JOut.messages(try self.allowMessages { _, _ in .delete }))]).data
        }
        var out = await api.call("DELETE", "/v1/account", body: try body(), auth: .signed(keys.signer, nil))
        if out.isClockSkew { out = await api.call("DELETE", "/v1/account", body: try body(), auth: .signed(keys.signer, nil)) }
        if out.reply?.ok == true { selfRemoved() }
        return out
    }

    /// App open (ios 7, 9): locked-inbox drain is done by the caller first. No fetch on app
    /// open unless one is due.
    public func appOpen(push: PushInfo?) async {
        await reconcilePush(push)
        if (try? store.me().fetchDue) == true { await fetchPeers() }
        await allowReconcile()
        await retryUnsentReplies()
        await resendWaitingApproves()
        await checkTimeouts()
        await deleteOldId()
    }

    /// Refresh button (greyed 60 s after use): one GET /peers, push reconcile, re-sends.
    public func refresh(push: PushInfo?) async {
        await fetchPeers(force: true)
        await reconcilePush(push, refresh: true)
        await resendWaitingApproves()
        await checkTimeouts()
    }
}
