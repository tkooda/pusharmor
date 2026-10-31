import Foundation

/// The device keys in use (Secure Enclave on a phone; software in tests and the Simulator).
public struct DeviceKeys {
    public let signer: PASigner
    public let decryptor: PADecryptor
    public init(signer: PASigner, decryptor: PADecryptor) {
        self.signer = signer
        self.decryptor = decryptor
    }
}

/// Platform side effects the core cannot do itself (Keychain, files, notifications).
public protocol PlatformHooks: AnyObject {
    /// SecItemDelete for the access group (all three Keychain items).
    func wipeKeys()
    /// Remove store/locked-inbox/.
    func removeLockedInbox()
    /// removeAllDeliveredNotifications().
    func removeDeliveredNotifications()
    /// True when the canary file (protection complete) cannot be read.
    func isProtectedDataLocked() -> Bool
}

/// Settings keys (section 11).
public enum SettingKey {
    public static let showAll = "show_all"                 // default on
    public static let lockShow = "lock_show"               // main switch, default on
    public static let showContent = "show_content"         // main switch, default on (was always_hide, inverted)
    public static let historyDays = "history_days"         // default 30
}

/// Shared logic of the app, the NSE and the share extension over one store and one API client.
public final class Core: @unchecked Sendable {
    public let store: Store
    public let api: APIClient
    public var keys: DeviceKeys
    public weak var hooks: PlatformHooks?
    public let clock: @Sendable () -> Int64
    /// Serializes the app's drain entry points (I328).
    let gate = DrainGate()

    public init(store: Store, api: APIClient, keys: DeviceKeys, hooks: PlatformHooks? = nil,
                clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) }) {
        self.store = store
        self.api = api
        self.keys = keys
        self.hooks = hooks
        self.clock = clock
        let s = store
        api.onOffset = { o in try? s.setMe("clock_offset", .int(o)) }
    }

    public enum CoreError: Error, Equatable { case noIdentity, notPinned, tooLarge, refused(String) }

    func myId() throws -> PeerId {
        guard let id = try store.me().id else { throw CoreError.noIdentity }
        return id
    }

    // MARK: signed calls

    /// A signed call with PA-ID. Applies the client-wide reply rules: 401 "unknown peer" takes
    /// the self-removed path, 401 "logged out" marks this device logged out, "push_missing"
    /// sets me.push_missing.
    public func signed(_ method: String, _ path: String, body: Data = Data(), retry: Bool = true,
                       timeout: Double = 15) async -> APIOutcome {
        guard let id = try? myId() else { return .network }
        let out = await api.call(method, path, body: body, auth: .signed(keys.signer, id), retry: retry, timeout: timeout)
        if let r = out.reply {
            if r.status == 401 && r.error == "unknown peer" {
                selfRemoved()
            } else if r.status == 401 && r.error == "logged out" {
                try? store.setMe("logged_out", .int(1))
            }
            if case .bool(true)? = r.json?["push_missing"] { try? store.setMe("push_missing", .int(1)) }
        }
        return out
    }

    /// A signed call whose body carries inner messages. On 401 "clock skew" the Worker
    /// relayed nothing: the offset is already re-synced from the reply, so the body is built
    /// again (a NEW counter n per recipient) and sent once more. On 400 "messages missing"
    /// the named ids join the allow set, the allow reconcile runs, and the call is built and
    /// retried once.
    public func signedWithMessages(_ method: String, _ path: String, build: () throws -> Data) async throws -> APIOutcome {
        var out = await signed(method, path, body: try build())
        if out.isClockSkew {
            out = await signed(method, path, body: try build())
            return out
        }
        if let r = out.reply, r.status == 400, r.error == "messages missing" {
            if case .array(let ids)? = r.json?["ids"] {
                try store.allowAdd(ids.compactMap { $0.stringValue })
            }
            await allowReconcile()
            out = await signed(method, path, body: try build())
            if out.isClockSkew { out = await signed(method, path, body: try build()) }
        }
        return out
    }

    /// Build one inner message to a pinned peer: reserve n first (one atomic increment), then
    /// encrypt.
    public func buildMessage(to id: PeerId, withKeys: Bool = false, _ content: (UInt64) throws -> MessageContent) throws -> String {
        guard let p = try store.peer(id), p.pinned, let enc = p.encPub, let pid = p.pairingId else { throw CoreError.notPinned }
        let me = try myId()
        let n = try store.reserveCounter(id)
        let keys: (Data, Data)? = withKeys ? (self.keys.signer.publicKey, self.keys.decryptor.publicKey) : nil
        return try InnerMessage.seal(InnerJSON(n: n, content: try content(n)), signer: self.keys.signer, from: me, to: id,
                                     toEncPub: enc, pairingId: pid, keys: keys)
    }

    /// Messages for every id in the allow set that has a pin (logout, login, rename, remove,
    /// delete); orphans are left to the allow reconcile.
    func allowMessages(_ content: (PeerId, UInt64) throws -> MessageContent) throws -> [PeerId: String] {
        var m: [PeerId: String] = [:]
        for t in try store.allowSet() {
            guard let id = PeerId(text: t), let p = try store.peer(id), p.pinned else { continue }
            m[id] = try buildMessage(to: id) { n in try content(id, n) }
        }
        return m
    }

    // MARK: wipe

    /// Self-removed path (catalog Removal rules, ios 11 Wipe): keys gone, pins, pairing rows,
    /// pair_cap, counters and replay rows gone; history kept.
    public func selfRemoved() {
        try? store.wipe()
        hooks?.wipeKeys()
        hooks?.removeLockedInbox()
        hooks?.removeDeliveredNotifications()
    }
}

extension Store {
    /// The DB part of the wipe (one transaction).
    public func wipe() throws {
        try db.write {
            try db.exec("UPDATE me SET removed = 1, logged_out = 0, push_missing = 0, request_token = NULL")
            try db.exec("""
                UPDATE peers SET sign_pub = NULL, enc_pub = NULL, pairing_id = NULL, fingerprint = NULL, last_n = 0,
                approve_c = NULL, approve_name = NULL, approve_name_rev = NULL, approve_result = NULL, approve_sent_at = NULL,
                state = CASE WHEN state = 'removed' THEN 'removed' ELSE 'unruled' END,
                approve_verified = 0, approve_verified_at = NULL, approve_prompt_n = 0,
                get_approves_me = NULL, get_denies_me = NULL, get_at = NULL, denied_me_msg = 0,
                logged_out = 0, logout_n = 0, name = NULL, name_n = 0, pending_name = NULL, pending_n = 0
                """)
            try db.exec("UPDATE pairing SET r = zeroblob(length(r)), c_n = zeroblob(length(c_n))")
            try db.exec("DELETE FROM pairing")
            try db.exec("DELETE FROM replay")
            try db.exec("DELETE FROM allow_set")
            try db.exec("DELETE FROM settings WHERE key = 'pair_cap'")
        }
    }
}
