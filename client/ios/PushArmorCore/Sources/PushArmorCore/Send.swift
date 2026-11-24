import Foundation

public struct SendReport: Sendable {
    public var sent: Int
    public var total: Int
    public var results: [String: String]
    public var lines: [String]
    public var rowid: Int64?
    /// The one chosen device's name; nil for a send to several.
    public var soleName: String? = nil
    /// True when every chosen device got the message: the short success banner.
    public var allSent: Bool { lines.isEmpty }
    public var toast: String {
        if allSent { return sent == 1 ? S.messageSentTo(soleName ?? S.aPeer) : S.messageSentTo(count: sent) }
        return ([S.sentTo(sent, total)] + lines).joined(separator: "\n")
    }
}

extension Core {
    public enum SendError: Error, Equatable { case tooLong, tooLarge, noRecipients, clockOff, rejected(ErrorCopy.Reason) }

    /// Send pipeline (ios 8.3): reserve n per recipient, build, refuse any M > 3800 before
    /// the network, POST /send, toast, History row dir out with per-recipient results.
    /// `allCount` = |All| at tap time.
    public func send(_ content: String, as type: SendType, to recipients: [PeerId], allCount: Int) async throws -> SendReport {
        guard !SizeCap.isOver(content) else { throw SendError.tooLong }
        let mc: MessageContent
        switch type {
        case .url: mc = .url(content)
        case .text: mc = .text(content)
        case .tel: mc = .tel(content)
        }
        return try await sendContent(mc, rowType: type.rawValue, rowContent: content, msgId: InnerJSON.newId(),
                                     to: recipients, allCount: allCount)
    }

    /// The send pipeline for one content message; the outgoing History row gets rowType and rowContent.
    func sendContent(_ mc: MessageContent, rowType: String, rowContent: String, msgId: String, to recipients: [PeerId],
                     allCount: Int) async throws -> SendReport {
        guard !recipients.isEmpty else { throw SendError.noRecipients }
        let out = try await signedWithMessages("POST", "/v1/send") {
            var m: [PeerId: String] = [:]
            for id in recipients { m[id] = try buildMessage(to: id, msgId: msgId) { _ in mc } }
            SendProgress.step?(SendProgress.encrypted)
            return JOut.obj([("v", .int(1)), ("m", JOut.messages(m))]).data
        }
        guard let r = out.reply, r.ok else {
            if out.isClockSkew { throw SendError.clockOff }
            throw SendError.rejected(ErrorCopy.reason(from: out))
        }
        var results: [String: String] = [:]
        if let rm = r.json?["r"]?.objectMembers {
            for (k, v) in rm { results[k] = v.stringValue ?? "failed" }
        }
        var sent = 0
        var lines: [String] = []
        var due = false
        var soleName: String?
        for id in recipients {
            let res = results[id.text] ?? "failed"
            let p = try? store.peer(id)
            let label = PeerLabel.label(p)
            if recipients.count == 1 { soleName = label }
            switch res {
            case "sent": sent += 1
            case "gone", "unapproved", "unknown": due = true
            case "logged out":
                try? store.db.write { if var q = try store.peer(id) { q.loggedOut = true; try store.savePeer(q) } }
                due = true
            case "not listening":
                try? store.db.write { if var q = try store.peer(id) { q.listening = false; try store.savePeer(q) } }
                due = true
            default: break
            }
            if let t = ErrorCopy.sendResultText(res, label) { lines.append(t) }
        }
        if due { try? store.setMe("fetch_due", .int(1)) }
        let resultsJSON = JOut.obj(recipients.map { ($0.text, .str(results[$0.text] ?? "failed")) }).text
        let rowid = try? store.addMessage(dir: .outgoing, peer: recipients[0], type: rowType, content: rowContent, n: nil,
                                          pairingId: nil, read: true, results: resultsJSON, now: clock(), msgId: msgId)
        return SendReport(sent: sent, total: allCount, results: results, lines: lines, rowid: rowid, soleName: soleName)
    }

