import Foundation

/// User-facing strings from the design (ios sections 5-11, catalog Notice rule).
public enum S {
    public static let title = "PushArmor"
    public static let fallback = "New message"
    public static let locked = "New message. Unlock to view"
    public static let dropped = "PushArmor received a message it could not read"
    public static let invalid = "Invalid message received"
    public static let unknownSender = "Unknown sender"
    public static let aPeer = "A device"
    public static let pairCommit = "A new device wants to pair. Open PushArmor."
    public static func pairOpen(_ fp: String) -> String { "New device: compare \(fp)" }
    public static let pairReply = "Pairing fingerprint ready. Open PushArmor."
    public static func pairAgain(_ x: String) -> String { "\(x) wants to pair again. Tap Pair again on its row." }
    public static let cannotPairNow = "Cannot pair with this device now."
    /// Pair refused on this device (I604): one line per reason, each says why and what to do.
    public static func alreadyPaired(_ x: String) -> String { "Already paired with \"\(x)\"." }
    public static func pairingInProgress(_ x: String) -> String { "Pairing with \"\(x)\" is already in progress." }
    public static func cannotPairYet(_ x: String) -> String { "\"\(x)\" can't pair right now. Open PushArmor on that device, then try again." }
    public static let tooManyPairings = "Too many pairings are in progress. Finish or cancel one, then try again."
    public static let pairNotSent = "Pairing not sent. Tap Send again in a minute."
    public static let noConnection = "No connection. Try again."
    public static let notDone = "Something went wrong. Try again."
    public static func pairCrossing(_ x: String) -> String { "Pairing with \(x) in progress. Open PushArmor." }
    public static func approved(_ name: String) -> String { "\(name) approved this device." }
    public static func renamed(_ old: String, _ new: String) -> String { "'\(old)' renamed to '\(new)'" }
    public static let peerListChanged = "Device list changed"
    public static let thisDeviceRemoved = "This device was removed. Log in again."
    public static let accountDeleted = "Account deleted on another device."
    public static func denied(_ name: String) -> String { "\(name) denied this device" }
    public static func loggedOutNotice(_ name: String) -> String { "\(name) logged out." }
    public static func loggedInNotice(_ name: String) -> String { "\(name) logged in." }
    public static func newMessageFrom(_ peer: String) -> String { "New message from \(peer)" }
    public static let pairingFailed = "Pairing failed. Start again on the new device."
    public static let pairingTimedOut = "Pairing timed out. Tap Pair to start again."
    public static func waiting(_ x: String) -> String { "Waiting for \(x): open PushArmor there and approve." }
    public static func noReplyYet(_ x: String) -> String { "No reply yet. Open PushArmor on \(x), or tap Send again." }
    public static func stillHolds(_ x: String) -> String { "\(x) still holds an earlier pairing. On \(x), tap Cancel pairing, then tap Send again." }
    public static func notPairedOn(_ x: String) -> String { "Not paired on \(x)" }
    public static func declinedBy(_ x: String) -> String { "Declined by \(x)" }
    public static func pairingFingerprint(_ fp: String) -> String { "Pairing fingerprint \(fp)" }
    public static func removeConfirm(_ x: String) -> String {
        "Remove \(x) from this account? \(x) must log in again and pair with every device again."
    }
    /// Device-limit row (Q369): how many devices it trusts and how many trust it.
    public static func trusts(_ n: Int, trustedBy m: Int) -> String {
        "Trusts \(n) \(n == 1 ? "device" : "devices"). Trusted by \(m)."
    }
    public static func sentTo(_ n: Int, _ m: Int) -> String { "Sent to \(n) of \(m) " + (m == 1 ? "device" : "devices") }
    /// History line for a message that reached its one recipient (F22).
    public static func sentToOne(_ x: String) -> String { "Sent to \"\(x)\"" }
    /// Send banner when every chosen device got the message (I604).
    public static func messageSentTo(_ x: String) -> String { "Message sent to \"\(x)\"" }
    public static func messageSentTo(count n: Int) -> String { "Message sent to \(n) devices" }
    public static func notDelivered(_ x: String) -> String { "Not delivered to \(x): open PushArmor on it." }
    public static func signedOutPeer(_ x: String) -> String { "\(x): Logged out. Log in on it to receive messages." }
    public static func sendOnlyPeer(_ x: String) -> String { "\(x): Send only. It does not receive messages." }
    public static func notPairedPeer(_ x: String) -> String { "\(x): Not paired. Pair with it to send messages." }
    public static func declinedPeer(_ x: String) -> String { "\(x): It declined this device." }
    public static func goneFromAccountPeer(_ x: String) -> String { "\(x): It is no longer on this account." }
    public static func notDeliveredRetry(_ x: String) -> String { "\(x): Not delivered. Try again." }
    public static let emailSendFailed = "Could not send the email. Try again."
    public static let pairHowTo1 = "Install PushArmor on the other device."
    public static let pairHowTo2 = "Log in with the same account."
    public static let pairHowTo3 = "It appears here. Tap Pair."
    public static let firstPairStep1 = "Install PushArmor on another device."
    public static let firstPairStep2 = "Log in with the same account."
    public static let firstPairStep3 = "When it shows below, tap Pair and approve it."
    public static let firstPairWaiting = "Waiting for another device to log in."
    public static let storeRepaired = "Local data was found corrupted and repaired. Please log in again."
    public static let launchFailedTitle = "Could not open data"
    public static let launchFailed = "PushArmor could not open its data on this device. Free some storage space, then leave PushArmor and open it again."
    public static let updateRequired = "Update PushArmor to continue."
    public static let updateTitle = "Please update PushArmor"
    public static let updateBody = "This version no longer works with the relay server. Update to keep sending and receiving."
    public static let clockOff = "This device's clock is off by more than 5 minutes."
    public static let emailInvalid = "Not a valid email address"
    public static let badEmail = "Only email addresses with plain ASCII characters are supported."
    public static let signInExpired = "Login expired. Log in again."
    public static let signedOutResume = "Logged out. Log in to resume."
    public static let notificationsOff = "Notifications are off. This device cannot receive messages."
    public static let relayHelp = "To log in on another device, use this address. Find it in iOS Settings > Apple ID > Sign in with Apple, or at appleid.apple.com > Hide My Email."
    public static let unreachable = "Unreachable"
    public static let loggedOutBadge = "Logged out"
    public static let pushRegistrationFailed = "Push registration failed."
    public static let loginFailed = "Login failed."
    public static let wrongCode = "That code did not work. Check the newest email from PushArmor and try again."
    public static let codeExpired = "This code has expired. Get a new code to continue."
    /// Wait text: over 60 s whole minutes rounded up, else whole seconds rounded up; same words as the other clients.
    public static func wait(ms: Int) -> String {
        let s = max(1, (ms + 999) / 1000)
        if s > 60 { let m = (s + 59) / 60; return m == 1 ? "1 minute" : "\(m) minutes" }
        return s == 1 ? "1 second" : "\(s) seconds"
    }
    /// Send button label: the label alone, or "Send code in 42 seconds" while the countdown runs.
    public static func sendLabel(_ label: String, leftMs: Int) -> String { leftMs > 0 ? label + " in " + wait(ms: leftMs) : label }
    /// Login error text, with its cause when the result has one (I506).
    public static func loginError(_ r: AuthResult) -> String {
        switch r {
        case .network: return noConnection
        case .badEmail: return badEmail
        case .emailSendFailed: return emailSendFailed
        case .rateLimited(let s): return "Too many requests. Try again in \(wait(ms: s * 1000))."
        case .failed(401, "wrong code"?): return wrongCode
        case .failed(401, "code expired"?): return codeExpired
        default: return loginFailed
        }
    }
    public static func receivedWhileLocked(_ n: Int) -> String { "\(n) " + (n == 1 ? "message" : "messages") + " received while locked" }
    public static let thisPhoneOldInstall = "(this phone, old install)"
    public static let tooLongShare = "Send the first 2048 bytes"
    public static let showContentSwitch = "Show message content in notifications"
    public static let lockScreenSwitch = "Show message content on lock screen"
    public static let alwaysHide = "Always hide content"
    public static func pairWith(_ x: String) -> String { "Pair with new device: \"\(x)\"" }
    public static func checkSameCode(_ x: String) -> String { "Verify that \"\(x)\" shows this same code." }
    public static let codesMismatch = "Codes do not match? Tap Deny."
    public static let newPeerWantsToPair = "A new device wants to pair."
    public static func timesOutIn(_ t: String) -> String { "Times out in \(t)" }
    public static let sameAccount = "Use the same account on every device you want to pair."
    public static let noPeersBody = "Install PushArmor on your other devices and log in with the same account. They show up here, ready to pair."
    public static let noMessagesBody = "Everything you send or receive shows up here."
}

