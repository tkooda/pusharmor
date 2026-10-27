import Foundation

/// store/locked-inbox/ (ios 6.3): M written before first unlock with no file protection;
/// no DB, no keys, no replay check. Cap 100 files: the oldest goes first.
public struct LockedInbox: Sendable {
    public static let cap = 100
    public let dir: URL

    public init(dir: URL) { self.dir = dir }

    /// Directory created at first launch with FileProtectionType.none.
    public func ensureDirectory() throws {
        var attrs: [FileAttributeKey: Any] = [:]
        #if os(iOS)
        attrs[.protectionKey] = FileProtectionType.none
        #endif
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: attrs)
    }

    /// File names in name order ($unix-ms-$random8.m sorts by arrival).
    public func files() -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasSuffix(".m") }.sorted().map { dir.appendingPathComponent($0) }
    }

    /// Store the exact ASCII string of M.
    public func write(_ m: String, nowMs: Int64) throws {
        try ensureDirectory()
        var existing = files()
        while existing.count >= LockedInbox.cap {
            try? FileManager.default.removeItem(at: existing.removeFirst())
        }
        var g = SystemRandomNumberGenerator()
        let rnd = (0 ..< 4).map { _ in String(format: "%02x", UInt8.random(in: 0 ... 255, using: &g)) }.joined()
        let name = String(format: "%013lld", nowMs) + "-" + rnd + ".m"
        var opts: Data.WritingOptions = [.atomic]
        #if os(iOS)
        opts.insert(.noFileProtection)
        #endif
        try Data(m.utf8).write(to: dir.appendingPathComponent(name), options: opts)
    }

    public func removeAll() { try? FileManager.default.removeItem(at: dir) }
}

extension Core {
    /// Locked-inbox drain (ios 7): steps 4-9 with no banner for each file in name order,
    /// rows unread; a failed file writes one unreadable event row (done by receive) and is
    /// deleted too. Returns the number of messages received while locked.
    public func drainLockedInbox(_ inbox: LockedInbox) async -> Int {
        var count = 0
        for f in inbox.files() {
            if let d = try? Data(contentsOf: f), let m = String(data: d, encoding: .ascii) {
                let r = await receive(m.trimmingCharacters(in: .whitespacesAndNewlines), mode: .drain)
                if r.newMessage { count += 1 }
            } else {
                _ = drop(.drain)
            }
            try? FileManager.default.removeItem(at: f)
        }
        return count
    }

    /// History retention: auto-delete rows older than N days (default 30).
    public func pruneHistory() throws {
        let days = Int64(try store.setting(SettingKey.historyDays) ?? "30") ?? 30
        try store.db.exec("DELETE FROM history WHERE created_local < ?", [.int(clock() - days * 86400)])
    }

    /// Delete all history (the caller also clears delivered notifications).
    public func deleteAllHistory() throws {
        try store.db.exec("DELETE FROM history")
    }
}
