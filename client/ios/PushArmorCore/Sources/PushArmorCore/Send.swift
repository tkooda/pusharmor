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
    /// del messages to the other devices; every del call is sent, even after a failure. The
    /// rows of an id chunk go as soon as every call that carried it succeeded; rows without a
    /// message id go at the end (this device only). A device whose push failed ("failed:...")
    /// gets the same chunk again after each server retry delay. If a call failed, the other
    /// rows stay and SendError throws. Else the result is the notice for devices that still
    /// did not get the del, nil when every device got it.
    @discardableResult
    public func deleteHistoryRows(_ rowids: [Int64]) async throws -> String? {
        var idOf: [Int64: String] = [:]
        for rowid in rowids { if let id = try store.historyRow(rowid)?.msgId { idOf[rowid] = id } }
        let ids = rowids.compactMap { idOf[$0] }
        var failure: Error?
        var failed: [PeerId: String] = [:]
        var targets: [PeerId] = []
        func sendDel(_ chunk: [String], to devices: [PeerId]) async throws -> [PeerId: String] {
            var words: [PeerId: String] = [:]
            for start in stride(from: 0, to: devices.count, by: Core.maxSendTargets) {
                let batch = Array(devices[start ..< min(start + Core.maxSendTargets, devices.count)])
                let out = try await signedWithMessages("POST", "/v1/send") {
                    var m: [PeerId: String] = [:]
                    for id in batch { m[id] = try buildMessage(to: id) { _ in .del(chunk) } }
                    return JOut.obj([("v", .int(1)), ("m", JOut.messages(m))]).data
                }
                guard let r = out.reply, r.ok else {
                    if out.isClockSkew { throw SendError.clockOff }
                    throw SendError.rejected(ErrorCopy.reason(from: out))
                }
                for id in batch { words[id] = r.json?["r"]?[id.text]?.stringValue ?? "failed" }
            }
            return words
        }
        var resend: [(chunk: [String], devices: [PeerId])] = []
        var last: [PeerId: String] = [:]
        if !ids.isEmpty, (try? store.boolSetting(SettingKey.syncDeletions, default: true)) ?? true {
            targets = try syncTargets()
            for chunk in try InnerJSON.delChunks(ids) {
                var accepted = true
                var again: [PeerId] = []
                for start in stride(from: 0, to: targets.count, by: Core.maxSendTargets) {
                    let batch = Array(targets[start ..< min(start + Core.maxSendTargets, targets.count)])
                    do {
                        for (id, word) in try await sendDel(chunk, to: batch) where word != "sent" {
                            if word.hasPrefix("failed:") { again.append(id); last[id] = word } else if failed[id] == nil { failed[id] = word }
                        }
                    } catch {
                        if failure == nil { failure = error }
                        accepted = false
                    }
                }
                if !again.isEmpty { resend.append((chunk, again)) }
                if accepted {
                    let gone = Set(chunk)
                    try store.db.write {
                        for rowid in rowids where gone.contains(idOf[rowid] ?? "") {
                            try store.db.exec("DELETE FROM history WHERE rowid = ?", [.int(rowid)])
                        }
                    }
                }
            }
        } else {
            idOf = [:]
        }
        try store.db.write {
            for rowid in rowids where idOf[rowid] == nil {
                try store.db.exec("DELETE FROM history WHERE rowid = ?", [.int(rowid)])
            }
        }
        for d in RetryPolicy.serverDelays where !resend.isEmpty {
            await api.sleep(d)
            var next: [(chunk: [String], devices: [PeerId])] = []
            for r in resend {
                var again: [PeerId] = []
                if let words = try? await sendDel(r.chunk, to: r.devices) {
                    for (id, word) in words where word != "sent" {
                        if word.hasPrefix("failed:") { again.append(id); last[id] = word } else if failed[id] == nil { failed[id] = word }
                    }
                } else {
                    again = r.devices
                }
                if !again.isEmpty { next.append((r.chunk, again)) }
            }
            resend = next
        }
        for r in resend { for id in r.devices where failed[id] == nil { failed[id] = last[id] ?? "failed:" } }
        if let failure = failure { throw failure }
        let names = targets.filter { failed[$0] != nil }.map { (name: PeerLabel.label(try? store.peer($0)), word: failed[$0] ?? "failed") }
        return ErrorCopy.deleteResultText(names)
    }
}