/// Notification categories (section 6.2).
public enum BannerCategory: String, Sendable {
    case url = "PA_URL", text = "PA_TEXT", tel = "PA_TEL", event = "PA_EVENT", notice = "PA_NOTICE"
}

/// What the NSE shows for one push.
public struct Banner: Equatable, Sendable {
    public enum Tap: Equatable, Sendable { case openURL(String), detail, peers(String?), history, none }

    public var body: String
    public var locKey: String?          // PA_FALLBACK, PA_LOCKED, PA_DROPPED, PA_INVALID
    public var category: BannerCategory
    public var threadId: String
    public var rowid: Int64?
    public var tap: Tap

    public static let dropThread = "pa.notice"

    public static var dropped: Banner {
        Banner(body: S.dropped, locKey: "PA_DROPPED", category: .notice, threadId: dropThread, rowid: nil, tap: .history)
    }
    public static var invalid: Banner {
        Banner(body: S.invalid, locKey: "PA_INVALID", category: .notice, threadId: dropThread, rowid: nil, tap: .history)
    }
    public static var locked: Banner {
        Banner(body: S.locked, locKey: "PA_LOCKED", category: .event, threadId: "pa.locked", rowid: nil, tap: .none)
    }
    public static var fallback: Banner {
        Banner(body: S.fallback, locKey: "PA_FALLBACK", category: .event, threadId: "pa.fallback", rowid: nil, tap: .none)
    }

