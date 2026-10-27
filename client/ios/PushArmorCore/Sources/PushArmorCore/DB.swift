import Foundation
#if canImport(SQLite3)
import SQLite3
#elseif canImport(CSQLite)
import CSQLite
#endif

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public enum SQLValue: Equatable, Sendable {
    case int(Int64)
    case text(String)
    case blob(Data)
    case null

    public static func bool(_ b: Bool) -> SQLValue { .int(b ? 1 : 0) }
    public static func opt(_ s: String?) -> SQLValue { s.map { .text($0) } ?? .null }
    public static func opt(_ d: Data?) -> SQLValue { d.map { .blob($0) } ?? .null }
    public static func opt(_ i: Int64?) -> SQLValue { i.map { .int($0) } ?? .null }
}

public struct Row: Sendable {
    public let values: [String: SQLValue]
    public func int(_ k: String) -> Int64? {
        if case .int(let v)? = values[k] { return v }
        return nil
    }
    public func text(_ k: String) -> String? {
        if case .text(let v)? = values[k] { return v }
        return nil
    }
    public func blob(_ k: String) -> Data? {
        switch values[k] {
        case .blob(let v)?: return v
        case .null?: return nil
        default: return nil
        }
    }
    public func bool(_ k: String) -> Bool { (int(k) ?? 0) != 0 }
}

public enum DBError: Error, Equatable {
    case open(String)
    case sql(Int32, String)
}

/// A small SQLite wrapper (section 2 Concurrency): WAL, busy_timeout 2 s, every write is one
/// short BEGIN IMMEDIATE transaction; never hold a transaction across a network call.
public final class DB: @unchecked Sendable {
    let handle: OpaquePointer
    private let lock = NSRecursiveLock()
    private var depth = 0

    public init(path: String) throws {
        var h: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &h, flags, nil) == SQLITE_OK, let h = h else {
            throw DBError.open(path)
        }
        handle = h
        sqlite3_busy_timeout(h, 2000)
        try exec("PRAGMA journal_mode=WAL")
        try Schema.migrate(self)
    }

    deinit { sqlite3_close_v2(handle) }

    private func err(_ rc: Int32) -> DBError { DBError.sql(rc, String(cString: sqlite3_errmsg(handle))) }

    /// One BEGIN IMMEDIATE transaction; nested calls join the outer one.
    public func write<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        if depth > 0 {
            depth += 1
            defer { depth -= 1 }
            return try body()
        }
        try exec("BEGIN IMMEDIATE")
        depth = 1
        do {
            let r = try body()
            depth = 0
            try exec("COMMIT")
            return r
        } catch {
            depth = 0
            try? exec("ROLLBACK")
            throw error
        }
    }

    public func exec(_ sql: String, _ args: [SQLValue] = []) throws {
        _ = try query(sql, args)
    }

    public var changes: Int { Int(sqlite3_changes(handle)) }
    public var lastInsertRowId: Int64 { sqlite3_last_insert_rowid(handle) }

    @discardableResult
    public func query(_ sql: String, _ args: [SQLValue] = []) throws -> [Row] {
        lock.lock()
        defer { lock.unlock() }
        var st: OpaquePointer?
        let rc = sqlite3_prepare_v2(handle, sql, -1, &st, nil)
        guard rc == SQLITE_OK, let s = st else { throw err(rc) }
        defer { sqlite3_finalize(s) }
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case .int(let v): sqlite3_bind_int64(s, idx, v)
            case .text(let v): sqlite3_bind_text(s, idx, v, -1, SQLITE_TRANSIENT)
            case .blob(let v):
                _ = v.withUnsafeBytes { p in
                    sqlite3_bind_blob(s, idx, p.baseAddress ?? UnsafeRawPointer(bitPattern: 1), Int32(v.count), SQLITE_TRANSIENT)
                }
            case .null: sqlite3_bind_null(s, idx)
            }
        }
        var rows: [Row] = []
        while true {
            let r = sqlite3_step(s)
            if r == SQLITE_DONE { break }
            guard r == SQLITE_ROW else { throw err(r) }
            var vals: [String: SQLValue] = [:]
            for c in 0 ..< sqlite3_column_count(s) {
                let name = String(cString: sqlite3_column_name(s, c))
                switch sqlite3_column_type(s, c) {
                case SQLITE_INTEGER: vals[name] = .int(sqlite3_column_int64(s, c))
                case SQLITE_TEXT: vals[name] = .text(String(cString: sqlite3_column_text(s, c)))
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(s, c))
                    if let p = sqlite3_column_blob(s, c), n > 0 {
                        vals[name] = .blob(Data(bytes: p, count: n))
                    } else {
                        vals[name] = .blob(Data())
                    }
                default: vals[name] = .null
                }
            }
            rows.append(Row(values: vals))
        }
        return rows
    }

    public func one(_ sql: String, _ args: [SQLValue] = []) throws -> Row? { try query(sql, args).first }
}

