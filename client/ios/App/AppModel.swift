import Foundation
import SwiftUI
import UIKit
import UserNotifications
import PushArmorCore

/// App state and actions for the SwiftUI screens (ios sections 5, 7-11). Every DB write is
/// one short transaction in PushArmorCore; this type only orchestrates.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case welcome                    // permission explainer
        case signIn(AuthPurpose)
        case code(email: String, purpose: AuthPurpose)
        case limitPicker
        case nameDevice
        case main
        case removed                    // "This device was removed. Sign in again"
        case banned
        case signedOut                  // "Signed out. Sign in to resume"
    }

    struct LimitEntry: Identifiable, Hashable {
        let id: String
        let platform: String
        let created: Int64
        let approves: Int
        let approvedBy: Int
        let reachable: Bool
        let paused: Bool
        let oldInstall: Bool
    }

    @Published var phase: Phase = .loading
    @Published var me: Me?
    @Published var peers: [Peer] = []
    @Published var pairings: [String: PairingEntry] = [:]
    @Published var history: [HistoryRow] = []
    @Published var toast: String?
    @Published var errorText: String?
    @Published var lockedLine: String?
    @Published var notificationsOff = false
    @Published var pushRegisterFailed = false
    @Published var limitEntries: [LimitEntry] = []
    @Published var limitTicked: Set<String> = []
    @Published var refreshGreyUntil: Date = .distantPast
    @Published var highlightPeer: String?
    @Published var showHistory = false

    let env = AppEnvironment.shared
    private(set) var core: Core?
    private var store: Store?
    var pushInfo: PushInfo?
    private var limitTicket: (ticket: String, at: Date)?
    private var requestToken: String?
    private var pendingKeys: DeviceKeys?

    var auth: AuthClient { AuthClient(api: core?.api ?? APIClient()) }

    // MARK: launch

    func start() async {
        #if DEBUG
        if ScreenshotSample.isOn {
            UNUserNotificationCenter.current().setNotificationCategories(BannerContent.categories())
            store = try? ScreenshotSample.makeStore()
            core = nil
            phase = .main
            reload()
            started = true
            await ScreenshotSample.notifyIfAsked()
            return
        }
        #endif
        do {
            try env.prepareDirectories()
            let store = try env.openStore()
            self.store = store
            if let keys = try env.keychain.bootstrap(store: store) {
                core = env.makeCore(store: store, keys: keys)
            }
        } catch {
            errorText = "\(error)"
        }
        UNUserNotificationCenter.current().setNotificationCategories(BannerContent.categories())
        UIApplication.shared.registerForRemoteNotifications()
        await checkPermission()
        await route()
        await onForeground()
        started = true
        if let t = pendingTap {
            pendingTap = nil
            await handleTap(t.info, action: t.action)
        }
    }

    /// A notification tap that arrived before start() finished; replayed after it.
    private var started = false
    private var pendingTap: (info: [AnyHashable: Any], action: String)?

    /// Which screen to show.
    func route() async {
        guard let store = store, let me = try? store.me() else { phase = .loading; return }
        self.me = me
        if notificationsOff && me.id == nil { phase = .welcome; return }
        if me.removed { phase = .removed; return }
        if me.id == nil { phase = .signIn(.register); return }
        if me.paused { phase = .signedOut; return }
        if me.name == nil { phase = .nameDevice; return }
        phase = .main
        reload()
    }

    func reload() {
        guard let store = store else { return }
        me = try? store.me()
        peers = (try? store.peers()) ?? []
        pairings = Dictionary(uniqueKeysWithValues: ((try? store.pairings()) ?? []).map { ($0.peerId.text, $0) })
        history = (try? store.history()) ?? []
    }

    /// Launch and every foreground: locked-inbox drain, delivered notifications, push
    /// reconcile, retries, timeouts, permission check.
    func onForeground() async {
        await checkPermission()
        guard let core = core, phase == .main || phase == .signedOut else { return }
        try? core.pruneHistory()
        let (n, lockedMs, held) = await core.drainLockedInbox(env.inbox)
        if n > 0 { lockedLine = S.receivedWhileLocked(n) }
        await drainDelivered(skip: lockedMs, held: held)
        if phase == .main { await core.appOpen(push: pushInfo) }
        else { await core.allowReconcile() }
        reload()
        if (try? core.store.me().removed) == true { phase = .removed }
    }

    /// getDeliveredNotifications(): each one with "m" the NSE did not stamp as handled runs
    /// steps 4-9 with no banner, then is removed (I311: a relay rowid alone does not skip it).
    /// skip: the "m" values the locked-inbox drain just ran (I313); held: those it kept after
    /// a fault, left in place (I321).
    func drainDelivered(skip: Set<String> = [], held: Set<String> = []) async {
        guard let core = core else { return }
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let drained = await core.drainDelivered(delivered.map { $0.request.content.userInfo }, skip: skip, held: held)
        let done = drained.map { delivered[$0].request.identifier }
        if !done.isEmpty { center.removeDeliveredNotifications(withIdentifiers: done) }
    }

    // MARK: notifications and push token

    func requestNotifications() async {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        await checkPermission()
        await route()
    }

    func checkPermission() async {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        notificationsOff = s.authorizationStatus == .denied || s.alertSetting == .disabled
    }

    func openNotificationSettings() {
        if let u = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(u) }
    }

    /// The APNs environment from embedded.mobileprovision (ios 5.2).
    static func pushType() -> PushInfo.Kind {
        #if targetEnvironment(simulator)
        return APNsEnvironment.pushType(fileFound: false, env: nil, isSimulator: true)
        #else
        let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
        let data = url.flatMap { try? Data(contentsOf: $0) }
        return APNsEnvironment.pushType(fileFound: data != nil, env: data.flatMap(APNsEnvironment.apsEnvironment), isSimulator: false)
        #endif
    }

    func didRegister(token: Data) async {
        pushRegisterFailed = false
        pushInfo = PushInfo(type: AppModel.pushType(), tokenBytes: token)
        if let core = core, phase == .main { await core.reconcilePush(pushInfo) }
    }

    func didFailToRegister() { pushRegisterFailed = true }

    func retryPushRegistration() {
        pushRegisterFailed = false
        UIApplication.shared.registerForRemoteNotifications()
    }

    // MARK: sign-in

    /// Keys first (section 3): every flow binds to sha256(sign_pub).
    func keysForSignIn(_ purpose: AuthPurpose) throws -> DeviceKeys {
        if purpose != .register, let c = core { return c.keys }
        if let k = pendingKeys { return k }
        env.keychain.deleteAll()
        let k = try env.keychain.create()
        pendingKeys = k
        return k
    }

    func nonce(_ purpose: AuthPurpose) throws -> String {
        Ids.oauthNonce(purpose: purpose.rawValue, signPub: try keysForSignIn(purpose).signer.publicKey)
    }

    func emailStart(_ email: String, purpose: AuthPurpose, turnstile: String) async {
        guard Ids.normalizeEmail(email) != nil else { errorText = S.badEmail; return }
        guard let k = try? keysForSignIn(purpose) else { return }
        switch await auth.emailStart(email: email, signPub: k.signer.publicKey, purpose: purpose, turnstile: turnstile) {
        case .requestToken(let t):
            requestToken = t
            try? store?.setMe("request_token", .text(t))
            phase = .code(email: email, purpose: purpose)
        case .badEmail: errorText = S.badEmail
        case .emailSendFailed: errorText = S.emailSendFailed
        case .rateLimited(let s): errorText = "Try again in \(s) s"
        default: errorText = "Sign-in failed"
        }
    }

    func emailVerify(_ code: String, purpose: AuthPurpose) async {
        guard let t = requestToken ?? (try? store?.me().requestToken) ?? nil else { phase = .signIn(purpose); return }
        await finishTicket(await auth.emailVerify(requestToken: t, code: code), purpose: purpose)
    }

    func appleToken(idToken: String, code: String?, purpose: AuthPurpose) async {
        guard let k = try? keysForSignIn(purpose) else { return }
        await finishTicket(await auth.appleToken(idToken: idToken, signPub: k.signer.publicKey, purpose: purpose, code: code), purpose: purpose)
    }

    func googleToken(idToken: String, purpose: AuthPurpose) async {
        guard let k = try? keysForSignIn(purpose) else { return }
        await finishTicket(await auth.googleToken(idToken: idToken, signPub: k.signer.publicKey, purpose: purpose), purpose: purpose)
    }

    func finishTicket(_ r: AuthResult, purpose: AuthPurpose) async {
        guard case .ticket(let ticket, let email) = r else {
            errorText = r == .badEmail ? S.badEmail : "Sign-in failed"
            return
        }
        try? store?.setMe("signed_in_email", .text(email))
        switch purpose {
        case .register: await register(ticket: ticket, evict: [])
        case .unpause: await unpause(ticket: ticket)
        case .deleteAccount: await deleteAccount(ticket: ticket)
        }
    }

    func register(ticket: String, evict: [String]) async {
        guard let store = store, let keys = pendingKeys ?? core?.keys else { return }
        let c = env.makeCore(store: store, keys: keys)
        core = c
        switch await c.register(ticket: ticket, push: pushInfo, evict: evict) {
        case .registered(let id):
            pendingKeys = nil
            try? env.keychain.savePeerId(id)
            limitTicket = nil
            await route()
        case .peerLimit(let t, let list):
            limitTicket = (t, Date())
            let old = try? store.me().oldId
            limitEntries = list.compactMap { e in
                guard let id = e["id"]?.stringValue else { return nil }
                func int(_ k: String) -> Int { if case .number(let s)? = e[k] { return Int(s) ?? 0 }; return 0 }
                func bool(_ k: String) -> Bool { if case .bool(let b)? = e[k] { return b }; return false }
                return LimitEntry(id: id, platform: e["platform"]?.stringValue ?? "", created: Int64(int("created")),
                                  approves: int("approves"), approvedBy: int("approved_by"), reachable: bool("reachable"),
                                  paused: bool("paused"), oldInstall: id == old)
            }
            phase = .limitPicker
        case .idCollision:
            // new keys, retry once
            env.keychain.deleteAll()
            if let k = try? env.keychain.create() {
                pendingKeys = k
                core = env.makeCore(store: store, keys: k)
                if case .registered(let id) = await core!.register(ticket: ticket, push: pushInfo, evict: evict) {
                    pendingKeys = nil
                    try? env.keychain.savePeerId(id)
                    await route()
                    return
                }
            }
            errorText = "Sign-in failed"
        case .banned: phase = .banned
        case .ticketExpired: errorText = S.signInExpired; phase = .signIn(.register)
        case .failed, .network: errorText = "Sign-in failed"
        }
    }

    /// Limit picker submit: after 10 min the ticket is expired; ticks are kept.
    func submitEvict() async {
        guard let t = limitTicket else { return }
        if Date().timeIntervalSince(t.at) > 600 {
            errorText = S.signInExpired
            phase = .signIn(.register)
            return
        }
        await register(ticket: t.ticket, evict: Array(limitTicked))
    }

    func cancelLimit() {
        limitTicket = nil
        phase = .signIn(.register)
    }

    func setName(_ name: String) async {
        guard let core = core, NameEntry.isValidName(name) else { errorText = "Use 1 to 32 plain ASCII characters."; return }
        if (try? core.store.me().name) == nil {
            try? core.store.setMe("name", .text(name))
        } else {
            _ = try? await core.rename(name)
        }
        await route()
    }

    func unpause(ticket: String) async {
        guard let core = core else { return }
        _ = try? await core.unpause(ticket: ticket, push: pushInfo)
        await route()
    }

    func signOut() async {
        guard let core = core else { return }
        _ = try? await core.pause()
        await route()
    }

    func deleteAccount(ticket: String) async {
        guard let core = core else { return }
        if let out = try? await core.deleteAccount(ticket: ticket), out.reply?.ok == true {
            phase = .removed
        } else {
            errorText = "Delete failed, try again"
        }
    }

    // MARK: peers and pairing

    func label(_ p: Peer) -> String { PeerLabel.label(p) }

    func pair(_ p: Peer) async { _ = try? await core?.startPair(p.id); reload() }
    func sendAgain(_ p: Peer) async { _ = await core?.sendAgain(p.id); reload() }
    func reply(_ p: Peer) async { _ = await core?.tapReply(p.id); reload() }
    func cancelPairing(_ p: Peer) async { await core?.cancelPairing(p.id); reload() }
    func remove(_ p: Peer) async { _ = try? await core?.removePeer(p.id); reload() }
    func localDelete(_ p: Peer) async { await core?.localDelete(p.id); reload() }
    func setHidden(_ p: Peer, _ h: Bool) { try? core?.setHidden(p.id, h); reload() }
    func setPeerSwitches(_ p: Peer, lockShow: Bool? = nil, alwaysHide: Bool? = nil) {
        try? core?.setPeerSwitches(p.id, lockShow: lockShow, alwaysHide: alwaysHide)
        reload()
    }

    func approve(_ p: Peer) async -> ApproveOutcome? {
        let r = await core?.approve(p.id)
        // the app removes the reply notice once N shows the fingerprint
        reload()
        return r
    }

    func approveSendAgain(_ p: Peer) async { _ = await core?.postApprove(p.id, fresh: false); reload() }

    func deny(_ p: Peer) async { _ = await core?.deny(p.id); reload() }

    func refresh() async {
        guard Date() >= refreshGreyUntil, let core = core else { return }
        refreshGreyUntil = Date().addingTimeInterval(60)
        await core.refresh(push: pushInfo)
        reload()
    }

    /// A tap on a greyed (removed, missing or unreachable) row is a fetch trigger.
    func tapGreyed() async {
        await core?.fetchPeers()
        reload()
    }

    /// Remove the "Pairing fingerprint ready" notice once the fingerprint shows (pk).
    func fingerprintShown(_ p: Peer) {
        guard let me = me?.id else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [PairingCrypto.pairingKey(nId: me, xId: p.id)])
    }

    func countdown(_ e: PairingEntry) -> String? { Pairing.countdown(startedAt: e.startedAt, now: Int64(Date().timeIntervalSince1970)) }

    func hintLine(_ e: PairingEntry, _ p: Peer) -> String? { core?.hintLine(e, peer: p) }

    func canSendAgain(_ e: PairingEntry) -> Bool { core?.canSendAgain(e) ?? false }

    /// Without Core only screenshot mode runs the same rule on the loaded pairings.
    func offersCancel(_ p: Peer) -> Bool {
        if let core { return core.offersCancel(p) }
        #if DEBUG
        // Screenshot mode runs with no Core and still shows the footer.
        if ScreenshotSample.isOn { return pairings[p.id.text] != nil || p.notPairedOnPeer }
        #endif
        // No Core (it failed to start): Cancel pairing would do nothing, so it is not offered.
        return false
    }

    var allSet: [Peer] { peers.filter { $0.inAll } }

    var showAllOption: Bool { (try? store?.boolSetting(SettingKey.showAll, default: true)) ?? true }

    // MARK: send

    func send(_ text: String, asText: Bool, toAll: Bool, peerIds: [String]) async {
        guard let core = core else { return }
        let type: SendType = asText ? .text : SendDetection.detect(text)
        let all = allSet
        let ids = toAll ? all.map { $0.id } : peerIds.compactMap { PeerId(text: $0) }
        do {
            let rep = try await core.send(text, as: type, to: ids, allCount: all.count)
            toast = rep.toast
        } catch Core.SendError.clockOff {
            toast = S.clockOff
        } catch Core.SendError.emailSendFailed {
            toast = S.emailSendFailed
        } catch Core.SendError.tooLong {
            toast = SizeCap.label(text)
        } catch {
            toast = "Not sent, try again"
        }
        reload()
    }

    // MARK: history

    func markRead(_ row: HistoryRow) {
        try? store?.db.exec("UPDATE history SET read = 1 WHERE rowid = ?", [.int(row.rowid)])
        reload()
    }

    func deleteRow(_ row: HistoryRow) {
        try? store?.db.exec("DELETE FROM history WHERE rowid = ?", [.int(row.rowid)])
        reload()
    }

    func deleteAllHistory() {
        try? core?.deleteAllHistory()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        reload()
    }

    /// Tap on a url: re-check the parsed scheme, then open it directly.
    func open(_ row: HistoryRow) {
        markRead(row)
        guard row.dir == .incoming, row.type == "url", let u = URL(string: row.content), URLRule.isOpenable(u) else { return }
        UIApplication.shared.open(u)
    }

    // MARK: settings

    func boolSetting(_ k: String, _ d: Bool) -> Bool { (try? store?.boolSetting(k, default: d)) ?? d }
    func setBool(_ k: String, _ v: Bool) { try? store?.setSetting(k, v ? "1" : "0"); objectWillChange.send() }
    var historyDays: Int { Int((try? store?.setting(SettingKey.historyDays)) ?? nil ?? "30") ?? 30 }
    func setHistoryDays(_ d: Int) { try? store?.setSetting(SettingKey.historyDays, String(d)); objectWillChange.send() }

    func rename(_ name: String) async {
        guard let core = core else { return }
        do {
            _ = try await core.rename(name)
        } catch {
            errorText = "Use 1 to 32 plain ASCII characters."
        }
        reload()
    }

    /// Notification tap routing (section 10).
    func handleTap(_ info: [AnyHashable: Any], action: String) async {
        if !started { pendingTap = (info, action); return }
        let key = store.flatMap { try? TapStamp.key($0) }
        if let m = TapStamp.drainM(info, key: key), let core = core {
            _ = await core.receiveTapped(m, inbox: env.inbox)
            reload()
        }
        // routing keys count only with the NSE stamp (I297); relay userInfo is ignored
        let stamped = TapStamp.verified(info, key: key)
        let rowid = stamped ? (info["rowid"] as? NSNumber)?.int64Value : nil
        let row = rowid.flatMap { r in history.first { $0.rowid == r } }
        if action == "COPY", let r = row {
            UIPasteboard.general.string = r.content
            return
        }
        switch stamped ? info["tap"] as? String : nil {
        case "url": if let r = row { open(r) }
        case "peers": highlightPeer = info["peer"] as? String
        case "history": showHistory = true
        case "detail": if let r = row { markRead(r); detailRow = r }
        default: break
        }
    }

    @Published var detailRow: HistoryRow?
}
