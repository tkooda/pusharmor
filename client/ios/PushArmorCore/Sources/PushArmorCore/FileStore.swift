import Foundation

/// One file transfer, received (dir in) or sent (dir out), in the files table.
/// in states: pending (not downloaded), loading (a download task runs), blob (the blob
/// arrived, not yet checked), ready (size and sha256 checked), done (decrypted), failed.
/// out states: uploading, uploaded (201 reply kept), sent, failed.
public struct FileRecord: Equatable, Sendable {
    public var id: Int64 = 0
    public var dir: HistoryDir
    /// The History row of the file message (nil for a send not yet sent).
    public var historyRowid: Int64?
    public var url: String?
    public var expires: Int64?
    public var key: String
    /// The sanitized name.
    public var name: String
    /// Plaintext bytes.
    public var size: Int64
    public var sha256: String?
    public var state: String
    /// The final code (FileRules.FinalCode raw value, or "memory") of a failed file.
    public var code: String?
    /// The row or toast text of a failed file.
    public var error: String?
    /// Automatic download attempts (FileRules.Attempts).
    public var attempts: Int = 0
    public var openAt: Int64 = -1
    /// The blob failed its check once and is being downloaded again.
    public var again: Bool = false
    /// The Download button started it: its later automatic tries may use mobile data too.
    public var manual: Bool = false
    /// Bytes kept by saved resume data (0 = none).
    public var have: Int64 = 0
    /// The running transfer task: "<session identifier> <task identifier>".
    public var task: String?
    /// The last transfer reply: HTTP status (0 = none), error word, retry_after seconds.
    public var status: Int = 0
    public var replyError: String?
    public var retryAfter: Int64?
    /// Unix ms when a decrypt started; cleared on every orderly stop.
    public var decryptMark: Int64?
    /// Send only: PA-Send-ID, upload tries, recipient ids (JSON array), message id, |All| at send time.
    public var sendId: String?
    public var tries: Int = 0
    public var recipients: [String] = []
    public var msgId: String?
    public var allCount: Int = 0
    public var created: Int64

    public init(dir: HistoryDir, key: String, name: String, size: Int64, state: String, created: Int64) {
        self.dir = dir
        self.key = key
        self.name = name
        self.size = size
        self.state = state
        self.created = created
    }

    public var attemptsState: FileRules.Attempts {
        get { FileRules.Attempts(used: attempts, openAt: openAt) }
        set { attempts = newValue.used; openAt = newValue.openAt }
    }

    /// The file message value; nil until the upload reply is in.
    public var ref: FileRef? {
        guard let u = url, let e = expires, let s = sha256 else { return nil }
        return FileRef(url: u, expires: e, key: key, name: name, size: size, sha256: s)
    }

    /// Blob, resume data and decrypted file names under the files directory.
    public var blobName: String { "\(dir.rawValue)-\(id).blob" }
    public var resumeName: String { "\(dir.rawValue)-\(id).resume" }
    public var plainDirName: String { "\(dir.rawValue)-\(id)" }
}

extension Store {
    static func fileRecord(_ r: Row) -> FileRecord? {
        guard let id = r.int("id"), let dir = r.text("dir").flatMap({ HistoryDir(rawValue: $0) }), let key = r.text("key"),
              let name = r.text("name"), let size = r.int("size"), let state = r.text("state"),
              let created = r.int("created") else { return nil }
        var f = FileRecord(dir: dir, key: key, name: name, size: size, state: state, created: created)
        f.id = id
        f.historyRowid = r.int("history_rowid")
        f.url = r.text("url")
        f.expires = r.int("expires")
        f.sha256 = r.text("sha256")
        f.code = r.text("code")
        f.error = r.text("error")
        f.attempts = Int(r.int("attempts") ?? 0)
        f.openAt = r.int("open_at") ?? -1
        f.again = (r.int("again") ?? 0) != 0
        f.manual = (r.int("manual") ?? 0) != 0
        f.have = r.int("have") ?? 0
        f.task = r.text("task")
        f.status = Int(r.int("status") ?? 0)
        f.replyError = r.text("reply_error")
        f.retryAfter = r.int("retry_after")
        f.decryptMark = r.int("decrypt_mark")
        f.sendId = r.text("send_id")
        f.tries = Int(r.int("tries") ?? 0)
        if let j = r.text("recipients"), case .array(let a)? = try? StrictJSON.parse(Data(j.utf8)) {
            f.recipients = a.compactMap { $0.stringValue }
        }
        f.msgId = r.text("msg_id")
        f.allCount = Int(r.int("all_count") ?? 0)
        return f
    }

