#if DEBUG
import Foundation
import UserNotifications
import PushArmorCore

/// Store screenshot mode (debug builds only; tools/check-release-bundle.sh fails on it in a
/// release app). The launch argument -PAScreenshots opens a sample database in the temporary
/// directory: no App Group, no Keychain, no Core, so no Worker call. -PAScreenshotsPairing
/// adds an open pairing; -PAScreenshotsNotify posts a local sample notification.
enum ScreenshotSample {
    private static let args = ProcessInfo.processInfo.arguments
    static var isOn: Bool { args.contains("-PAScreenshots") }

    /// Compose box prefill.
    static let draft = "https://example.com/guide/hiking-trails"
    static let draftPeer = String(repeating: "L", count: 40)
    static let link = "https://example.com/recipes/lentil-soup"

    private static func id(_ c: Character) -> String { String(repeating: c, count: 40) }

    static func makeStore() throws -> Store {
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("pa-shots.sqlite")
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) }
        let store = try Store(path: path)
        let now = Int64(Date().timeIntervalSince1970)
        try store.setMe("id", .text(id("S")))
        try store.setMe("name", .text("iPhone"))
        let peers: [(String, String, String, Int64)] = [
            (id("L"), "chrome", "Laptop", now - 40 * 86400),
            (id("W"), "firefox", "Work desktop", now - 30 * 86400),
            (id("T"), "android", "Tablet", now - 20 * 86400),
        ]
        for (pid, platform, name, created) in peers {
            try store.db.exec("""
                INSERT INTO peers (id, sign_pub, enc_pub, state, listed, approve_verified, approve_verified_at, reachable,
                  platform, created, name, name_n, pairing_id) VALUES (?, ?, ?, 'approved', 1, 1, ?, 1, ?, ?, ?, 1, ?)
                """, [.text(pid), .blob(Data(repeating: 2, count: 65)), .blob(Data(repeating: 3, count: 65)), .int(created),
                      .text(platform), .int(created), .text(name), .blob(Data(repeating: 1, count: 16))])
        }
        guard let laptop = PeerId(text: id("L")), let desktop = PeerId(text: id("W")), let tablet = PeerId(text: id("T"))
        else { return store }
        try store.addMessage(dir: .outgoing, peer: tablet, type: "url", content: draft, n: nil, pairingId: nil,
                             read: true, results: "{\"\(tablet.text)\":\"sent\"}", now: now - 7200)
        try store.addMessage(dir: .incoming, peer: desktop, type: "text", content: "Meeting moved to 3 pm, room B", n: nil,
                             pairingId: nil, read: true, results: nil, now: now - 1500)
        try store.addMessage(dir: .incoming, peer: laptop, type: "url", content: link, n: nil, pairingId: nil,
                             read: false, results: nil, now: now - 120)
        if args.contains("-PAScreenshotsPairing") {
            try store.db.exec("""
                INSERT INTO peers (id, state, listed, reachable, platform, created, name, name_n, fingerprint)
                VALUES (?, 'unruled', 1, 1, 'chrome', ?, 'New laptop', 1, 'K7QD')
                """, [.text(id("N")), .int(now - 50 * 86400)])  // oldest: the first row on screen
            try store.db.exec("""
                INSERT INTO pairing (peer_id, role, state, r, authorized, started_at, last_send_at)
                VALUES (?, 'X', 'shown', ?, 1, ?, ?)
                """, [.text(id("N")), .blob(Data(count: 32)), .int(now), .int(now)])
        }
        return store
    }

    /// Asks for notification permission, then posts the sample link one second later.
    static func notifyIfAsked() async {
        guard args.contains("-PAScreenshotsNotify") else { return }
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        let c = UNMutableNotificationContent()
        c.title = S.title
        c.body = link
        c.categoryIdentifier = BannerCategory.url.rawValue
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        try? await center.add(UNNotificationRequest(identifier: "pa-shots", content: c, trigger: trigger))
    }
}
#endif
