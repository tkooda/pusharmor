import Foundation

public enum ReceiveMode: Sendable {
    /// Notification Service Extension: banner, one try for pair sends (8 s cap).
    case nse
    /// App drain of the locked inbox or delivered notifications: no banner.
    case drain
    /// A "c" returned by POST /approve: never a push, no banner, no event, no Invalid.
    case returnedC
}

public struct ReceiveResult: Sendable {
    public var banner: Banner?
    public var rowid: Int64?
    /// The step 8-9 transaction committed (serviceExtensionTimeWillExpire then delivers
    /// the banner).
    public var committed: Bool
    /// A url/text/tel row was written (drain counts these).
    public var newMessage: Bool
    /// An approve (pushed or returned) verified in this run.
    public var approveVerified: Bool

    static func plain(_ b: Banner?) -> ReceiveResult {
        ReceiveResult(banner: b, rowid: nil, committed: false, newMessage: false, approveVerified: false)
    }
}

extension Core {
    var lockSettings: (show: Bool, always: Bool) {
        ((try? store.boolSetting(SettingKey.lockShow, default: true)) ?? true,
         (try? store.boolSetting(SettingKey.alwaysHide, default: false)) ?? false)
    }

    /// The 6.2 banner for a History message row.
    public func banner(forRow row: HistoryRow) -> Banner {
        let pid = row.peerId.flatMap { PeerId(text: $0) }
        let peer = pid.flatMap { try? store.peer($0) }
        let ls = lockSettings
        let body = LockScreen.body(mainShow: ls.show, peerShow: peer?.lockShow ?? true, mainAlwaysHide: ls.always,
                                   peerAlwaysHide: peer?.alwaysHide ?? false, locked: hooks?.isProtectedDataLocked() ?? false,
                                   peerName: peer?.noticeName ?? S.aPeer, content: row.content)
        let cat: BannerCategory
        let tap: Banner.Tap
        switch row.type {
        case "url": cat = .url; tap = .openURL(row.content)
        case "tel": cat = .tel; tap = .detail
        default: cat = .text; tap = .detail
        }
        return Banner(body: body, locKey: nil, category: cat, threadId: pid.map(Banner.peerThread) ?? Banner.dropThread,
                      rowid: row.rowid, tap: tap)
    }

    func noticeBanner(_ body: String, peer: PeerId?, category: BannerCategory, thread: String? = nil, tap: Banner.Tap) -> Banner {
        Banner(body: body, locKey: nil, category: category, threadId: thread ?? peer.map(Banner.peerThread) ?? Banner.dropThread,
               rowid: nil, tap: tap)
    }

    /// A drop: event row (when the DB is readable) and the could-not-read banner.
    func drop(_ mode: ReceiveMode, peer: PeerId? = nil, invalid: Bool = false) -> ReceiveResult {
        if mode == .returnedC { return .plain(nil) }
        let now = clock()
        _ = try? store.addEvent(invalid ? .invalid : .couldNotRead, peer: peer, content: invalid ? S.invalid : S.dropped, now: now)
        return .plain(mode == .nse ? (invalid ? .invalid : .dropped) : nil)
    }

    /// Steps 1 and 3-10 of ios 6.1 (step 2, the key load, is done by the caller).
    public func receive(_ m: String, mode: ReceiveMode) async -> ReceiveResult {
        // step 1
        guard m.utf8.count <= InnerMessage.maxWire, B64URL.isStrict(m) else { return drop(mode) }
        // step 3
        guard let me = try? store.me(), let myId = me.id, !me.removed else { return drop(mode) }
        if m.utf8.count == PairMessage.wireLength {
            if mode == .returnedC { return .plain(nil) }
            return await receivePair(m, me: myId, mode: mode)
        }
        return receiveInner(m, me: myId, mode: mode)
    }

    struct Applied {
        var banner: Banner?
        var rowid: Int64?
        var newMessage = false
        var approveVerified = false
        var selfRemoved = false
    }

    func receiveInner(_ m: String, me: PeerId, mode: ReceiveMode) -> ReceiveResult {
        let now = clock()
        let store = self.store
        do {
            let (r, applied) = try store.db.write { () -> (ReceivePipeline.Result, Applied?) in
                let r = ReceivePipeline.run(
                    m: m, me: me, key: keys.decryptor,
                    pin: { id in
                        guard let p = try? store.peer(id), p.pinned else { return nil }
                        return PinState(id: id, signPub: p.signPub!, encPub: p.encPub!, pairingId: p.pairingId!, ruling: p.state)
                    },
                    window: { id in
                        guard let p = try? store.peer(id), let rp = try? store.replay(id), rp.pairingId == p.pairingId else { return nil }
                        return rp.window
                    },
                    hasHistory: { id, n in
                        guard let p = try? store.peer(id), let pid = p.pairingId else { return false }
                        return (try? store.historyRow(peer: id, pairingId: pid, n: n)) != nil
                    })
                guard r.outcome == .accept else { return (r, nil) }
                return (r, try apply(r, me: me, mode: mode, now: now))
            }
            switch r.outcome {
            case .accept:
                guard let a = applied else { return drop(mode) }
                if a.selfRemoved { hooks?.wipeKeys(); hooks?.removeLockedInbox(); hooks?.removeDeliveredNotifications() }
                return ReceiveResult(banner: mode == .nse ? a.banner : nil, rowid: a.rowid, committed: true,
                                     newMessage: a.newMessage, approveVerified: a.approveVerified)
            case .invalid:
                return drop(mode, peer: r.verifiedFrom, invalid: true)
            case .represent:
                guard mode == .nse, let from = r.verifiedFrom, let j = r.json, let pid = r.pairingId,
                      let row = try? store.historyRow(peer: from, pairingId: pid, n: j.n) else { return .plain(nil) }
                return ReceiveResult(banner: banner(forRow: row), rowid: row.rowid, committed: true, newMessage: false,
                                     approveVerified: false)
            case .noop:
                guard mode == .nse, let from = r.verifiedFrom, let j = r.json else { return .plain(nil) }
                let p = try? store.peer(from)
                return .plain(controlBanner(j.content, peer: p, name: r.name, me: me))
            case .unreadable:
                if let u = r.unknownFrom, mode != .returnedC, (try? store.peer(u)) == nil {
                    try? store.setMe("fetch_due", .int(1))
                }
                return drop(mode, peer: r.verifiedFrom)
            }
        } catch {
            return drop(mode)
        }
    }

