import Foundation

public struct Me: Sendable {
    public var id: PeerId?
    public var signPub: Data?
    public var encPub: Data?
    public var clockOffset: Int64
    public var lastPushSha256: String?
    public var pushMissing: Bool
    public var removed: Bool
    public var loggedOut: Bool
    public var lastFetchAt: Int64
    public var fetchDue: Bool
    public var signedInEmail: String?
    public var name: String?
    public var nameRev: Int64
    public var oldId: String?
    public var requestToken: String?
}

public enum PeerState: String, Sendable { case unruled, approved, denied, removed }

public struct Peer: Sendable {
    public var id: PeerId
    public var listSignPub: Data?
    public var listEncPub: Data?
    public var signPub: Data?      // pinned by a pairing
    public var encPub: Data?       // pinned by a pairing
    public var state: PeerState
    public var missing: Bool
    public var listed: Bool
    public var approveVerified: Bool
    public var approveVerifiedAt: Int64?
    public var getApprovesMe: Bool?
    public var getDeniesMe: Bool?
    public var getAt: Int64?
    public var deniedMeMsg: Bool
    public var reachable: Bool
    public var loggedOut: Bool
    public var logoutN: Int64
    /// False for a "cli" device that has not run its listen command recently: send only.
    public var listening: Bool
    public var platform: String?
    public var created: Int64?
    public var name: String?
    public var nameN: Int64
    public var pendingName: String?
    public var pendingN: Int64
    public var hidden: Bool
    public var lockShow: Bool
    public var showContent: Bool
    public var lastN: Int64
    public var pairingId: Data?
    public var fingerprint: String?
    public var approveC: String?
    public var approveName: String?
    public var approveNameRev: Int64?
    public var approveResult: String?
    public var approveSentAt: Int64?
    public var approvePromptN: Int64
    public var note: String?

    public var pinned: Bool { signPub != nil && encPub != nil && pairingId != nil }

    /// A GET fetched after X's approve verified (an older GET never counts).
    public var getAfterVerify: Bool {
        guard approveVerified, let g = getAt, let v = approveVerifiedAt else { return false }
        return g > v
    }

    /// approves_me as the client trusts it: a verified approve, unless a GET fetched after
    /// it shows approves_me false.
    public var approvesMe: Bool { approveVerified && !(getAfterVerify && getApprovesMe == false) }

    /// "Not paired on $X" / "Rejected by $X": pinned, X's approve verified, and a later GET
    /// shows approves_me false.
    public var notPairedOnPeer: Bool { pinned && getAfterVerify && getApprovesMe == false }
    public var declinedByPeer: Bool { notPairedOnPeer && getDeniesMe == true }

    /// Member of "All" (catalog Pairing flow, the one definition).
    public var inAll: Bool { pinned && state == .approved && approvesMe && !hidden && !loggedOut && !missing && listening }

    /// A send target on the Send screen: approves me, listed, and listening.
    public var canReceive: Bool { approvesMe && !missing && listening }

    /// $name / $X in notices: the peer name if known, else "A device".
    public var noticeName: String { name ?? "A device" }

    init(id: PeerId) {
        self.id = id
        state = .unruled
        missing = false; listed = false; approveVerified = false; deniedMeMsg = false
        reachable = false; loggedOut = false; logoutN = 0; listening = true; nameN = 0; pendingN = 0
        hidden = false; lockShow = true; showContent = true; lastN = 0; approvePromptN = 0
    }
}

public struct PairingEntry: Sendable, Equatable {
    public var peerId: PeerId
    public var role: PairDecide.Role
    public var state: PairDecide.State
    public var r: Data?
    public var cN: Data?
    public var authorized: Bool
    public var unsent: Bool
    public var startedAt: Int64
    public var notBefore: Int64
    public var lastSendAt: Int64
}

public enum HistoryDir: String, Sendable { case incoming = "in", outgoing = "out" }

public enum HistoryEvent: String, Sendable {
    case couldNotRead = "could_not_read"
    case invalid
    case denied
    case loggedOut = "logged_out"
    case loggedIn = "logged_in"
}

public struct HistoryRow: Sendable {
    public var rowid: Int64
    public var dir: HistoryDir
    public var peerId: String?
    public var type: String          // url | text | tel | event
    public var content: String
    public var n: Int64?
    public var pairingId: Data?
    public var read: Bool
    public var results: String?
    public var event: HistoryEvent?
    public var count: Int64
    public var createdLocal: Int64
}