    /// threadIdentifier = peer id hash (local only).
    public static func peerThread(_ id: PeerId) -> String {
        "p." + B64URL.encode(Bytes.sha256(id.raw).prefix(12))
    }

    /// NSE time expiry before the commit (I307): userInfo is only "m"; nothing else of the
    /// relay's payload is kept, and with no routing keys the app drains "m".
    public static func expiryUserInfo(m: Any?) -> [AnyHashable: Any] {
        guard let m = m else { return [:] }
        return ["m": m]
    }

    /// Notification userInfo: only "m" is kept from the relay payload, then the routing keys,
    /// stamped with a MAC under the per-install tap key (TapStamp) when one is given. "done"
    /// marks a push the NSE handled (I308), covered by the same MAC.
    public func userInfo(m: Any?, key: Data? = nil, handled: Bool = false) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [:]
        if let m = m { info["m"] = m }
        if let r = rowid { info["rowid"] = NSNumber(value: r) }
        switch tap {
        case .openURL(let u): info["tap"] = "url"; info["url"] = u
        case .detail: info["tap"] = "detail"
        case .peers(let id): info["tap"] = "peers"; if let id = id { info["peer"] = id }
        case .history: info["tap"] = "history"
        case .none: info["tap"] = "none"
        }
        if handled { info["done"] = "1" }
        if let k = key { info[TapStamp.field] = TapStamp.mac(info, key: k) }
        return info
    }
}