/// One migration list owned by PushArmorCore (section 2 DB tables).
enum Schema {
    static let migrations: [String] = [
        """
        CREATE TABLE me (
          k INTEGER PRIMARY KEY CHECK (k = 1),
          id TEXT, sign_pub BLOB, enc_pub BLOB,
          clock_offset INTEGER NOT NULL DEFAULT 0,
          last_push_sha256 TEXT,
          push_missing INTEGER NOT NULL DEFAULT 0,
          removed INTEGER NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          last_fetch_at INTEGER NOT NULL DEFAULT 0,
          fetch_due INTEGER NOT NULL DEFAULT 0,
          signed_in_email TEXT,
          name TEXT,
          name_rev INTEGER NOT NULL DEFAULT 0,
          old_id TEXT,
          request_token TEXT
        );
        CREATE TABLE peers (
          id TEXT PRIMARY KEY,
          list_sign_pub BLOB, list_enc_pub BLOB,
          sign_pub BLOB, enc_pub BLOB,
          state TEXT NOT NULL DEFAULT 'unruled',
          missing INTEGER NOT NULL DEFAULT 0,
          listed INTEGER NOT NULL DEFAULT 0,
          approve_verified INTEGER NOT NULL DEFAULT 0,
          approve_verified_at INTEGER,
          get_approves_me INTEGER, get_denies_me INTEGER, get_at INTEGER,
          denied_me_msg INTEGER NOT NULL DEFAULT 0,
          reachable INTEGER NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          pause_n INTEGER NOT NULL DEFAULT 0,
          platform TEXT, created INTEGER,
          name TEXT, name_n INTEGER NOT NULL DEFAULT 0,
          pending_name TEXT, pending_n INTEGER NOT NULL DEFAULT 0,
          hidden INTEGER NOT NULL DEFAULT 0,
          lock_show INTEGER NOT NULL DEFAULT 1,
          always_hide INTEGER NOT NULL DEFAULT 0,
          last_n INTEGER NOT NULL DEFAULT 0,
          pairing_id BLOB,
          fingerprint TEXT,
          approve_c TEXT, approve_name TEXT, approve_name_rev INTEGER,
          approve_result TEXT, approve_sent_at INTEGER,
          approve_prompt_n INTEGER NOT NULL DEFAULT 0,
          note TEXT
        );
        CREATE TABLE pairing (
          peer_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          state TEXT NOT NULL,
          r BLOB,
          c_n BLOB,
          authorized INTEGER NOT NULL DEFAULT 0,
          unsent INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          not_before INTEGER NOT NULL DEFAULT 0,
          last_send_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE replay (
          peer_id TEXT PRIMARY KEY,
          pairing_id BLOB NOT NULL,
          h INTEGER NOT NULL,
          bitmap BLOB NOT NULL
        );
        CREATE TABLE history (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          dir TEXT NOT NULL,
          peer_id TEXT,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          n INTEGER,
          pairing_id BLOB,
          read INTEGER NOT NULL DEFAULT 0,
          results TEXT,
          event TEXT,
          count INTEGER NOT NULL DEFAULT 1,
          created_local INTEGER NOT NULL
        );
        CREATE INDEX history_msg ON history(peer_id, pairing_id, n);
        CREATE TABLE allow_set (id TEXT PRIMARY KEY);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO me (k) VALUES (1);
        """,
    ]

    static func migrate(_ db: DB) throws {
        try db.write {
            let v = Int(try db.one("PRAGMA user_version")?.int("user_version") ?? 0)
            for (i, m) in migrations.enumerated() where i >= v {
                for stmt in m.components(separatedBy: ";\n") where !stmt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    try db.exec(stmt)
                }
            }
            if v < migrations.count { try db.exec("PRAGMA user_version = \(migrations.count)") }
        }
    }
}