/// Typed access to pa.sqlite.
public final class Store: @unchecked Sendable {
    public let db: DB
    public init(db: DB) { self.db = db }
    public convenience init(path: String) throws { self.init(db: try DB(path: path)) }

    // MARK: me

    public func me() throws -> Me {
        let r = try db.one("SELECT * FROM me WHERE k = 1")!
        return Me(id: r.text("id").flatMap { PeerId(text: $0) }, signPub: r.blob("sign_pub"), encPub: r.blob("enc_pub"),
                  clockOffset: r.int("clock_offset") ?? 0, lastPushSha256: r.text("last_push_sha256"),
                  pushMissing: r.bool("push_missing"), removed: r.bool("removed"), loggedOut: r.bool("logged_out"),
                  lastFetchAt: r.int("last_fetch_at") ?? 0, fetchDue: r.bool("fetch_due"),
                  signedInEmail: r.text("signed_in_email"), name: r.text("name"), nameRev: r.int("name_rev") ?? 0,
                  oldId: r.text("old_id"), requestToken: r.text("request_token"))
    }

    public func setMe(_ column: String, _ v: SQLValue) throws {
        precondition(column.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" })
        try db.exec("UPDATE me SET \(column) = ? WHERE k = 1", [v])
    }

    // MARK: settings

    public func setting(_ key: String) throws -> String? { try db.one("SELECT value FROM settings WHERE key = ?", [.text(key)])?.text("value") }

    public func setSetting(_ key: String, _ value: String?) throws {
        if let v = value {
            try db.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [.text(key), .text(v)])
        } else {
            try db.exec("DELETE FROM settings WHERE key = ?", [.text(key)])
        }
    }

    public func boolSetting(_ key: String, default d: Bool) throws -> Bool {
        guard let v = try setting(key) else { return d }
        return v == "1"
    }

    // MARK: peers

    static func peer(_ r: Row) -> Peer {
        var p = Peer(id: PeerId(text: r.text("id")!)!)
        p.listSignPub = r.blob("list_sign_pub"); p.listEncPub = r.blob("list_enc_pub")
        p.signPub = r.blob("sign_pub"); p.encPub = r.blob("enc_pub")
        p.state = PeerState(rawValue: r.text("state") ?? "unruled") ?? .unruled
        p.missing = r.bool("missing"); p.listed = r.bool("listed")
        p.approveVerified = r.bool("approve_verified"); p.approveVerifiedAt = r.int("approve_verified_at")
        p.getApprovesMe = r.int("get_approves_me").map { $0 != 0 }
        p.getDeniesMe = r.int("get_denies_me").map { $0 != 0 }
        p.getAt = r.int("get_at"); p.deniedMeMsg = r.bool("denied_me_msg")
        p.reachable = r.bool("reachable"); p.loggedOut = r.bool("logged_out"); p.logoutN = r.int("logout_n") ?? 0
        p.listening = r.bool("listening")
        p.platform = r.text("platform"); p.created = r.int("created")
        p.name = r.text("name"); p.nameN = r.int("name_n") ?? 0
        p.pendingName = r.text("pending_name"); p.pendingN = r.int("pending_n") ?? 0
        p.hidden = r.bool("hidden"); p.lockShow = r.bool("lock_show"); p.showContent = r.bool("show_content")
        p.lastN = r.int("last_n") ?? 0; p.pairingId = r.blob("pairing_id"); p.fingerprint = r.text("fingerprint")
        p.approveC = r.text("approve_c"); p.approveName = r.text("approve_name"); p.approveNameRev = r.int("approve_name_rev")
        p.approveResult = r.text("approve_result"); p.approveSentAt = r.int("approve_sent_at")
        p.approvePromptN = r.int("approve_prompt_n") ?? 0; p.note = r.text("note")
        return p
    }

    public func peer(_ id: PeerId) throws -> Peer? {
        try db.one("SELECT * FROM peers WHERE id = ?", [.text(id.text)]).map(Store.peer)
    }

    public func peers() throws -> [Peer] {
        try db.query("SELECT * FROM peers ORDER BY created, id").map(Store.peer)
    }

