import UserNotifications
import PushArmorCore

/// Decrypts every push (ios section 6). Budget about 30 s; the memory limit is small.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var m: Any?
    private var committed: UNMutableNotificationContent?
    private let started = Date()

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let m = request.content.userInfo["m"]
        lock.lock()
        handler = contentHandler
        self.m = m
        lock.unlock()
        let env = AppEnvironment.shared
        let started = self.started
        Task {
            // per-install tap key (I297); nil while the store is unreadable: routing then unstamped
            let key = (try? env.openStore()).flatMap { try? TapStamp.key($0) }
            let r = await NSEFlow.handle(
                m: m,
                loadKeys: { try env.keychain.load() },
                openCore: { keys in
                    guard let store = try? env.openStore() else { return nil }
                    if let k = keys { return env.makeCore(store: store, keys: k) }
                    // no keys: a core that can only write the drop event row
                    return Core(store: store, api: APIClient(),
                                keys: DeviceKeys(signer: SoftwareSigner(), decryptor: SoftwareDecryptor()), hooks: env)
                },
                inbox: env.inbox,
                nowMs: Int64(Date().timeIntervalSince1970 * 1000),
                budgetLeft: { 30 - Date().timeIntervalSince(started) },
                onReceived: { [weak self] r in
                    // a final verdict (I329): expiry delivers this content stamped "done"
                    guard let b = r.banner else { return }
                    self?.setCommitted(BannerContent.content(b, m: m, key: key, handled: r.handled))
                })
            self.deliver(BannerContent.content(r.banner ?? .dropped, m: m, key: key, handled: r.handled))
        }
    }

    private func setCommitted(_ c: UNMutableNotificationContent) {
        lock.lock()
        committed = c
        lock.unlock()
    }

    private func deliver(_ c: UNNotificationContent) {
        lock.lock()
        let h = handler
        handler = nil
        lock.unlock()
        h?(c)
    }

    /// If the push reached a final verdict, deliver its stamped content (I329); else fresh "New
    /// message" content with only "m" (I307): never the relay's own alert or userInfo.
    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let c: UNNotificationContent = committed ?? BannerContent.expiry(m: m)
        lock.unlock()
        deliver(c)
    }
}
