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
    /// deleted too. A fault keeps the file for the next drain (I321). Returns the number of
    /// messages received while locked, the "m" values run, which the delivered drain then
    /// skips (I313), and the "m" values held by a fault, which it neither runs nor removes.
    public func drainLockedInbox(_ inbox: LockedInbox) async -> (count: Int, ms: Set<String>, held: Set<String>) {
        var count = 0
        var ms: Set<String> = []
        var held: Set<String> = []
        for f in inbox.files() {
            if let d = try? Data(contentsOf: f), let s = String(data: d, encoding: .ascii) {
                let m = s.trimmingCharacters(in: .whitespacesAndNewlines)
                let r = await receive(m, mode: .drain)
                if r.fault { held.insert(m); continue }
                ms.insert(m)
                if r.newMessage { count += 1 }
            } else if drop(.drain).fault {
                continue
            }
            try? FileManager.default.removeItem(at: f)
        }
        return (count, ms.subtracting(held), held)
    }

    /// Delivered-notification drain: steps 4-9 with no banner for each userInfo whose "m"
    /// the NSE did not stamp as handled (TapStamp.drainM). An "m" in skip (run by the
    /// locked-inbox drain) is not run again (I313). Returns the indexes drained; the app
    /// removes those notifications. A fault leaves the notification for the next drain (I322);
    /// an "m" in held (its locked-inbox file kept by a fault) is neither run nor removed (I321).
    public func drainDelivered(_ infos: [[AnyHashable: Any]], skip: Set<String> = [], held: Set<String> = []) async -> [Int] {
        let key = try? TapStamp.key(store)
        var done: [Int] = []
        for (i, info) in infos.enumerated() {
            guard let m = TapStamp.drainM(info, key: key), !held.contains(m) else { continue }
            if !skip.contains(m), await receive(m, mode: .drain).fault { continue }
            done.append(i)
        }
        return done
    }

    /// A tapped notification's "m" runs steps 4-9 with no banner (TapStamp.drainM). iOS removes
    /// a tapped notification, so a fault keeps "m" in the locked inbox for the next drain (I325).
    public func receiveTapped(_ m: String, inbox: LockedInbox) async -> ReceiveResult {
        let r = await receive(m, mode: .drain)
        if r.fault { try? inbox.write(m, nowMs: clock() * 1000) }
        return r
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
