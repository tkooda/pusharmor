import Combine
import SwiftUI
import UIKit
import PushArmorCore

/// Root screen: one view per AppModel.Phase, plus the launch error alert and the bottom banner.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // after a 426 nothing else works, so the update screen replaces every other one.
        Group { if model.updateRequired { UpdateView() } else { content } }
            .onReceive(NotificationCenter.default.publisher(for: APIClient.upgradeRequired).receive(on: RunLoop.main)) { _ in
                model.updateRequired = true
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if !model.updateRequired && model.showsCannotReceive { CannotReceiveBanner() }
            }
            // the banner sits at the bottom, inside the safe area; on the tabs MainView puts
            // it above the tab bar and below the Send bar, so it covers neither.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !model.updateRequired && !model.showsTabs { ToastBanner() }
            }
            .animation(.easeOut(duration: 0.1), value: model.toast)
            .task(id: model.toast) {
                guard let t = model.toast else { return }
                #if DEBUG
                if ScreenshotSample.staysOnScreen { return } // screen review: the results stay on screen
                #endif
                // VoiceOver reads the banner; slow readers get it on screen for longer.
                UIAccessibility.post(notification: .announcement, argument: ToastText.shown(t))
                let slow = UIAccessibility.isVoiceOverRunning || typeSize.isAccessibilitySize
                let seconds: UInt64 = model.toastIsSuccess ? (slow ? 6 : 2) : (slow ? 8 : 4)
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                if !Task.isCancelled { model.toast = nil }
            }
            .alert(S.launchFailedTitle, isPresented: Binding(
                // no error alert over the update screen: every call fails there
                get: { model.errorText != nil && !model.updateRequired },
                set: { if !$0 { model.errorText = nil } }
            )) {
                Button("OK", role: .cancel) { model.errorText = nil }
            } message: {
                Text(model.errorText ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
        case .welcome:
            WelcomeView()
        case .signIn(let purpose):
            Group {
                if model.repairedNotice {
                    VStack(spacing: 0) {
                        Text(S.deviceReset)
                            .font(.headline)
                            .multilineTextAlignment(.center)
                            .padding(.top, 24)
                            .padding(.horizontal, 16)
                        SignInView(purpose: purpose)
                    }
                } else {
                    SignInView(purpose: purpose)
                }
            }
            .modifier(SettingsGear(shown: purpose != .deleteAccount))
        case .code(let email, let purpose):
            CodeEntryView(email: email, purpose: purpose)
        case .limitPicker:
            LimitPickerView()
        case .nameDevice:
            NameDeviceView()
        case .main:
            MainView()
        case .removed:
            CenteredScroll {
                VStack(spacing: 20) {
                    Text(S.thisDeviceRemoved)
                        .multilineTextAlignment(.center)
                    Button("Log in") { model.phase = .signIn(.register) }
                        .buttonStyle(.borderedProminent)
                }
                .padding(24)
            }
        case .banned:
            CenteredScroll {
                Text("This account is blocked.")
                    .multilineTextAlignment(.center)
                    .padding(24)
            }
        case .keysBroken:
            KeysBrokenView()
        case .dataBroken:
            DataBrokenView()
        case .signedOut:
            VStack(spacing: 0) {
                Text(S.signedOutResume)
                    .font(.headline)
                    .padding(.top, 24)
                    .padding(.horizontal, 16)
                SignInView(purpose: .login)
            }
            .modifier(SettingsGear(shown: true))
        }
    }
}

/// The saved keys failed the launch check. Retry runs the launch again on this device
/// only; Delete broken keys asks first, then deletes them and opens the sign-in.
struct KeysBrokenView: View {
    @EnvironmentObject var model: AppModel
    @State private var confirmDelete = false

    var body: some View {
        CenteredScroll {
            VStack(spacing: 16) {
                Text(S.keysBrokenTitle)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text(S.keysBrokenBody)
                    .foregroundColor(.secondaryText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 330)
                // Retry is the primary action, on the right; stacks at large text sizes
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { buttons }
                    VStack(spacing: 12) { buttons }
                }
                .padding(.top, 8)
            }
            .padding(24)
        }
        // standard alert; Cancel and the destructive action are placed by the system
        .alert(S.keysBrokenConfirmTitle, isPresented: $confirmDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { model.deleteBrokenKeys() }
        } message: {
            Text(S.keysBrokenConfirmBody)
        }
    }

    @ViewBuilder private var buttons: some View {
        Button("Delete broken keys", role: .destructive) { confirmDelete = true }
            .buttonStyle(.bordered)
        Button("Retry") { Task { await model.retryKeys() } }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy.contains("open"))
    }
}

/// pa.sqlite is corrupt. Retry opens it again on this device only; Reset this device asks
/// first, then deletes this device and its data and opens the sign-in.
struct DataBrokenView: View {
    @EnvironmentObject var model: AppModel
    @State private var confirmReset = false