/// Tap routing stamp (I297): a push the NSE did not rewrite keeps relay userInfo, so a tap
/// acts on rowid / tap / url / peer only when they carry a MAC under a per-install key kept
/// in the App Group store.
public enum TapStamp {
    public static let field = "s"
    static let settingKey = "tap_key"

    /// The per-install key; created on first use (a concurrent creator keeps the first one).
    public static func key(_ store: Store) throws -> Data {
        if let k = try store.setting(settingKey).flatMap(B64URL.decode), k.count == 32 { return k }
        let fresh = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        try store.db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [.text(settingKey), .text(B64URL.encode(fresh))])
        if let k = try store.setting(settingKey).flatMap(B64URL.decode), k.count == 32 { return k }
        try store.setSetting(settingKey, B64URL.encode(fresh))   // a corrupt value is replaced
        return fresh
    }

    /// HMAC-SHA256 over the routing keys and "done", each length-prefixed (absent and empty differ).
    static func mac(_ info: [AnyHashable: Any], key: Data) -> String {
        B64URL.encode(Data(HMAC<SHA256>.authenticationCode(for: routing(info), using: SymmetricKey(data: key))))
    }

    static func routing(_ info: [AnyHashable: Any]) -> Data {
        var d = Data()
        let rowid = (info["rowid"] as? NSNumber).map { String($0.int64Value) }
        for v in [rowid, info["tap"] as? String, info["url"] as? String, info["peer"] as? String,
                  info["done"] as? String] {
            guard let v = v else { d.append(0); continue }
            let b = Data(v.utf8)
            d.append(1)
            withUnsafeBytes(of: UInt32(b.count).bigEndian) { d.append(contentsOf: $0) }
            d.append(b)
        }
        return d
    }

    /// The "m" the app drains from a delivered or tapped notification (I311, I308): none only
    /// when the stamp verifies and the NSE marked the push handled (a rowid or "done"). A relay
    /// "rowid" or "done" without a valid stamp is drained.
    public static func drainM(_ info: [AnyHashable: Any], key: Data?) -> String? {
        guard let m = info["m"] as? String else { return nil }
        if (info["rowid"] != nil || info["done"] != nil) && verified(info, key: key) { return nil }
        return m
    }

    /// True when the routing keys carry a valid stamp.
    public static func verified(_ info: [AnyHashable: Any], key: Data?) -> Bool {
        guard let k = key, let s = info[field] as? String, let got = B64URL.decode(s) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(got, authenticating: routing(info), using: SymmetricKey(data: k))
    }
}

/// Lock-screen body choice (section 6.2, Q165 B, Q183 B, Q187 A): effective = main AND peer;
/// Always hide content (main or peer) wins.
public enum LockScreen {
    public static func body(mainShow: Bool, peerShow: Bool, mainAlwaysHide: Bool, peerAlwaysHide: Bool,
                            locked: Bool, peerName: String, content: String) -> String {
        if mainAlwaysHide || peerAlwaysHide { return S.newMessageFrom(peerName) }
        if !(mainShow && peerShow) && locked { return S.newMessageFrom(peerName) }
        return content
    }
}

/// "$X" for a peer without a name in pairing notices: platform and created date,
/// for example "Android peer added Oct 3".
public enum PeerLabel {
    public static func platformName(_ p: String?) -> String {
        switch p {
        case "android": return "Android"
        case "ios": return "iPhone"
        case "chrome": return "Chrome"
        case "firefox": return "Firefox"
        case "cli": return "Command line"
        default: return "Unknown"
        }
    }

    public static func unnamed(platform: String?, created: Int64?, timeZone: TimeZone = .current) -> String {
        var s = platformName(platform) + " device"
        if let c = created {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = timeZone
            f.dateFormat = "MMM d"
            s += " added " + f.string(from: Date(timeIntervalSince1970: TimeInterval(c)))
        }
        return s
    }

    public static func label(_ p: Peer?) -> String {
        guard let p = p else { return S.aPeer }
        return p.name ?? unnamed(platform: p.platform, created: p.created)
    }
}