    /// The banner a control type shows (also re-presented for a seen-n duplicate).
    func controlBanner(_ c: MessageContent, peer p: Peer?, name: String?, me: PeerId) -> Banner? {
        let id = p?.id
        let nm = p?.noticeName ?? S.aPeer
        switch c {
        case .approve: return noticeBanner(S.approved(p?.state == .approved ? nm : S.aPeer), peer: id, category: .event, tap: .peers(id?.text))
        case .rename: return noticeBanner(S.renamed(nm, name ?? nm), peer: id, category: .event, tap: .peers(id?.text))
        case .remove(let t): return noticeBanner(t == me.text ? S.thisDeviceRemoved : S.peerListChanged, peer: id, category: .event, tap: .peers(nil))
        case .delete: return noticeBanner(S.accountDeleted, peer: id, category: .event, tap: .peers(nil))
        case .deny: return noticeBanner(S.denied(nm), peer: id, category: .notice, tap: .history)
        case .pause: return noticeBanner(S.pausedReceiving(nm), peer: id, category: .notice, tap: .history)
        case .unpause: return noticeBanner(S.resumedReceiving(nm), peer: id, category: .notice, tap: .history)
        case .url, .text, .tel: return nil
        }
    }

    /// Step 9: the acceptance table, inside the step 8 transaction.
    func apply(_ r: ReceivePipeline.Result, me: PeerId, mode: ReceiveMode, now: Int64) throws -> Applied? {
        guard let from = r.verifiedFrom, let j = r.json, let w = r.windowAfter, let pid = r.pairingId,
              var p = try store.peer(from) else { return nil }
        try store.saveReplay(from, pairingId: pid, window: w)
        p.missing = false
        var a = Applied()
        switch j.content {
        case .url(let s), .text(let s), .tel(let s):
            var type = "text", content = s
            if case .url = j.content, let u = URLRule.parse(s) { type = "url"; content = u.href }
            if case .tel = j.content, PhoneDetection.isPhone(s) { type = "tel" }
            try store.savePeer(p)
            let rowid = try store.addMessage(dir: .incoming, peer: from, type: type, content: content, n: j.n, pairingId: pid,
                                             read: false, results: nil, now: now)
            a.rowid = rowid
            a.newMessage = true
            if let row = try store.historyRow(rowid) { a.banner = banner(forRow: row) }
            return a
        case .approve(let f):
            guard let name = r.name else { return nil }
            if p.state == .approved {
                if !p.approveVerified {
                    p.approveVerified = true
                    p.approveVerifiedAt = now
                    a.approveVerified = true
                    try store.deletePairing(from)   // the entry ends when X's approve verifies
                }
                if Int64(f.n) > p.nameN { p.name = name; p.nameN = Int64(f.n) }
            } else if Int64(f.n) > p.pendingN {
                p.pendingName = name
                p.pendingN = Int64(f.n)
            }
            try store.savePeer(p)
        case .rename(let f):
            guard let name = r.name else { return nil }
            let old = p.noticeName
            if Int64(f.n) > p.nameN { p.name = name; p.nameN = Int64(f.n) }
            try store.savePeer(p)
            a.banner = noticeBanner(S.renamed(old, name), peer: from, category: .event, tap: .peers(from.text))
            return a
        case .remove(let t):
            try store.savePeer(p)
            if t == me.text {
                try store.wipe()
                a.selfRemoved = true
            } else if let tid = PeerId(text: t) {
                if try store.peer(tid) == nil {
                    var np = Peer(id: tid)
                    np.state = .removed
                    try store.savePeer(np)
                } else {
                    try store.dropPin(tid, state: .removed)
                }
            }
        case .delete:
            try store.savePeer(p)
            try store.wipe()
            a.selfRemoved = true
        case .pause, .unpause:
            var paused = false
            if case .pause = j.content { paused = true }
            if Int64(j.n) > p.pauseN {
                p.paused = paused
                p.pauseN = Int64(j.n)
                try store.addEvent(paused ? .paused : .resumed, peer: from,
                                   content: paused ? S.pausedReceiving(p.noticeName) : S.resumedReceiving(p.noticeName), now: now)
            }
            try store.savePeer(p)
        case .deny:
            p.deniedMeMsg = true
            try store.savePeer(p)
            try store.addEvent(.denied, peer: from, content: S.denied(p.noticeName), now: now)
        }
        a.banner = controlBanner(j.content, peer: try store.peer(from) ?? p, name: r.name, me: me)
        return a
    }
}
