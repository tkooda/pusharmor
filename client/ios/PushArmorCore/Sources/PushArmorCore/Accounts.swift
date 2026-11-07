import Foundation

/// The key items of the active account and of archived accounts (the Keychain on iOS).
public protocol AccountKeyVault: AnyObject {
    /// Copies the active key items to the archive of `account`, replacing an older copy.
    /// The active items stay.
    func archiveKeys(account: String) throws
    /// Replaces the active key items with the archived copy of `account`; nil removes them.
    func activateKeys(account: String?) throws
    /// Removes the archived copy of `account`.
    func dropArchivedKeys(account: String)
    /// Removes every archived copy, whatever the account.
    func dropAllArchivedKeys()
}

/// Several accounts on one device, one active at a time. The active account is the usual
/// store and key items, so an existing install needs no migration. An inactive account is
/// archived per account id (the first 12 characters of its peer id) with a hash of its
/// email kept for matching. Device-level state (the push token, the tap key, the update
/// notice) stays global.
public struct Accounts {
    public enum SwitchError: Error, Equatable { case signedIn, noArchive }

    public enum LoginOutcome: Equatable, Sendable {
        case loggedIn
        /// The login was for another account: this device switched to it; log in again.
        case switched(ErrorCopy.Reason)
        case failed(ErrorCopy.Reason)
    }

    public let store: Store
    public let vault: AccountKeyVault

    public init(store: Store, vault: AccountKeyVault) {
        self.store = store
        self.vault = vault
    }

    /// Tables of one account: every row moves with a switch.
    static let slotTables = ["me", "peers", "pairing", "replay", "history", "allow_set", "settings"]
    /// Settings keys of the device, not of an account.
    static let deviceSettings = [TapStamp.settingKey]

    public static func accountId(_ id: PeerId) -> String { String(id.text.prefix(12)) }

    static func validAccount(_ s: String) -> Bool {
        s.utf8.count == 12 && s.utf8.allSatisfy { c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c == 0x2d || c == 0x5f
        }
    }

    private func hasArchive() throws -> Bool {
        try store.db.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive'") != nil
    }

    /// The archive's stand-in for a normalized address: hex of the email hash of its mailbox key.
    /// The archive holds no plain address.
    static func emailKey(_ normalized: String) -> String { hexHash(Ids.mailboxKey(normalized)) }

    /// An earlier version hashed the plain normalized address; lookups still accept it.
    static func legacyEmailKey(_ normalized: String) -> String { hexHash(normalized) }

    private static func hexHash(_ s: String) -> String {
        Ids.emailHash(normalized: s).map { String(format: "%02x", $0) }.joined()
    }

    /// Hashes a plain address an earlier version left in the archive, in its column and in its saved rows.
    private func hashPlain() throws {
        for r in try store.db.query("SELECT account, email, data FROM archive WHERE email LIKE '%@%'") {
            guard let a = r.text("account"), let e = r.text("email") else { continue }
            var data = r.blob("data")
            if let d = data, var t = try? JSONDecoder().decode([String: [[String: Cell]]].self, from: d) {
                t["me"] = t["me"]?.map { var m = $0; m["signed_in_email"] = .n; return m }
                data = try JSONEncoder().encode(t)
            }
            try store.db.exec("UPDATE archive SET email = ?, data = ? WHERE account = ?",
                              [.text(Accounts.emailKey(Ids.normalizeEmail(e) ?? e)), .blob(data ?? Data()), .text(a)])
        }
    }

    /// The archived account of this address, never the active one; the newest wins.
    public func archived(email: String) throws -> String? {
        guard let n = Ids.normalizeEmail(email), !n.isEmpty, try hasArchive() else { return nil }
        try hashPlain()
        let active = try store.me().id.map(Accounts.accountId) ?? ""
        return try store.db.one("SELECT account FROM archive WHERE (email = ? OR email = ?) AND account != ? ORDER BY rowid DESC LIMIT 1",
                                [.text(Accounts.emailKey(n)), .text(Accounts.legacyEmailKey(n)), .text(active)])?.text("account")
    }

    public func isArchived(_ account: String) throws -> Bool {
        guard try hasArchive() else { return false }
        let active = try store.me().id.map(Accounts.accountId) ?? ""
        guard account != active else { return false }
        return try store.db.one("SELECT account FROM archive WHERE account = ?", [.text(account)]) != nil
    }

