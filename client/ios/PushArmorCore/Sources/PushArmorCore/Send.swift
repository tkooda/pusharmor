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
        guard !recipients.isEmpty else { throw SendError.noRecipients }
        let mc: MessageContent
        switch type {
        case .url: mc = .url(content)
        case .text: mc = .text(content)
        case .tel: mc = .tel(content)
        }
        let msgId = InnerJSON.newId()
        let out = try await signedWithMessages("POST", "/v1/send") {
            var m: [PeerId: String] = [:]
            for id in recipients { m[id] = try buildMessage(to: id, msgId: msgId) { _ in mc } }
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
        let rowid = try? store.addMessage(dir: .outgoing, peer: recipients[0], type: type.rawValue, content: content, n: nil,
                                          pairingId: nil, read: true, results: resultsJSON, now: clock(), msgId: msgId)
        return SendReport(sent: sent, total: allCount, results: results, lines: lines, rowid: rowid, soleName: soleName)
    }

    /// The Worker takes at most this many recipients in one POST /v1/send.
    static let maxSendTargets = 9

    /// Sync deletions targets: every other approved device of this account that approves
    /// this device, command line devices excluded.
    func syncTargets() throws -> [PeerId] {
        try store.peers().filter { $0.pinned && $0.state == .approved && $0.approvesMe && !$0.missing && $0.platform != "cli" }
            .map { $0.id }
    }

    /// Delete History rows. With Sync deletions on, the message ids of the rows go first in
    /// del messages to the other devices; the rows are deleted only after every POST /v1/send
    /// succeeded. A failure throws SendError and keeps the rows. Rows without a message id
    /// are deleted on this device only.
    public func deleteHistoryRows(_ rowids: [Int64]) async throws {
        let ids = try rowids.compactMap { try store.historyRow($0)?.msgId }
        if !ids.isEmpty, (try? store.boolSetting(SettingKey.syncDeletions, default: true)) ?? true {
            let targets = try syncTargets()
            for chunk in try InnerJSON.delChunks(ids) {
                for start in stride(from: 0, to: targets.count, by: Core.maxSendTargets) {
                    let batch = Array(targets[start ..< min(start + Core.maxSendTargets, targets.count)])
                    let out = try await signedWithMessages("POST", "/v1/send") {
                        var m: [PeerId: String] = [:]
                        for id in batch { m[id] = try buildMessage(to: id) { _ in .del(chunk) } }
                        return JOut.obj([("v", .int(1)), ("m", JOut.messages(m))]).data
                    }
                    guard let r = out.reply, r.ok else {
                        if out.isClockSkew { throw SendError.clockOff }
                        throw SendError.rejected(ErrorCopy.reason(from: out))
                    }
                }
            }
        }
        try store.db.write {
            for id in rowids { try store.db.exec("DELETE FROM history WHERE rowid = ?", [.int(id)]) }
        }
    }
}
