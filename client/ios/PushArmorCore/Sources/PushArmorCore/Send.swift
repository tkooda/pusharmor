import Foundation

public struct SendReport: Sendable {
    public var sent: Int
    public var total: Int
    public var results: [String: String]
    public var lines: [String]
    public var rowid: Int64?
    public var toast: String { ([S.sentTo(sent, total)] + lines).joined(separator: "\n") }
}

extension Core {
    public enum SendError: Error, Equatable { case tooLong, tooLarge, noRecipients, clockOff, failed(Int), network, emailSendFailed }

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
        let out = try await signedWithMessages("POST", "/v1/send") {
            var m: [PeerId: String] = [:]
            for id in recipients { m[id] = try buildMessage(to: id) { _ in mc } }
            return JOut.obj([("v", .int(1)), ("m", JOut.messages(m))]).data
        }
        guard let r = out.reply else { throw SendError.network }
        if out.isClockSkew { throw SendError.clockOff }
        if r.status == 502 { throw SendError.emailSendFailed }
        guard r.ok else { throw SendError.failed(r.status) }
        var results: [String: String] = [:]
        if let rm = r.json?["r"]?.objectMembers {
            for (k, v) in rm { results[k] = v.stringValue ?? "failed" }
        }
        var sent = 0
        var lines: [String] = []
        var due = false
        for id in recipients {
            let res = results[id.text] ?? "failed"
            let p = try? store.peer(id)
            let label = PeerLabel.label(p)
            switch res {
            case "sent": sent += 1
            case "gone": lines.append(S.notDelivered(label)); due = true
            case "logged out":
                lines.append(S.signedOutPeer(label))
                try? store.db.write { if var q = try store.peer(id) { q.loggedOut = true; try store.savePeer(q) } }
                due = true
            case "unapproved", "unknown": due = true
            default: break
            }
        }
        if due { try? store.setMe("fetch_due", .int(1)) }
        let resultsJSON = JOut.obj(recipients.map { ($0.text, .str(results[$0.text] ?? "failed")) }).text
        let rowid = try? store.addMessage(dir: .outgoing, peer: recipients[0], type: type.rawValue, content: content, n: nil,
                                          pairingId: nil, read: true, results: resultsJSON, now: clock())
        return SendReport(sent: sent, total: allCount, results: results, lines: lines, rowid: rowid)
    }
}