    /// Switch while the active account is logged out, removed, or has none: the active one
    /// is archived (keys that never got an id are kept under a made-up name), then `account` is loaded
    /// from the archive, or nil starts a new empty account. One store transaction; a
    /// failure keeps every copy and restores the active key items.
    public func switchTo(_ account: String?) throws {
        let me = try store.me()
        if me.id != nil && !me.removed && !me.loggedOut { throw SwitchError.signedIn }
        let from = me.id.map(Accounts.accountId)
        // a removed account has no keys left
        let keepKeys = from != nil && !me.removed
        if keepKeys, let f = from { try vault.archiveKeys(account: f) }
        // keys with no id: the register reply may have been lost, so the relay server may know them; they are kept
        else if from == nil && !me.removed { try vault.archiveKeys(account: "unreg-" + UUID().uuidString) }
        var activated = false
        do {
            try store.db.write {
                try store.db.exec("CREATE TABLE IF NOT EXISTS archive (account TEXT PRIMARY KEY, email TEXT, data BLOB NOT NULL)")
                if let f = from {
                    try store.db.exec("INSERT OR REPLACE INTO archive (account, email, data) VALUES (?, ?, ?)",
                                      [.text(f), .opt(me.signedInEmail.flatMap(Ids.normalizeEmail).map(Accounts.emailKey)), .blob(try dump())])
                }
                try clearActive()
                if let t = account {
                    guard let d = try store.db.one("SELECT data FROM archive WHERE account = ?", [.text(t)])?.blob("data") else {
                        throw SwitchError.noArchive
                    }
                    try load(d)
                    try store.db.exec("DELETE FROM archive WHERE account = ?", [.text(t)])
                }
                // an unfinished sign-in step belongs to the keys it was made with
                try store.setMe("request_token", .null)
                for k in ["code_email", "code_purpose", KeyBootstrap.registerKeysSetting] { try store.setSetting(k, nil) }
                // no old page copy of the pairing secrets stays in pa.sqlite-wal
                store.db.checkpointAfterCommit = true
                activated = true
                try vault.activateKeys(account: account)
            }
        } catch {
            if activated, keepKeys, let f = from { try? vault.activateKeys(account: f) }
            throw error
        }
        if let t = account { vault.dropArchivedKeys(account: t) }
    }

    /// Every row of the active account, as JSON.
    func dump() throws -> Data {
        var t: [String: [[String: Cell]]] = [:]
        for name in Accounts.slotTables {
            var rows = try store.db.query("SELECT * FROM \(name)")
            if name == "settings" { rows = rows.filter { !Accounts.deviceSettings.contains($0.text("key") ?? "") } }
            t[name] = rows.map {
                var m = $0.values.mapValues(Cell.init)
                if name == "me" { m["signed_in_email"] = .n } // the archive holds no plain address
                return m
            }
        }
        return try JSONEncoder().encode(t)
    }

    /// Empties the active account; device settings stay.
    func clearActive() throws {
        try store.db.exec("UPDATE pairing SET r = zeroblob(length(r)), c_n = zeroblob(length(c_n))")
        for name in Accounts.slotTables where name != "settings" { try store.db.exec("DELETE FROM \(name)") }
        let marks = Accounts.deviceSettings.map { _ in "?" }.joined(separator: ", ")
        try store.db.exec("DELETE FROM settings WHERE key NOT IN (\(marks))", Accounts.deviceSettings.map { .text($0) })
        try store.db.exec("INSERT INTO me (k) VALUES (1)")
    }

    /// Loads an archived account into the emptied active one. Only columns the table has
    /// are written.
    func load(_ d: Data) throws {
        let t = try JSONDecoder().decode([String: [[String: Cell]]].self, from: d)
        for name in Accounts.slotTables {
            let cols = Set(try store.db.query("PRAGMA table_info(\(name))").compactMap { $0.text("name") })
            for row in t[name] ?? [] {
                let kv = row.filter { cols.contains($0.key) }.sorted { $0.key < $1.key }
                guard !kv.isEmpty else { continue }
                let names = kv.map { $0.key }
                try store.db.exec("INSERT OR REPLACE INTO \(name) (\(names.joined(separator: ", "))) VALUES (\(names.map { _ in "?" }.joined(separator: ", ")))",
                                  kv.map { $0.value.sql })
            }
        }
    }