    var body: some View {
        CenteredScroll {
            VStack(spacing: 16) {
                Text(S.dataBrokenTitle)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text(S.dataBrokenBody)
                    .foregroundColor(.secondaryText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 330)
                // Retry is the primary action, on the right; stacks at large text sizes
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { buttons }
                    VStack(spacing: 12) { buttons }
                }
                .padding(.top, 8)
                // the reset deletes this device on the relay server first, which can take a while
                if model.busy.contains("reset") { ProgressView() }
            }
            .padding(24)
        }
        // standard alert; Cancel and the destructive action are placed by the system
        .alert(S.dataBrokenConfirmTitle, isPresented: $confirmReset) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) { Task { await model.resetDevice() } }
        } message: {
            Text(S.dataBrokenConfirmBody)
        }
    }

    @ViewBuilder private var buttons: some View {
        Button("Reset this device", role: .destructive) { confirmReset = true }
            .buttonStyle(.bordered)
            .disabled(model.busy.contains("open"))
        Button("Retry") { Task { await model.retryKeys() } }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy.contains("open"))
    }
}

/// Logged out: no tabs, so a gear at the top right opens Settings.
struct SettingsGear: ViewModifier {
    let shown: Bool
    @State private var show = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                if shown {
                    Button { instantly { show = true } } label: {
                        Image(systemName: "gearshape")
                            .font(.title3)
                            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Settings")
                    .padding(.trailing, 8)
                }
            }
            .sheet(isPresented: $show) { SettingsView() }
    }
}

/// Notifications are off, the relay server does not take this device's push service, or the
/// relay server cannot reach Apple's push service: a light red
/// banner at the top that stays while the cause lasts. It has no close control.
struct CannotReceiveBanner: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text(S.cannotReceive)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if model.notificationsOff {
                    // not yet asked: the Allow notifications button shows the system prompt
                    if !model.notificationsUndecided {
                        Text(S.allowNotifications)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if model.pushUnsupported {
                    Text(ErrorCopy.Reason.pushNotSupported.line)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(S.relayFaultApple)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // the primary action is on the right; stacks at large text sizes
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { buttons }
                    VStack(alignment: .leading, spacing: 6) { buttons }
                }
            }
            .foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.red.opacity(0.15), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    enum Action: String {
        case checkAgain = "Check again"
        case openSettings = "Open notification settings"
        case allow = "Allow notifications"
    }

    /// The buttons, left to right: Check again on every banner. Notifications off: Allow
    /// notifications (system prompt) while not yet asked, else Open notification settings.
    static func actions(notificationsOff: Bool, undecided: Bool) -> [Action] {
        guard notificationsOff else { return [.checkAgain] }
        return undecided ? [.checkAgain, .allow] : [.checkAgain, .openSettings]
    }

    private var buttons: some View {
        ForEach(CannotReceiveBanner.actions(notificationsOff: model.notificationsOff,
                                                   undecided: model.notificationsUndecided), id: \.self) { a in
            // Check again stays greyed 10 s after a tap; the timeline turns it back on.
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Button(a.rawValue) {
                    switch a {
                    case .checkAgain: Task { await model.checkAgain() }
                    case .openSettings: model.openNotificationSettings()
                    case .allow: Task { await model.requestNotifications() }
                    }
                }
                .font(.subheadline)
                .buttonStyle(.borderless)
                .disabled(a == .checkAgain && (model.busy.contains("check") || model.checkGreyed(at: ctx.date)))
            }
        }
    }
}

/// The bottom banner for transient messages: a success check or a warning sign, the
/// text in the system font, on a material card. A tap dismisses it.
struct ToastBanner: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if let t = model.toast {
            let ok = model.toastIsSuccess
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(ok ? Color.green : Color.orange)
                    .accessibilityHidden(true)
                Text(ToastText.shown(t))
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
            .onTapGesture { model.toast = nil }
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isStaticText)
            .accessibilityIdentifier("banner")
        }
    }
}

/// this version got HTTP 426 from the relay server; the button opens the download page.
struct UpdateView: View {
    static let downloadURL = URL(string: "https://pusharmor.com/download")!

    var body: some View {
        CenteredScroll {
            VStack(spacing: 16) {
                Wordmark(size: 36)
                Text(S.updateTitle)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text(S.updateBody)
                    .foregroundColor(.secondaryText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 330)
                Button("Update") { UIApplication.shared.open(Self.downloadURL) }
                    .buttonStyle(GreenButtonStyle())
                    .padding(.top, 8)
            }
            .padding(24)
        }
    }
}

/// A short centred screen that scrolls once large text makes it taller than the screen.
struct CenteredScroll<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                content()
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

struct WelcomeView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        BrandLayout(text: WelcomeText.text(undecided: model.notificationsUndecided)) {
            if model.notificationsUndecided {
                Button("Allow notifications") { Task { await model.requestNotifications() } }
                    .buttonStyle(GreenButtonStyle())
            } else {
                // denied or alerts off: only Settings can turn them on
                Button("Open notification settings") { model.openNotificationSettings() }
                    .buttonStyle(GreenButtonStyle())
            }
        }
    }
}
