import SwiftUI
import UIKit
import UserNotifications
import PushArmorCore

@main
struct PushArmorApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(delegate.model)
                .onAppear { AppearancePreference(stored: appearance).apply() }
                .task { await delegate.model.start() }
        }
        .onChange(of: appearance) { _, v in
            AppearancePreference(stored: v).apply()
        }
        .onChange(of: scenePhase) { _, p in
            if p == .active {
                AppearancePreference(stored: appearance).apply()
                Task { await delegate.model.onForeground() }
            } else if p == .background {
                FileTransfers.shared.clearActive()
                Task { @MainActor in delegate.model.saveDraft() }
            }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor lazy var model = AppModel()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await model.didRegister(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in model.didFailToRegister() }
    }

    /// A file transfer session has events for the app (a download the NSE started, or an upload
    /// the share sheet started): the session is attached and its delegate settles each task.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        FileTransfers.shared.attach(identifier, completion: completionHandler)
    }

    /// A background push is only ever the relay server's test push: nothing to do, no notification.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        .noData
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        if action == "OK" { return }
        await model.handleTap(info, action: action)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        FileTransfers.shared.stampActive()
        // a file that arrived now was left to the app (the NSE skips while the app is in front)
        FileTransfers.shared.catchUpInFront()
        Task { @MainActor in model.reload() }
        return [.banner, .sound, .list]
    }
}
