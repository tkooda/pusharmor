import Foundation
import UserNotifications
import PushArmorCore

/// Shared setup of the app, the NSE and the share extension: the App Group store, the
/// Keychain access group and the platform hooks (ios section 2).
final class AppEnvironment: PlatformHooks {
    static let shared = AppEnvironment()

    /// Info.plist keys set from build settings (project.yml).
    let appGroup: String = Bundle.main.object(forInfoDictionaryKey: "PAAppGroup") as? String ?? ""
    let keychainGroup: String = Bundle.main.object(forInfoDictionaryKey: "PAKeychainGroup") as? String ?? ""
    let googleClientId: String = Bundle.main.object(forInfoDictionaryKey: "PAGoogleClientID") as? String ?? ""

    var containerURL: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)!
    }
    var storeDir: URL { containerURL.appendingPathComponent("store", isDirectory: true) }
    var dbURL: URL { storeDir.appendingPathComponent("pa.sqlite") }
    var canaryURL: URL { storeDir.appendingPathComponent("canary") }
    var inbox: LockedInbox { LockedInbox(dir: storeDir.appendingPathComponent("locked-inbox", isDirectory: true)) }
    lazy var keychain = KeychainKeyStore(accessGroup: keychainGroup)

    /// First launch (app only): store/ marked isExcludedFromBackup (side files inherit it),
    /// the canary with protection complete, the locked-inbox directory with protection none.
    func prepareDirectories() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: storeDir, withIntermediateDirectories: true,
                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var dir = storeDir
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        try dir.setResourceValues(rv)
        if !fm.fileExists(atPath: canaryURL.path) {
            try Data([1]).write(to: canaryURL, options: [.atomic, .completeFileProtection])
        }
        try inbox.ensureDirectory()
    }

    /// Open pa.sqlite (WAL, file protection completeUntilFirstUserAuthentication).
    func openStore() throws -> Store {
        let s = try Store(path: dbURL.path)
        for suffix in ["", "-wal", "-shm"] {
            let p = dbURL.path + suffix
            if FileManager.default.fileExists(atPath: p) {
                try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                                       ofItemAtPath: p)
            }
        }
        return s
    }

    func makeCore(store: Store, keys: DeviceKeys) -> Core {
        let me = try? store.me()
        let api = APIClient(offsetMs: me?.clockOffset ?? 0)
        return Core(store: store, api: api, keys: keys, hooks: self)
    }

    // MARK: PlatformHooks

    func wipeKeys() { keychain.deleteAll() }
    func removeLockedInbox() { inbox.removeAll() }
    func removeDeliveredNotifications() { UNUserNotificationCenter.current().removeAllDeliveredNotifications() }

    /// The lock-screen switch reads the canary (protection complete): a failed read means
    /// the phone is locked.
    func isProtectedDataLocked() -> Bool { (try? Data(contentsOf: canaryURL)) == nil }
}

/// Banner -> notification content (NSE and app re-presentation).
enum BannerContent {
    /// Fresh content: nothing of the relay's alert (subtitle included) is kept; only "m"
    /// is copied into userInfo (spec 6.2).
    static func content(_ b: Banner, m: Any?, key: Data?) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = S.title
        c.body = b.body
        c.sound = .default
        c.categoryIdentifier = b.category.rawValue
        c.threadIdentifier = b.threadId
        c.userInfo = b.userInfo(m: m, key: key)
        return c
    }

    /// NSE time expiry before the commit (I307): fresh "New message" content; nothing of the
    /// relay's alert or userInfo is kept but "m".
    static func expiry(m: Any?) -> UNMutableNotificationContent {
        let b = Banner.fallback
        let c = UNMutableNotificationContent()
        c.title = S.title
        c.body = b.body
        c.sound = .default
        c.categoryIdentifier = b.category.rawValue
        c.threadIdentifier = b.threadId
        c.userInfo = Banner.expiryUserInfo(m: m)
        return c
    }

    /// Category ids with their actions; every category sets hiddenPreviewsBodyPlaceholder
    /// "New message" (Q165 B). Copy actions require authentication.
    static func categories() -> Set<UNNotificationCategory> {
        let open = UNNotificationAction(identifier: "OPEN", title: "Open", options: [.foreground])
        let copy = UNNotificationAction(identifier: "COPY", title: "Copy", options: [.authenticationRequired])
        let ok = UNNotificationAction(identifier: "OK", title: "OK", options: [])
        func cat(_ id: BannerCategory, _ actions: [UNNotificationAction]) -> UNNotificationCategory {
            UNNotificationCategory(identifier: id.rawValue, actions: actions, intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: S.fallback, options: [])
        }
        return [cat(.url, [open, copy]), cat(.text, [copy]), cat(.tel, [copy]), cat(.event, []), cat(.notice, [ok])]
    }
}