    /// The Worker takes at most this many recipients in one POST /v1/send.
    static let maxSendTargets = 9

    /// Sync deletions targets: every other approved device of this account that approves
    /// this device, logged out and command line devices excluded.
    func syncTargets() throws -> [PeerId] {
        try store.peers().filter { $0.pinned && $0.state == .approved && $0.approvesMe && !$0.missing && !$0.loggedOut && $0.platform != "cli" }
            .map { $0.id }
    }

    /// Delete History rows. With Sync deletions on and other devices to tell, the message ids
    /// go in del messages to every other approved device (a row deleted before goes only to
    /// the devices that did not take it yet and still exist). A device whose push failed
    /// ("failed:...") gets its ids again after each server retry delay. A row goes once every
    /// device it was for took the del; else it stays with those devices pending. Rows without
    /// a message id go at once (this device only). The result is the notice naming the
    /// devices that did not take it, nil when none. `progress` gets each step.
    @discardableResult
    public func deleteHistoryRows(_ rowids: [Int64], progress: (@Sendable (DeleteProgress) async -> Void)? = nil) async throws -> String? {
        var rows: [HistoryRow] = []
        for rowid in rowids { if let r = try store.historyRow(rowid) { rows.append(r) } }
        let sync = (try? store.boolSetting(SettingKey.syncDeletions, default: true)) ?? true
        let targets = try sync ? syncTargets() : []
        let live = Set(targets.map { $0.text })
        var local: [Int64] = []
        var requested: [(row: HistoryRow, devices: [String])] = []
        var idsFor: [String: [String]] = [:]
        for row in rows {
            guard let msgId = row.msgId, !live.isEmpty else { local.append(row.rowid); continue }
            let req = row.delRequested.isEmpty ? targets.map { $0.text } : row.delRequested.filter { live.contains($0) }
            let left = req.filter { !row.delAccepted.contains($0) }
            if left.isEmpty { local.append(row.rowid); continue }
            requested.append((row, req))
            for d in left { idsFor[d, default: []].append(msgId) }
        }
        // one call per id chunk and up to maxSendTargets devices that need the same ids
        var groups: [(ids: [String], devices: [PeerId])] = []
        for t in targets {
            guard let ids = idsFor[t.text] else { continue }
            if let i = groups.firstIndex(where: { $0.ids == ids }) { groups[i].devices.append(t) } else { groups.append((ids, [t])) }
        }
        var jobs: [(chunk: [String], devices: [PeerId])] = []
        for g in groups {
            for chunk in try InnerJSON.delChunks(g.ids) {
                for start in stride(from: 0, to: g.devices.count, by: Core.maxSendTargets) {
                    jobs.append((chunk, Array(g.devices[start ..< min(start + Core.maxSendTargets, g.devices.count)])))
                }
            }
        }
        var took: [String: Set<String>] = [:]
        var failed: [String: String] = [:]
        var dropped = Set<String>()
        var callError: Error?
        func run(_ chunk: [String], _ devices: [PeerId]) async -> [PeerId] {
            do {
                let out = try await signedWithMessages("POST", "/v1/send") {
                    var m: [PeerId: String] = [:]
                    for id in devices { m[id] = try buildMessage(to: id) { _ in .del(chunk) } }
                    return JOut.obj([("v", .int(1)), ("m", JOut.messages(m))]).data
                }
                guard let r = out.reply, r.ok else {
                    if out.isClockSkew { throw SendError.clockOff }
                    throw SendError.rejected(ErrorCopy.reason(from: out))
                }
                var again: [PeerId] = []
                for id in devices {
                    let word = r.json?["r"]?[id.text]?.stringValue ?? "failed"
                    switch word {
                    case "sent": took[id.text, default: []].formUnion(chunk)
                    // a logged out or removed device drops out of the delete
                    case "logged out", "unknown": dropped.insert(id.text)
                    default:
                        if word.hasPrefix("failed:") { again.append(id) }
                        failed[id.text] = word
                    }
                }
                return again
            } catch {
                callError = error
                for id in devices { failed[id.text] = Core.delCallFailed }
                return []
            }
        }
        var resend: [(chunk: [String], devices: [PeerId])] = []
        for (i, job) in jobs.enumerated() {
            if i == 0 { await progress?(DeleteProgress(caption: DeleteProgress.other(0, jobs.count), done: 0, total: jobs.count)) }
            let again = await run(job.chunk, job.devices)
            if !again.isEmpty { resend.append((job.chunk, again)) }
            await progress?(DeleteProgress(caption: DeleteProgress.other(i + 1, jobs.count), done: i + 1, total: jobs.count))
        }
        let attempts = RetryPolicy.serverDelays.count + 1
        for (i, d) in RetryPolicy.serverDelays.enumerated() where !resend.isEmpty {
            await progress?(DeleteProgress(caption: DeleteProgress.retry(i + 2, attempts), done: jobs.count, total: jobs.count))
            await api.sleep(d)
            var next: [(chunk: [String], devices: [PeerId])] = []
            for r in resend {
                let again = await run(r.chunk, r.devices)
                if !again.isEmpty { next.append((r.chunk, again)) }
            }
            resend = next
        }
        await progress?(DeleteProgress(caption: DeleteProgress.local, done: jobs.count, total: jobs.count))
        var pending = Set<String>()
        try store.db.write {
            for rowid in local { try store.db.exec("DELETE FROM history WHERE rowid = ?", [.int(rowid)]) }
            for (row, req) in requested {
                let msgId = row.msgId ?? ""
                let keep = req.filter { !dropped.contains($0) }
                let accepted = keep.filter { row.delAccepted.contains($0) || took[$0]?.contains(msgId) == true }
                let left = keep.filter { !accepted.contains($0) }
                if left.isEmpty {
                    try store.db.exec("DELETE FROM history WHERE rowid = ?", [.int(row.rowid)])
                } else {
                    try store.setDelPending(row.rowid, requested: keep, accepted: accepted)
                    pending.formUnion(left)
                }
            }
        }
        let names = targets.filter { pending.contains($0.text) }
            .map { (name: PeerLabel.label(try? store.peer($0)), word: failed[$0.text] ?? "failed:") }
        return ErrorCopy.deleteResultText(names, error: callError)
    }

