import UserNotifications
import PushArmorCore

/// Decrypts every push (ios section 6). Budget about 30 s; the memory limit is small.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNMutableNotificationContent?
    private var committed: UNMutableNotificationContent?
    private let started = Date()

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let orig = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        lock.lock()
        handler = contentHandler
        original = orig
        lock.unlock()
        let env = AppEnvironment.shared
        let m = request.content.userInfo["m"]
        let started = self.started
        Task {
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
                    guard r.committed, let b = r.banner else { return }
                    self?.setCommitted(BannerContent.content(b, m: m))
                })
            self.deliver(BannerContent.content(r.banner ?? .dropped, m: m))
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

    /// If the step 8-9 transaction committed, deliver the 6.2 banner; else hand back the
    /// original content (PA_FALLBACK "New message"). Never PA_DROPPED here.
    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let c: UNNotificationContent? = committed ?? original
        lock.unlock()
        if let c = c { deliver(c) }
    }
}
