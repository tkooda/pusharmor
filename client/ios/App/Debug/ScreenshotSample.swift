#if DEBUG
import Foundation
import UserNotifications
import PushArmorCore

/// Store screenshot mode (debug builds only; tools/check-release-bundle.sh fails on it in a
/// release app). The launch argument -PAScreenshots opens a sample database in the temporary
/// directory: no App Group, no Keychain, no Core, so no Worker call. -PAScreenshotsPairing
/// adds an open pairing; -PAScreenshotsNotify posts a local sample notification;
/// -PAScreenshotsSignIn opens the sign-in screen (review images only); -PAScreenshotsEmpty
/// has no other device at all (the first-pair screen). Screen review only: -PAScreenshotsNoHistory
/// has no messages; -PAScreenshotsSent shows send results that stay on screen
/// (-PAScreenshotsSentOK: a full success);
/// -PAScreenshotsUpdate opens the update-required screen.
enum ScreenshotSample {
    private static let args = ProcessInfo.processInfo.arguments
    static var isOn: Bool { args.contains("-PAScreenshots") }
    static var signIn: Bool { args.contains("-PAScreenshotsSignIn") }
    static var update: Bool { args.contains("-PAScreenshotsUpdate") }
    /// The send error toast of an offline send (about-page shot); it stays on screen.
    static var sendErrorToast: String? { args.contains("-PAScreenshotsSendError") ? "Not sent. Try again." : nil }
    static var staysOnScreen: Bool { sentToast != nil || sendErrorToast != nil }
    /// The send results toast for a send to all three sample devices (I564 lines);
    /// -PAScreenshotsSentOK shows the success banner of a send to one device (I604).
    static var sentToast: String? {
        if sentOK { return S.messageSentTo("Laptop") }
        return args.contains("-PAScreenshotsSent") ? [S.sentTo(2, 3), S.signedOutPeer("Tablet")].joined(separator: "\n") : nil
    }
    static var sentOK: Bool { args.contains("-PAScreenshotsSentOK") }

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
        try store.setMe("id", .text("Kx3mQ9vTbR2wYp7LdZ4hNc8sJf5aUe1GoXi6VtBy"))  // mixed characters: a repeated one looks wrong in review images
        try store.setMe("name", .text("iPhone"))
        if args.contains("-PAScreenshotsEmpty") { return store }
        // 04-pairing: the pairing card only. Paired rows below them would sit under
        // the floating tab bar, which content scrolls behind by design.
        if args.contains("-PAScreenshotsPairing") {
            try store.db.exec("""
                INSERT INTO peers (id, state, listed, reachable, platform, created, name, name_n, fingerprint)
                VALUES (?, 'unruled', 1, 1, 'chrome', ?, 'New laptop', 1, 'K7QD')
                """, [.text(id("N")), .int(now - 50 * 86400)])  // oldest: the first row on screen
            try store.db.exec("""
                INSERT INTO pairing (peer_id, role, state, r, authorized, started_at, last_send_at)
                VALUES (?, 'X', 'shown', ?, 1, ?, ?)
                """, [.text(id("N")), .blob(Data(count: 32)), .int(now), .int(now)])
            return store
        }
        let peers: [(String, String, String, Int64)] = [
            (id("L"), "chrome", "Laptop", now - 40 * 86400),
            (id("W"), "firefox", "Work desktop", now - 30 * 86400),
            (id("T"), "android", "Tablet", now - 20 * 86400),
        ]
        // -PAScreenshotsMore: a fourth device (about-page devices list)
        let more: [(String, String, String, Int64)] = args.contains("-PAScreenshotsMore")
            ? [(id("P"), "ios", "Phone", now - 10 * 86400)] : []
        for (pid, platform, name, created) in peers + more {
            try store.db.exec("""
                INSERT INTO peers (id, sign_pub, enc_pub, state, listed, approve_verified, approve_verified_at, reachable,
                  platform, created, name, name_n, pairing_id) VALUES (?, ?, ?, 'approved', 1, 1, ?, 1, ?, ?, ?, 1, ?)
                """, [.text(pid), .blob(Data(repeating: 2, count: 65)), .blob(Data(repeating: 3, count: 65)), .int(created),
                      .text(platform), .int(created), .text(name), .blob(Data(repeating: 1, count: 16))])
        }
        if args.contains("-PAScreenshotsNoHistory") { return store }
        guard let laptop = PeerId(text: id("L")), let desktop = PeerId(text: id("W"))
        else { return store }
        // History times sit just before the 9:41 status bar clock (History tab).
        let clock = Int64((Calendar.current.date(bySettingHour: 9, minute: 41, second: 0, of: Date()) ?? Date())
            .timeIntervalSince1970)
        try store.addMessage(dir: .incoming, peer: desktop, type: "text", content: "Meeting moved to 3 pm, room B", n: nil,
                             pairingId: nil, read: true, results: nil, now: clock - 1500)
        try store.addMessage(dir: .incoming, peer: laptop, type: "url", content: link, n: nil, pairingId: nil,
                             read: false, results: nil, now: clock - 120)
        let results = "{\"\(id("L"))\":\"sent\",\"\(id("W"))\":\"sent\",\"\(id("T"))\":\"logged out\"}"
        try store.addMessage(dir: .outgoing, peer: laptop, type: "url", content: draft, n: nil, pairingId: nil,
                             read: true, results: results, now: clock - 600)
        return store
    }

    /// Asks for notification permission, then posts the sample link one second later.
    static func notifyIfAsked() async {
        guard args.contains("-PAScreenshotsNotify") else { return }
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        center.removeAllDeliveredNotifications() // a relaunch shows the banner again
        let c = UNMutableNotificationContent()
        c.title = S.title
        c.body = link
        c.categoryIdentifier = BannerCategory.url.rawValue
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        try? await center.add(UNNotificationRequest(identifier: "pa-shots", content: c, trigger: trigger))
    }
}
#endif