    public func savePeer(_ p: Peer) throws {
        var cols: [(String, SQLValue)] = []
        cols.append(("id", .text(p.id.text)))
        cols.append(("list_sign_pub", .opt(p.listSignPub)))
        cols.append(("list_enc_pub", .opt(p.listEncPub)))
        cols.append(("sign_pub", .opt(p.signPub)))
        cols.append(("enc_pub", .opt(p.encPub)))
        cols.append(("state", .text(p.state.rawValue)))
        cols.append(("missing", .bool(p.missing)))
        cols.append(("listed", .bool(p.listed)))
        cols.append(("approve_verified", .bool(p.approveVerified)))
        cols.append(("approve_verified_at", .opt(p.approveVerifiedAt)))
        cols.append(("get_approves_me", p.getApprovesMe.map { .bool($0) } ?? .null))
        cols.append(("get_denies_me", p.getDeniesMe.map { .bool($0) } ?? .null))
        cols.append(("get_at", .opt(p.getAt)))
        cols.append(("denied_me_msg", .bool(p.deniedMeMsg)))
        cols.append(("reachable", .bool(p.reachable)))
        cols.append(("logged_out", .bool(p.loggedOut)))
        cols.append(("logout_n", .int(p.logoutN)))
        cols.append(("listening", .bool(p.listening)))
        cols.append(("platform", .opt(p.platform)))
        cols.append(("created", .opt(p.created)))
        cols.append(("name", .opt(p.name)))
        cols.append(("name_n", .int(p.nameN)))
        cols.append(("pending_name", .opt(p.pendingName)))
        cols.append(("pending_n", .int(p.pendingN)))
        cols.append(("hidden", .bool(p.hidden)))
        cols.append(("lock_show", .bool(p.lockShow)))
        cols.append(("show_content", .bool(p.showContent)))
        cols.append(("last_n", .int(p.lastN)))
        cols.append(("pairing_id", .opt(p.pairingId)))
        cols.append(("fingerprint", .opt(p.fingerprint)))
        cols.append(("approve_c", .opt(p.approveC)))
        cols.append(("approve_name", .opt(p.approveName)))
        cols.append(("approve_name_rev", .opt(p.approveNameRev)))
        cols.append(("approve_result", .opt(p.approveResult)))
        cols.append(("approve_sent_at", .opt(p.approveSentAt)))
        cols.append(("approve_prompt_n", .int(p.approvePromptN)))
        cols.append(("note", .opt(p.note)))
        let names = cols.map { $0.0 }
        let colList: String = names.joined(separator: ", ")
        let marks: String = names.map { _ in "?" }.joined(separator: ", ")
        let sets: String = names.dropFirst().map { (n: String) -> String in n + " = excluded." + n }.joined(separator: ", ")
        let sql = "INSERT INTO peers (\(colList)) VALUES (\(marks)) ON CONFLICT(id) DO UPDATE SET \(sets)"
        try db.exec(sql, cols.map { $0.1 })
    }

    public func deletePeer(_ id: PeerId) throws {
        try db.exec("DELETE FROM peers WHERE id = ?", [.text(id.text)])
    }

    /// Reserve counter n for a recipient: one BEGIN IMMEDIATE increment shared by every
    /// process, BEFORE any encrypt (section 3).
    public func reserveCounter(_ id: PeerId) throws -> UInt64 {
        try db.write {
            try db.exec("UPDATE peers SET last_n = last_n + 1 WHERE id = ? AND pairing_id IS NOT NULL", [.text(id.text)])
            guard db.changes == 1, let n = try db.one("SELECT last_n FROM peers WHERE id = ?", [.text(id.text)])?.int("last_n")
            else { throw StoreError.notPinned }
            return UInt64(n)
        }
    }

    /// Pin a peer's keys after a pairing: counter 0, fresh replay window with the pairing id.
    public func pin(_ id: PeerId, signPub: Data, encPub: Data, pairingId: Data, fingerprint: String) throws {
        try db.write {
            var p = try peer(id) ?? Peer(id: id)
            p.signPub = signPub; p.encPub = encPub; p.pairingId = pairingId; p.fingerprint = fingerprint
            p.lastN = 0; p.approveVerified = false; p.approveVerifiedAt = nil; p.note = nil
            p.approveC = nil; p.approveName = nil; p.approveNameRev = nil; p.approveResult = nil; p.approveSentAt = nil
            p.approvePromptN = 0; p.pendingName = nil; p.pendingN = 0; p.name = nil; p.nameN = 0; p.deniedMeMsg = false
            p.logoutN = 0
            if p.state == .removed { p.state = .unruled }
            try savePeer(p)
            try saveReplay(id, pairingId: pairingId, window: ReplayWindow())
        }
    }