    /// The result word kept for a device whose del call failed as a whole.
    static let delCallFailed = "call failed"

    /// Pending deletes: a device that is no longer a target (removed or logged out) drops out; a row with no device left pending goes. Returns the
    /// rowids deleted.
    @discardableResult
    public func settlePendingDeletes() throws -> [Int64] {
        let rows = try store.db.query("SELECT * FROM history WHERE del_requested IS NOT NULL AND del_requested != ''").compactMap(Store.history)
        guard !rows.isEmpty else { return [] }
        let live = Set(try syncTargets().map { $0.text })
        var gone: [Int64] = []
        try store.db.write {
            for row in rows {
                let keep = row.delRequested.filter { live.contains($0) }
                if keep.allSatisfy({ row.delAccepted.contains($0) }) {
                    try store.db.exec("DELETE FROM history WHERE rowid = ?", [.int(row.rowid)])
                    gone.append(row.rowid)
                } else if keep.count != row.delRequested.count {
                    try store.setDelPending(row.rowid, requested: keep, accepted: row.delAccepted.filter { keep.contains($0) })
                }
            }
        }
        return gone
    }
}

/// One step of a delete, for the progress bar above History and its caption.
public struct DeleteProgress: Equatable, Sendable {
    public var caption: String
    /// Finished del calls of `total`.
    public var done: Int
    public var total: Int

    public static func other(_ done: Int, _ total: Int) -> String { "Deleting on your other devices (\(done) of \(total))" }
    public static func retry(_ attempt: Int, _ of: Int) -> String { "Trying again (attempt \(attempt) of \(of))" }
    public static let local = "Deleting on this device"
}
