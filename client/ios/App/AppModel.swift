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
        case removed                    // "This device was removed. Log in again"
        case banned
        case signedOut                  // "Logged out. Log in to resume"
        case keysBroken                 // the saved keys failed the launch check
    }

    struct LimitEntry: Identifiable, Hashable {
        let id: String
        let platform: String
        let created: Int64
        let approves: Int
        let approvedBy: Int
        let reachable: Bool
        let loggedOut: Bool
        let oldInstall: Bool
    }

    @Published var phase: Phase = .loading
    @Published var me: Me?
    @Published var peers: [Peer] = []
    @Published var pairings: [String: PairingEntry] = [:]
    @Published var history: [HistoryRow] = []
    /// The bottom banner: every transient message, success or failure. A new text
    /// clears toastIsSuccess; a successful send sets it right after.
    @Published var toast: String? { willSet { toastIsSuccess = false } }
    /// The banner shows a success check and goes after about 2 s.
    @Published var toastIsSuccess = false
    /// Only a launch failure (the store did not open) still shows as an alert.
    @Published var errorText: String?
    /// Address last sent to and when its resend countdown ends; kept while the sign-in screen is left and re-entered.
    @Published var resend = ResendGate()
    /// The relay server answered 426: this version is too old. Kept until the version changes.
    @Published var updateRequired = AppEnvironment.shared.updateRequired
    /// pa.sqlite was corrupt at launch and was recreated; shown on the log-in screen.
    @Published var repairedNotice = false
    @Published var lockedLine: String?
    @Published var notificationsOff = false
    @Published var pushRegisterFailed = false
    /// The X on the "cannot receive" banner hides it until the next app open.
    @Published var cannotReceiveDismissed = false
    @Published var limitEntries: [LimitEntry] = []
    @Published var limitTicked: Set<String> = []
    @Published var refreshGreyUntil: Date = .distantPast
    @Published var highlightPeer: String?
    @Published var showHistory = false
    /// Peer ids with a Pair again call running; their Pair again buttons are disabled.
    @Published var pairAgainBusy: Set<String> = []
    /// Keys of taps still running ("send", "pair:<id>", ...); their buttons are disabled.
    @Published var busy: Set<String> = []

    /// Runs [body] unless the same key is still running, so a second tap does not run twice.
    func once(_ key: String, _ body: () async -> Void) async {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        defer { busy.remove(key) }
        await body()
    }

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
            phase = ScreenshotSample.signIn ? .signIn(.register) : .main
            if ScreenshotSample.update { updateRequired = true }
            reload()
            if let r = ScreenshotSample.detail(history) { showHistory = true; detailRow = r }
            toast = ScreenshotSample.sentToast ?? ScreenshotSample.sendErrorToast
            toastIsSuccess = ScreenshotSample.sentOK
            sample = true
            started = true
            await ScreenshotSample.notifyIfAsked()
            return
        }
        #endif
        await open()
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

    /// Opens the store and loads the keys. A store that does not open shows plain text; keys
    /// that do not work show their own screen. The next foreground tries again.
    private func open() async {
        launchRetry = false
        launchStop = nil
        do {
            try env.prepareDirectories()
            if store == nil {
                let (store, repaired) = try await env.openStoreRepairing()
                self.store = store
                repairedNotice = repaired
            }
            if let store = store, let keys = try env.keychain.bootstrap(store: store) {
                core = env.makeCore(store: store, keys: keys)
            }
        } catch let stop as KeyBootstrap.Stop {
            // nothing was changed or deleted
            launchRetry = stop == .retryLater
            launchStop = AppModel.phase(for: stop)
        } catch {
            errorText = S.launchFailed
        }
    }

    /// The last launch stopped on a passing Keychain fault and changed nothing.
    private var launchRetry = false
    /// The screen the last launch stopped on; route() shows it instead of the usual one.
    private var launchStop: Phase?

    /// Keys that fail the launch check get their own screen. A passing fault (before the
    /// first unlock) shows the loading screen; the next foreground tries again.
    static func phase(for stop: KeyBootstrap.Stop) -> Phase? {
        switch stop {
        case .unusable: return .keysBroken
        case .retryLater: return .loading
        }
    }

    /// Retry on the broken keys screen: the launch again, on this device only.
    func retryKeys() async {
        await once("open") {
            await open()
            await route()
        }
    }

    /// Delete broken keys, after the confirmation: the user then signs in again.
    func deleteBrokenKeys() {
        guard let store = store else { return }
        do {
            phase = try AppModel.deleteBrokenKeys(store: store, hooks: env)
            launchStop = nil
            pendingKeys = nil
        } catch {
            toast = ErrorCopy.Reason.saveFailed.line
        }
    }

    /// The DB part first, keeping this id as old_id for the DELETE after the next sign-in;
    /// if it fails the keys stay. Then the keys, the locked inbox, and the delivered
    /// notifications. The next screen is the sign-in.
    static func deleteBrokenKeys(store: Store, hooks: PlatformHooks) throws -> Phase {
        try store.keysLost()
        hooks.wipeKeys()
        hooks.removeLockedInbox()
        hooks.removeDeliveredNotifications()
        return .signIn(.register)
    }

    /// a launch error must not leave the app dead until force-quit. True when the
    /// store did not open, a signed-in device has no keys loaded, or a device with no
    /// account had its launch stopped by a passing Keychain fault.
    static func needsReopen(hasStore: Bool, hasCore: Bool, me: Me?, launchRetry: Bool = false) -> Bool {
        if !hasStore { return true }
        guard !hasCore, let me = me, !me.removed else { return false }
        return me.id != nil || launchRetry
    }

    /// A notification tap that arrived before start() finished; replayed after it.
    private var started = false
    /// Screenshot sample data has no keys on purpose; it must not reopen on foreground.
    private var sample = false
    private var pendingTap: (info: [AnyHashable: Any], action: String)?

    /// Which screen to show.
    func route() async {
        guard let store = store, let me = try? store.me() else { phase = .loading; return }
        self.me = me
        if let p = launchStop { phase = p; return }
        if notificationsOff && me.id == nil { phase = .welcome; return }
        if let r = AppModel.restoredCode(me: me, email: try? store.setting("code_email"),
                                         purpose: try? store.setting("code_purpose")) {
            // the request_token is bound to the keys made for this sign-in
            if case .code(_, .register) = r, pendingKeys == nil { pendingKeys = try? env.keychain.load() }
            phase = r
            return
        }
        if me.removed { phase = .removed; return }
        if me.id == nil { phase = .signIn(.register); return }
        repairedNotice = false
        if me.loggedOut { phase = .signedOut; return }
        if me.name == nil { phase = .nameDevice; return }
        phase = .main
        reload()
    }

    /// the email-code step survives process death. Its request_token, address, and
    /// purpose are saved; a register or login code step comes back on the next launch.
    static func restoredCode(me: Me, email: String?, purpose: String?) -> Phase? {
        guard me.requestToken != nil, let email = email,
              let p = purpose.flatMap(AuthPurpose.init(rawValue:)) else { return nil }
        switch p {
        case .register where me.id == nil || me.removed: return .code(email: email, purpose: p)
        case .login where me.id != nil && !me.removed && me.loggedOut: return .code(email: email, purpose: p)
        default: return nil
        }
    }

    func reload() {
        guard let store = store else { return }
        me = try? store.me()
        if let m = me, let next = AppModel.phaseAfterReload(phase, me: m) { phase = next }
        peers = (try? store.peers()) ?? []
        pairings = Dictionary(uniqueKeysWithValues: ((try? store.pairings()) ?? []).map { ($0.peerId.text, $0) })
        history = (try? store.history()) ?? []
    }

    /// the main screen must not stay up once this device is removed or logged out
    /// (a 401 or a message seen during any action), not only at the next foreground.
    static func phaseAfterReload(_ phase: Phase, me: Me) -> Phase? {
        guard phase == .main else { return nil }
        if me.removed { return .removed }
        if me.loggedOut { return .signedOut }
        return nil
    }

    /// Launch and every foreground: locked-inbox drain, delivered notifications, push
    /// reconcile, retries, timeouts, permission check.
    func onForeground() async {
        cannotReceiveDismissed = false
        await checkPermission()
        if started, !sample, AppModel.needsReopen(hasStore: store != nil, hasCore: core != nil, me: try? store?.me(), launchRetry: launchRetry) {
            await once("open") {
                await open()
                await route()
            }
        }
        guard let core = core, phase == .main || phase == .signedOut else { return }
        try? core.pruneHistory()
        let (n, lockedMs, held) = await core.drainLockedInbox(env.inbox)
        if n > 0 { lockedLine = S.receivedWhileLocked(n) }
        await drainDelivered(skip: lockedMs, held: held)
        if phase == .main { await core.appOpen(push: pushInfo) }
        else { await core.retryPendingLogout(); await core.allowReconcile() }
        reload()
        if (try? core.store.me().removed) == true { phase = .removed }
    }

    /// getDeliveredNotifications(): each one with "m" the NSE did not stamp as handled runs
    /// steps 4-9 with no banner, then is removed (a relay rowid alone does not skip it).
    /// skip: the "m" values the locked-inbox drain just ran; held: those it kept after
    /// a fault, left in place.
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

    /// The "cannot receive" banner: on the tabs and the logged-out screen while notifications
    /// are off, until its X is tapped.
    var showsCannotReceive: Bool {
        notificationsOff && !cannotReceiveDismissed && (phase == .main || phase == .signedOut)
    }

    // MARK: draft

    /// The Send draft: kept in the store (not in backups), so it survives a kill and goes
    /// with the wipe. Typing changes it at once; the store write waits 0.5 s for more.
    var draft: String { pendingDraft ?? AppModel.loadDraft(store) }
    private var pendingDraft: String?
    private var draftSave: Task<Void, Never>?

    func setDraft(_ t: String) {
        pendingDraft = t
        draftSave?.cancel()
        draftSave = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            if !Task.isCancelled { self?.saveDraft() }
        }
    }

    /// Writes a draft still waiting; also when the app goes to the background.
    func saveDraft() {
        guard let t = pendingDraft else { return }
        pendingDraft = nil
        AppModel.saveDraft(t, to: store)
    }

    static func loadDraft(_ store: Store?) -> String { (try? store?.setting(SettingKey.sendDraft)) ?? nil ?? "" }

    /// An empty draft deletes the row. A wiped device keeps none.
    static func saveDraft(_ t: String, to store: Store?) {
        guard let store = store, (try? store.me().removed) != true else { return }
        try? store.setSetting(SettingKey.sendDraft, t.isEmpty ? nil : t)
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
        // a register that may have reached the relay server: the same keys give the same id
        if purpose == .register, (try? store?.setting(KeyBootstrap.registerKeysSetting)) == "1",
           let k = try? env.keychain.load() {
            pendingKeys = k
            return k
        }
        guard KeyBootstrap.mayReplaceForSignIn(me: try? store?.me()) else { throw KeyBootstrap.Stop.unusable }
        env.keychain.deleteAll()
        let k = try env.keychain.create()
        pendingKeys = k
        return k
    }

    func nonce(_ purpose: AuthPurpose) throws -> String {
        Ids.oauthNonce(purpose: purpose.rawValue, signPub: try keysForSignIn(purpose).signer.publicKey)
    }

    func emailStart(_ email: String, purpose: AuthPurpose, turnstile: String) async {
        guard Ids.normalizeEmail(email) != nil else { toast = ErrorCopy.text(.sendCode, .badEmail); return }
        guard let k = try? keysForSignIn(purpose) else { toast = ErrorCopy.text(.prepareLogin, .keysUnusable); return }
        let r = await auth.emailStart(email: email, signPub: k.signer.publicKey, purpose: purpose, turnstile: turnstile)
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        switch r {
        case .requestToken(let t):
            resend = ResendGate(sentTo: ResendGate.key(email), untilMs: nowMs + ResendGate.resendMs)
            requestToken = t
            try? store?.setMe("request_token", .text(t))
            try? store?.setSetting("code_email", email)
            try? store?.setSetting("code_purpose", purpose.rawValue)
            phase = .code(email: email, purpose: purpose)
        default:
            // A 429 starts the countdown from Retry-After so the next try does not spend a security check for nothing.
            if case .rateLimited(let s) = r { resend = ResendGate(sentTo: ResendGate.key(email), untilMs: nowMs + s * 1000) }
            toast = S.loginError(r, .sendCode)
        }
    }

    func emailVerify(_ code: String, purpose: AuthPurpose) async {
        await once("verify") { await emailVerifyOnce(code, purpose: purpose) }
    }

    /// Back from the code step: forget the saved step so a relaunch does not bring it back.
    func leaveCode(_ purpose: AuthPurpose) {
        clearCodeStep()
        phase = .signIn(purpose)
    }

    private func clearCodeStep() {
        requestToken = nil
        try? store?.setMe("request_token", .null)
        try? store?.setSetting("code_email", nil)
        try? store?.setSetting("code_purpose", nil)
    }

    private func emailVerifyOnce(_ code: String, purpose: AuthPurpose) async {
        guard let t = requestToken ?? (try? store?.me().requestToken) ?? nil else { phase = .signIn(purpose); return }
        await finishTicket(await auth.emailVerify(requestToken: t, code: code), purpose: purpose, action: .checkCode)
    }

    func appleToken(idToken: String, code: String?, purpose: AuthPurpose) async {
        guard let k = try? keysForSignIn(purpose) else { toast = ErrorCopy.text(.prepareLogin, .keysUnusable); return }
        await finishTicket(await auth.appleToken(idToken: idToken, signPub: k.signer.publicKey, purpose: purpose, code: code), purpose: purpose,
                           action: .loginApple)
    }

    func googleToken(idToken: String, purpose: AuthPurpose) async {
        guard let k = try? keysForSignIn(purpose) else { toast = ErrorCopy.text(.prepareLogin, .keysUnusable); return }
        await finishTicket(await auth.googleToken(idToken: idToken, signPub: k.signer.publicKey, purpose: purpose), purpose: purpose,
                           action: .loginGoogle)
    }

    func finishTicket(_ r: AuthResult, purpose: AuthPurpose, action: ErrorCopy.Action) async {
        guard case .ticket(let ticket, let email) = r else {
            toast = S.loginError(r, action)
            return
        }
        try? store?.setMe("signed_in_email", .text(email))
        clearCodeStep()
        switch purpose {
        case .register: await register(ticket: ticket, evict: [])
        case .login: await login(ticket: ticket)
        case .deleteAccount: await deleteAccount(ticket: ticket)
        }
    }

    func register(ticket: String, evict: [String]) async {
        guard let store = store, let keys = pendingKeys ?? core?.keys else { return }
        let c = env.makeCore(store: store, keys: keys)
        core = c
        try? store.setSetting(KeyBootstrap.registerKeysSetting, "1")
        let r = await c.register(ticket: ticket, push: pushInfo, evict: evict)
        settleRegisterKeys(r)
        switch r {
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
                                  loggedOut: bool("logged_out"), oldInstall: id == old)
            }
            phase = .limitPicker
        case .idCollision:
            let next = AppModel.afterIdCollision(deleteKeys: { env.keychain.deleteAll() },
                                                 createKeys: { try env.keychain.create() })
            pendingKeys = next.keys
            core = next.keys.map { env.makeCore(store: store, keys: $0) }
            limitTicket = nil
            toast = next.toast
            phase = .signIn(.register)
        case .banned: phase = .banned
        case .ticketExpired: toast = ErrorCopy.text(.login, .loginExpired); phase = .signIn(.register)
        case .network: toast = ErrorCopy.text(.login, .unreachable)
        case .failed(let s, let e): toast = ErrorCopy.text(.login, ErrorCopy.reason(status: s, error: e))
        }
    }

    /// 409 id collision: the ticket is bound to the old key, so it cannot be sent again.
    /// New keys are made for a fresh login. A failed create leaves no keys; the next
    /// login makes them.
    static func afterIdCollision(deleteKeys: () -> Void,
                                 createKeys: () throws -> DeviceKeys) -> (keys: DeviceKeys?, toast: String) {
        deleteKeys()
        guard let k = try? createKeys() else { return (nil, ErrorCopy.text(.login, .keysUnusable)) }
        return (k, ErrorCopy.Action.login.line + "\nLog in again.")
    }

    private func settleRegisterKeys(_ r: RegisterOutcome) {
        if !AppModel.keepsRegisterKeys(r) { try? store?.setSetting(KeyBootstrap.registerKeysSetting, nil) }
    }

    /// True when the register may have reached the relay server without this device
    /// saving the result: no reply, a peer limit still to settle, a 5xx, or a success the
    /// store failed to save. The keys are then kept for the next register.
    static func keepsRegisterKeys(_ r: RegisterOutcome) -> Bool {
        switch r {
        case .network, .peerLimit: return true
        case .failed(let status, _): return (200..<300).contains(status) || status >= 500
        case .registered, .idCollision, .banned, .ticketExpired: return false
        }
    }

    /// Limit picker submit: after 10 min the ticket is expired; ticks are kept.
    func submitEvict() async {
        await once("evict") { await submitEvictOnce() }
    }

    private func submitEvictOnce() async {
        guard let t = limitTicket else { return }
        if Date().timeIntervalSince(t.at) > 600 {
            toast = ErrorCopy.text(.login, .loginExpired)
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
        guard let core = core, NameEntry.isValidName(name) else { toast = ErrorCopy.nameRule; return }
        if (try? core.store.me().name) == nil {
            try? core.store.setMe("name", .text(name))
        } else {
            await renameToast(core, name)
        }
        await route()
    }

    func login(ticket: String) async {
        guard let core = core else { return }
        _ = try? await core.login(ticket: ticket, push: pushInfo)
        await route()
    }

    /// logged out here at once; the relay server call runs after and is retried on
    /// later app opens until it goes through.
    func signOut() async {
        guard let core = core else { return }
        do { try core.logoutLocal() } catch { toast = ErrorCopy.text(.logout, ErrorCopy.reason(local: error)) }
        await route()
        Task { await core.retryPendingLogout() }
    }

    func deleteAccount(ticket: String) async {
        guard let core = core else { return }
        do {
            let out = try await core.deleteAccount(ticket: ticket)
            if out.reply?.ok == true { phase = .removed } else { toast = ErrorCopy.text(.deleteAccount, ErrorCopy.reason(from: out)) }
        } catch {
            toast = ErrorCopy.text(.deleteAccount, ErrorCopy.reason(local: error))
        }
    }

    // MARK: peers and pairing

    func label(_ p: Peer) -> String { PeerLabel.label(p) }

    func pair(_ p: Peer) async {
        guard let core = core else { return }
        await once("pair:" + p.id.text) {
            let r: Result<PairSendResult, Error>
            do { r = .success(try await core.startPair(p.id)) } catch { r = .failure(error) }
            if let t = Core.pairAgainToast(r, name: label(p)) { toast = t }
            reload()
        }
    }
    func sendAgain(_ p: Peer) async { _ = await core?.sendAgain(p.id); reload() }
    func reply(_ p: Peer) async { _ = await core?.tapReply(p.id); reload() }
    func cancelPairing(_ p: Peer) async { await core?.cancelPairing(p.id); reload() }
    /// Pair again: one run per peer at a time; a failure shows a toast.
    func pairAgain(_ p: Peer) async {
        guard let core = core, !pairAgainBusy.contains(p.id.text) else { return }
        pairAgainBusy.insert(p.id.text)
        defer { pairAgainBusy.remove(p.id.text) }
        let r: Result<PairSendResult, Error>
        do { r = .success(try await core.pairAgain(p.id)) } catch { r = .failure(error) }
        if let t = Core.pairAgainToast(r, name: label(p)) { toast = t }
        reload()
    }
    func remove(_ p: Peer) async {
        guard let core = core else { return }
        await once("remove:" + p.id.text) {
            let out = try? await core.removePeer(p.id)
            reload()
            if phase == .main, let t = Core.failText(out, .remove(label(p))) { toast = t }
        }
    }
    func localDelete(_ p: Peer) async { await core?.localDelete(p.id); reload() }
    func setHidden(_ p: Peer, _ h: Bool) {
        do { try core?.setHidden(p.id, h) } catch { settingFailed(error) }
        reload()
    }
    func setPeerSwitches(_ p: Peer, lockShow: Bool? = nil, showContent: Bool? = nil) {
        do { try core?.setPeerSwitches(p.id, lockShow: lockShow, showContent: showContent) } catch { settingFailed(error) }
        reload()
    }

    func approve(_ p: Peer) async -> ApproveOutcome? {
        var r: ApproveOutcome?
        await once("approve:" + p.id.text) {
            r = await core?.approve(p.id)
            // the app removes the reply notice once N shows the fingerprint
            reload()
            if phase == .main, let t = Core.failText(r, .confirm(label(p))) { toast = t }
        }
        return r
    }

    func approveSendAgain(_ p: Peer) async { _ = await core?.postApprove(p.id, fresh: false); reload() }

    func deny(_ p: Peer) async {
        await once("deny:" + p.id.text) {
            let r = await core?.deny(p.id)
            reload()
            if phase == .main, let t = Core.failText(r, .reject(label(p))) { toast = t }
        }
    }

    func refresh() async {
        guard Date() >= refreshGreyUntil, let core = core else { return }
        refreshGreyUntil = Date().addingTimeInterval(60)
        let out = await core.refresh(push: pushInfo)
        if let t = ErrorCopy.refreshFailText(out) { toast = t }
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

    /// Pair again replaces Cancel pairing on a half-state row (no Core: not offered).
    func offersPairAgain(_ p: Peer) -> Bool { core?.offersPairAgain(p) ?? false }

    var allSet: [Peer] { peers.filter { $0.inAll } }

    /// The tab bar shows: the banner then sits inside each tab, above the tab bar.
    var showsTabs: Bool { phase == .main }

    /// Logged in with no paired device: the Devices tab shows the first-pair steps, and Send
    /// and History offer Pair a device. State-driven, so it goes once a pairing
    /// completes and comes back when the last paired device is removed.
    var needsFirstPair: Bool { !peers.contains { $0.pinned && $0.state == .approved } }

    /// Devices of this account waiting to pair: the Devices tab Pairing section.
    var waitingToPair: [Peer] {
        peers.filter { pairings[$0.id.text] != nil || (!$0.pinned && $0.state != .removed) }
    }

    var showAllOption: Bool { (try? store?.boolSetting(SettingKey.showAll, default: true)) ?? true }

    // MARK: send

    /// True when sent; false (draft kept) when not.
    @discardableResult
    func send(_ text: String, asText: Bool, toAll: Bool, peerIds: [String]) async -> Bool {
        // One send per tap: a second tap while the first is on its way keeps the draft and does nothing.
        guard let core = core, !busy.contains("send") else { return false }
        busy.insert("send")
        defer { busy.remove("send") }
        let type: SendType = asText ? .text : SendDetection.detect(text)
        let all = allSet
        let ids = toAll ? all.map { $0.id } : peerIds.compactMap { PeerId(text: $0) }
        var sent = false
        do {
            let rep = try await core.send(text, as: type, to: ids, allCount: all.count)
            toast = rep.toast
            toastIsSuccess = rep.allSent
            sent = true
        } catch {
            toast = ErrorCopy.sendFailText(error)
        }
        reload()
        return sent
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

    func deleteRows(_ ids: Set<Int64>) {
        for id in ids { try? store?.db.exec("DELETE FROM history WHERE rowid = ?", [.int(id)]) }
        reload()
    }

    func deleteAllHistory() {
        do { try core?.deleteAllHistory() } catch { toast = ErrorCopy.text(.deleteHistory, ErrorCopy.reason(local: error)) }
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
    func setBool(_ k: String, _ v: Bool) {
        do { try store?.setSetting(k, v ? "1" : "0") } catch { settingFailed(error) }
        objectWillChange.send()
    }
    var historyDays: Int { Int((try? store?.setting(SettingKey.historyDays)) ?? nil ?? "30") ?? 30 }
    func setHistoryDays(_ d: Int) {
        do { try store?.setSetting(SettingKey.historyDays, String(d)) } catch { settingFailed(error) }
        objectWillChange.send()
    }
    /// A setting write that threw: "Unable to change this setting." and why.
    private func settingFailed(_ e: Error) { toast = ErrorCopy.text(.changeSetting, ErrorCopy.reason(local: e)) }

    func rename(_ name: String) async {
        guard let core = core else { return }
        await renameToast(core, name)
        reload()
    }

    /// Renames this device; a failure shows the name rule only for a bad name, else the reason.
    private func renameToast(_ core: Core, _ name: String) async {
        let result: Result<APIOutcome, Error>
        do { result = .success(try await core.rename(name)) } catch { result = .failure(error) }
        if let t = ErrorCopy.renameFailText(name, result) { toast = t }
    }

    /// Notification tap routing (section 10).
    func handleTap(_ info: [AnyHashable: Any], action: String) async {
        if !started { pendingTap = (info, action); return }
        let key = store.flatMap { try? TapStamp.key($0) }
        if let m = TapStamp.drainM(info, key: key), let core = core {
            _ = await core.receiveTapped(m, inbox: env.inbox)
            reload()
        }
        // routing keys count only with the NSE stamp; relay userInfo is ignored
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
        case "detail": if let r = row { markRead(r); detailRow = r; showHistory = true }
        default: break
        }
    }

    /// The History row that is open, with its text and action buttons under it.
    @Published var detailRow: HistoryRow?
}