    /// Drop the pin, pairing id, counter and replay window for a peer (Cancel pairing,
    /// timeout, local Delete, remove). Ruling goes back to unruled unless `state` is given.
    public func dropPin(_ id: PeerId, state: PeerState = .unruled) throws {
        try db.write {
            guard var p = try peer(id) else { return }
            p.signPub = nil; p.encPub = nil; p.pairingId = nil; p.fingerprint = nil; p.lastN = 0
            p.approveVerified = false; p.approveVerifiedAt = nil
            p.approveC = nil; p.approveName = nil; p.approveNameRev = nil; p.approveResult = nil; p.approveSentAt = nil
            p.pendingName = nil; p.pendingN = 0; p.approvePromptN = 0
            p.state = state
            try savePeer(p)
            try db.exec("DELETE FROM replay WHERE peer_id = ?", [.text(id.text)])
            try deletePairing(id)
        }
    }

    // MARK: replay

    public func replay(_ id: PeerId) throws -> (pairingId: Data, window: ReplayWindow)? {
        guard let r = try db.one("SELECT * FROM replay WHERE peer_id = ?", [.text(id.text)]),
              let pid = r.blob("pairing_id"), let h = r.int("h"), let b = r.blob("bitmap"),
              let w = ReplayWindow(h: UInt64(h), blob: b) else { return nil }
        return (pid, w)
    }

    public func saveReplay(_ id: PeerId, pairingId: Data, window: ReplayWindow) throws {
        try db.exec("INSERT INTO replay (peer_id, pairing_id, h, bitmap) VALUES (?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET pairing_id = excluded.pairing_id, h = excluded.h, bitmap = excluded.bitmap",
                    [.text(id.text), .blob(pairingId), .int(Int64(window.h)), .blob(window.blob)])
    }

    // MARK: pairing

    static func entry(_ r: Row) -> PairingEntry {
        PairingEntry(peerId: PeerId(text: r.text("peer_id")!)!, role: PairDecide.Role(rawValue: r.text("role")!)!,
                     state: PairDecide.State(rawValue: r.text("state")!)!, r: r.blob("r"), cN: r.blob("c_n"),
                     authorized: r.bool("authorized"), unsent: r.bool("unsent"), startedAt: r.int("started_at") ?? 0,
                     notBefore: r.int("not_before") ?? 0, lastSendAt: r.int("last_send_at") ?? 0)
    }

    public func pairing(_ id: PeerId) throws -> PairingEntry? {
        try db.one("SELECT * FROM pairing WHERE peer_id = ?", [.text(id.text)]).map(Store.entry)
    }

    public func pairings() throws -> [PairingEntry] {
        try db.query("SELECT * FROM pairing ORDER BY started_at").map(Store.entry)
    }

    public func savePairing(_ e: PairingEntry) throws {
        try db.exec("""
            INSERT INTO pairing (peer_id, role, state, r, c_n, authorized, unsent, started_at, not_before, last_send_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET role = excluded.role,
            state = excluded.state, r = excluded.r, c_n = excluded.c_n, authorized = excluded.authorized,
            unsent = excluded.unsent, started_at = excluded.started_at, not_before = excluded.not_before,
            last_send_at = excluded.last_send_at
            """, [.text(e.peerId.text), .text(e.role.rawValue), .text(e.state.rawValue), .opt(e.r), .opt(e.cN),
                  .bool(e.authorized), .bool(e.unsent), .int(e.startedAt), .int(e.notBefore), .int(e.lastSendAt)])
    }

    /// Ends an entry: r and c_N are zeroed first, then the row is deleted.
    public func deletePairing(_ id: PeerId) throws {
        try db.write {
            try db.exec("UPDATE pairing SET r = zeroblob(length(r)), c_n = zeroblob(length(c_n)) WHERE peer_id = ?", [.text(id.text)])
            try db.exec("DELETE FROM pairing WHERE peer_id = ?", [.text(id.text)])
        }
    }