    // MARK: sign-in

    /// Email sign-in, before the code is requested: an address of an archived account
    /// switches to it; another address while this device has an account switches to a new
    /// one (register). Returns the purpose to use and whether the account changed.
    public func beforeEmail(_ email: String, purpose: AuthPurpose) throws -> (purpose: AuthPurpose, switched: Bool) {
        let me = try store.me()
        guard purpose != .deleteAccount, let n = Ids.normalizeEmail(email), !n.isEmpty,
              me.id == nil || me.removed || me.loggedOut,
              me.signedInEmail.flatMap(Ids.normalizeEmail) != n else { return (purpose, false) }
        if let x = try archived(email: n) {
            try switchTo(x)
            return (try store.me().removed ? .register : .login, true)
        }
        guard me.id != nil else { return (purpose, false) }
        try switchTo(nil)
        return (.register, true)
    }

    /// The login was refused with 401 "account mismatch" naming `account`: switch to it
    /// (archived, or a new one) and return the reason to show. nil: no switch possible.
    public func afterMismatch(account: String?, ticketEmail: String) throws -> ErrorCopy.Reason? {
        guard let x = account, Accounts.validAccount(x), !ticketEmail.isEmpty else { return nil }
        let me = try store.me()
        if me.id.map(Accounts.accountId) == x { return nil }
        try switchTo(try isArchived(x) ? x : nil)
        return .otherLogin(email: ticketEmail)
    }

    /// Log in again on a logged-out account. The ticket email is kept on success; a ticket
    /// for another account switches to that account for the next login.
    public func login(core: Core, ticket: String, email: String, push: PushInfo?) async -> LoginOutcome {
        let out: APIOutcome
        do {
            out = try await core.login(ticket: ticket, push: push)
        } catch {
            return .failed(ErrorCopy.reason(local: error))
        }
        if out.reply?.ok == true {
            if !email.isEmpty { try? store.setMe("signed_in_email", .text(email)) }
            return .loggedIn
        }
        guard let r = out.reply, r.status == 401, r.error == "account mismatch" else { return .failed(ErrorCopy.reason(from: out)) }
        do {
            guard let reason = try afterMismatch(account: r.json?["account"]?.stringValue, ticketEmail: email) else {
                return .failed(.otherAccount)
            }
            return .switched(reason)
        } catch {
            return .failed(ErrorCopy.reason(local: error))
        }
    }

    /// Register: a ticket for the address of an archived account does not register; this
    /// device switches to that account and the reason to show is returned. nil: register.
    public func beforeRegister(ticketEmail: String) throws -> ErrorCopy.Reason? {
        guard let x = try archived(email: ticketEmail) else { return nil }
        try switchTo(x)
        return .otherLogin(email: ticketEmail)
    }

    /// Delete account: a ticket for another address than this device's account makes no
    /// relay server call. nil when the account was deleted, else the reason to show.
    public func deleteAccount(core: Core, ticket: String, email: String) async -> ErrorCopy.Reason? {
        if let a = try? store.me().signedInEmail, let n = Ids.normalizeEmail(a), !n.isEmpty,
           let t = Ids.normalizeEmail(email), !t.isEmpty, n != t {
            return .deleteOtherAccount(email: email)
        }
        if !email.isEmpty { try? store.setMe("signed_in_email", .text(email)) }
        do {
            let out = try await core.deleteAccount(ticket: ticket)
            return out.reply?.ok == true ? nil : ErrorCopy.reason(from: out)
        } catch {
            return ErrorCopy.reason(local: error)
        }
    }
}

/// One stored column value of an archived account.
enum Cell: Codable, Equatable {
    case i(Int64), t(String), b(Data), n

    init(_ v: SQLValue) {
        switch v {
        case .int(let x): self = .i(x)
        case .text(let x): self = .t(x)
        case .blob(let x): self = .b(x)
        case .null: self = .n
        }
    }

    var sql: SQLValue {
        switch self {
        case .i(let x): return .int(x)
        case .t(let x): return .text(x)
        case .b(let x): return .blob(x)
        case .n: return .null
        }
    }
}
