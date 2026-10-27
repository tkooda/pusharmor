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

    /// The trimmed ASCII "m" a file holds, or nil when it does not read.
    public func m(of f: URL) -> String? {
        guard let d = try? Data(contentsOf: f), let s = String(data: d, encoding: .ascii) else { return nil }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The files whose "m" equals m.
    public func files(holding m: String) -> [URL] { files().filter { self.m(of: $0) == m } }

    public func removeAll() { try? FileManager.default.removeItem(at: dir) }
}

/// One drain at a time per Core (I328): the locked drain, the delivered drain and a tap
/// receive never run pushes at once in the app process. It also keeps the "m" values that
/// reached a final verdict, so a later entry point does not run them again (newest 200).
actor DrainGate {
    static let cap = 200
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var done: Set<String> = []
    private var order: [String] = []

    func acquire() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }

    func isDone(_ m: String) -> Bool { done.contains(m) }

    func markDone(_ m: String) {
        guard done.insert(m).inserted else { return }
        order.append(m)
        if order.count > DrainGate.cap { done.remove(order.removeFirst()) }
    }
}

extension Core {
    /// Runs body with the drain gate held (I328).
    func serially<T>(_ body: () async -> T) async -> T {
        await gate.acquire()
        let r = await body()
        await gate.release()
        return r
    }

    /// Locked-inbox drain (ios 7): steps 4-9 with no banner for each file in name order,
    /// rows unread; a failed file writes one unreadable event row (done by receive) and is
    /// deleted too. A fault keeps the file for the next drain (I321). Returns the number of
    /// messages received while locked, the "m" values run, which the delivered drain then
    /// skips (I313), and the "m" values held by a fault, which it neither runs nor removes.
    /// Each "m" runs at most once per pass; a second file with an "m" already run is deleted (I327),
    /// as is a file whose "m" another entry point already took to a final verdict (I328).
    public func drainLockedInbox(_ inbox: LockedInbox) async -> (count: Int, ms: Set<String>, held: Set<String>) {
        await serially { await drainLockedInboxNow(inbox) }
    }

    private func drainLockedInboxNow(_ inbox: LockedInbox) async -> (count: Int, ms: Set<String>, held: Set<String>) {
        var count = 0
        var ms: Set<String> = []
        var held: Set<String> = []
        for f in inbox.files() {
            if let m = inbox.m(of: f) {
                let seen = await gate.isDone(m)
                if seen || ms.contains(m) || held.contains(m) { try? FileManager.default.removeItem(at: f); continue }
                let r = await receive(m, mode: .drain)
                if r.fault { held.insert(m); continue }
                await gate.markDone(m)
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
    /// An "m" another entry point already took to a final verdict is removed, not run (I328).
    public func drainDelivered(_ infos: [[AnyHashable: Any]], skip: Set<String> = [], held: Set<String> = []) async -> [Int] {
        await serially {
            let key = try? TapStamp.key(store)
            var done: [Int] = []
            for (i, info) in infos.enumerated() {
                guard let m = TapStamp.drainM(info, key: key), !held.contains(m) else { continue }
                let seen = await gate.isDone(m)
                if !skip.contains(m) && !seen {
                    if await receive(m, mode: .drain).fault { continue }
                    await gate.markDone(m)
                }
                done.append(i)
            }
            return done
        }
    }

    /// A tapped notification's "m" runs steps 4-9 with no banner (TapStamp.drainM). iOS removes
    /// a tapped notification, so a fault keeps "m" in the locked inbox for the next drain (I325),
    /// in one file only. A final verdict deletes any locked-inbox copy (an NSE fault's), so the
    /// next locked drain does not run "m" again (I327). An "m" another entry point already
    /// took to a final verdict is not run again (I328).
    public func receiveTapped(_ m: String, inbox: LockedInbox) async -> ReceiveResult {
        await serially {
            if await gate.isDone(m) { return .plain(nil) }
            let r = await receive(m, mode: .drain)
            let copies = inbox.files(holding: m)
            if r.fault {
                if copies.isEmpty { try? inbox.write(m, nowMs: clock() * 1000) }
            } else {
                await gate.markDone(m)
                for f in copies { try? FileManager.default.removeItem(at: f) }
            }
            return r
        }
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