    // MARK: pair_cap (settings key, list of unix seconds)

    public func capTimestamps() throws -> [Int64] {
        (try setting("pair_cap") ?? "").split(separator: ",").compactMap { Int64($0) }
    }

    public func appendCap(_ t: Int64) throws {
        let keep = try capTimestamps().filter { t - $0 < PairDecide.capWindow } + [t]
        try setSetting("pair_cap", keep.map(String.init).joined(separator: ","))
    }

    // MARK: allow set

    public func allowSet() throws -> Set<String> {
        Set(try db.query("SELECT id FROM allow_set").compactMap { $0.text("id") })
    }

    public func allowAdd(_ ids: [String]) throws {
        try db.write { for i in ids { try db.exec("INSERT OR IGNORE INTO allow_set (id) VALUES (?)", [.text(i)]) } }
    }

    public func allowRemove(_ id: String) throws {
        try db.exec("DELETE FROM allow_set WHERE id = ?", [.text(id)])
    }

    public func allowReplace(_ ids: [String]) throws {
        try db.write {
            try db.exec("DELETE FROM allow_set")
            for i in ids { try db.exec("INSERT OR IGNORE INTO allow_set (id) VALUES (?)", [.text(i)]) }
        }
    }

    // MARK: history

    static func history(_ r: Row) -> HistoryRow {
        HistoryRow(rowid: r.int("rowid")!, dir: HistoryDir(rawValue: r.text("dir")!)!, peerId: r.text("peer_id"),
                   type: r.text("type")!, content: r.text("content")!, n: r.int("n"), pairingId: r.blob("pairing_id"),
                   read: r.bool("read"), results: r.text("results"), event: r.text("event").flatMap(HistoryEvent.init(rawValue:)),
                   count: r.int("count") ?? 1, createdLocal: r.int("created_local")!)
    }

    public func history() throws -> [HistoryRow] {
        try db.query("SELECT * FROM history ORDER BY rowid DESC").map(Store.history)
    }

    public func historyRow(_ rowid: Int64) throws -> HistoryRow? {
        try db.one("SELECT * FROM history WHERE rowid = ?", [.int(rowid)]).map(Store.history)
    }

    public func historyRow(peer: PeerId, pairingId: Data, n: UInt64) throws -> HistoryRow? {
        try db.one("SELECT * FROM history WHERE dir = 'in' AND peer_id = ? AND pairing_id = ? AND n = ?",
                   [.text(peer.text), .blob(pairingId), .int(Int64(n))]).map(Store.history)
    }

    @discardableResult
    public func addMessage(dir: HistoryDir, peer: PeerId, type: String, content: String, n: UInt64?, pairingId: Data?,
                           read: Bool, results: String?, now: Int64) throws -> Int64 {
        try db.exec("INSERT INTO history (dir, peer_id, type, content, n, pairing_id, read, results, created_local) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [.text(dir.rawValue), .text(peer.text), .text(type), .text(content), .opt(n.map { Int64($0) }),
                     .opt(pairingId), .bool(read), .opt(results), .int(now)])
        return db.lastInsertRowId
    }

    /// Event rows are never unread. Consecutive could-not-read events merge into the newest
    /// row with a count; invalid-message events merge the same way, separately.
    @discardableResult
    public func addEvent(_ e: HistoryEvent, peer: PeerId?, content: String, now: Int64) throws -> Int64 {
        try db.write {
            if e == .couldNotRead || e == .invalid,
               let last = try db.one("SELECT rowid, event, peer_id FROM history ORDER BY rowid DESC LIMIT 1"),
               last.text("event") == e.rawValue, last.text("peer_id") == peer?.text {
                let id = last.int("rowid")!
                try db.exec("UPDATE history SET count = count + 1, created_local = ? WHERE rowid = ?", [.int(now), .int(id)])
                return id
            }
            try db.exec("INSERT INTO history (dir, peer_id, type, content, read, event, created_local) VALUES ('in', ?, 'event', ?, 1, ?, ?)",
                        [.opt(peer?.text), .text(content), .text(e.rawValue), .int(now)])
            return db.lastInsertRowId
        }
    }
}

public enum StoreError: Error { case notPinned, noIdentity }