    static let fileColumns = ["dir", "history_rowid", "url", "expires", "key", "name", "size", "sha256", "state", "code",
                              "error", "attempts", "open_at", "again", "manual", "have", "task", "status", "reply_error", "retry_after",
                              "decrypt_mark", "send_id", "tries", "recipients", "msg_id", "all_count", "created"]

    static func fileValues(_ f: FileRecord) -> [SQLValue] {
        [.text(f.dir.rawValue), .opt(f.historyRowid), .opt(f.url), .opt(f.expires), .text(f.key), .text(f.name), .int(f.size),
         .opt(f.sha256), .text(f.state), .opt(f.code), .opt(f.error), .int(Int64(f.attempts)), .int(f.openAt),
         .bool(f.again), .bool(f.manual), .int(f.have), .opt(f.task), .int(Int64(f.status)), .opt(f.replyError), .opt(f.retryAfter), .opt(f.decryptMark),
         .opt(f.sendId), .int(Int64(f.tries)), .text(JOut.arr(f.recipients.map { .str($0) }).text), .opt(f.msgId),
         .int(Int64(f.allCount)), .int(f.created)]
    }

    /// Inserts the record; returns its id.
    @discardableResult
    public func addFile(_ f: FileRecord) throws -> Int64 {
        try db.write {
            let cols = Store.fileColumns
            try db.exec("INSERT INTO files (" + cols.joined(separator: ", ") + ") VALUES ("
                        + Array(repeating: "?", count: cols.count).joined(separator: ", ") + ")", Store.fileValues(f))
            return db.lastInsertRowId
        }
    }

    public func saveFile(_ f: FileRecord) throws {
        try db.exec("UPDATE files SET " + Store.fileColumns.map { $0 + " = ?" }.joined(separator: ", ") + " WHERE id = ?",
                    Store.fileValues(f) + [.int(f.id)])
    }

    public func file(_ id: Int64) throws -> FileRecord? {
        try db.one("SELECT * FROM files WHERE id = ?", [.int(id)]).flatMap(Store.fileRecord)
    }

    public func file(historyRowid: Int64) throws -> FileRecord? {
        try db.one("SELECT * FROM files WHERE history_rowid = ?", [.int(historyRowid)]).flatMap(Store.fileRecord)
    }

    public func files(dir: HistoryDir, states: [String]) throws -> [FileRecord] {
        let marks = Array(repeating: "?", count: states.count).joined(separator: ",")
        return try db.query("SELECT * FROM files WHERE dir = ? AND state IN (\(marks)) ORDER BY id",
                            [.text(dir.rawValue)] + states.map { .text($0) }).compactMap(Store.fileRecord)
    }

    public func allFiles() throws -> [FileRecord] {
        try db.query("SELECT * FROM files ORDER BY id").compactMap(Store.fileRecord)
    }

    /// A download task of file `id` ended (any process; needs only the store, no keys). It applies
    /// only while the record still waits for that very task, so a stale or second completion never
    /// overwrites a later state. blobArrived: the body is now at the record's blob name. Else
    /// `received` bytes arrived in this run and `resumable` says resume data keeps them: a run that
    /// kept bytes is not counted as an attempt.
    public func fileTaskEnded(_ id: Int64, task: String, status: Int, body: Data?, blobArrived: Bool, received: Int64 = 0,
                              resumable: Bool = false) throws {
        try db.write {
            guard var f = try file(id), f.dir == .incoming, f.state == "loading", f.task == task else { return }
            let j = body.flatMap { $0.count <= 4096 ? try? StrictJSON.parse($0) : nil }
            f.status = status
            f.replyError = j?["error"]?.stringValue
            if case .number(let t)? = j?["retry_after"] { f.retryAfter = FileRef.uint(t) } else { f.retryAfter = nil }
            f.task = nil
            if blobArrived {
                f.attemptsState = f.attemptsState.end()
                f.have = 0
                f.state = "blob"
            } else {
                let kept = resumable ? max(f.openAt, 0) + max(received, 0) : 0
                f.attemptsState = resumable && received > 0 ? f.attemptsState.stopped(have: kept) : f.attemptsState.end()
                f.have = kept
                f.state = "pending"
            }
            try saveFile(f)
        }
    }

    /// Files whose History row is gone (deleted, synced del, trimmed); returns them, so their
    /// local files can go too.
    public func dropOrphanFiles() throws -> [FileRecord] {
        try db.write {
            let gone = try db.query("SELECT * FROM files WHERE history_rowid IS NOT NULL AND history_rowid NOT IN (SELECT rowid FROM history)")
                .compactMap(Store.fileRecord)
            for f in gone { try db.exec("DELETE FROM files WHERE id = ?", [.int(f.id)]) }
            return gone
        }
    }
}
