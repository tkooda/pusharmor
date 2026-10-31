import Combine
import SwiftUI
import UIKit
import PushArmorCore

/// Root screen: one view per AppModel.Phase, plus the launch error alert and the bottom banner.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // Q349: after a 426 nothing else works, so the update screen replaces every other one.
        Group { if model.updateRequired { UpdateView() } else { content } }
            .onReceive(NotificationCenter.default.publisher(for: APIClient.upgradeRequired).receive(on: RunLoop.main)) { _ in
                model.updateRequired = true
            }
            // I604: the banner sits at the bottom, inside the safe area; on the tabs MainView puts
            // it above the tab bar and below the Send bar, so it covers neither (I577).
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !model.updateRequired && !model.showsTabs { ToastBanner() }
            }
            .animation(.default, value: model.toast)
            .task(id: model.toast) {
                guard let t = model.toast else { return }
                #if DEBUG
                if ScreenshotSample.staysOnScreen { return } // screen review: the results stay on screen
                #endif
                // VoiceOver reads the banner; slow readers get it on screen for longer.
                UIAccessibility.post(notification: .announcement, argument: t)
                let slow = UIAccessibility.isVoiceOverRunning || typeSize.isAccessibilitySize
                let seconds: UInt64 = model.toastIsSuccess ? (slow ? 6 : 2) : (slow ? 8 : 4)
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                if !Task.isCancelled { model.toast = nil }
            }
            .alert(S.launchFailedTitle, isPresented: Binding(
                // no error alert over the update screen: every call fails there (Q349)
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
                        Text(S.storeRepaired)
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

/// Logged out (I612): no tabs, so a gear at the top right opens Settings.
struct SettingsGear: ViewModifier {
    let shown: Bool
    @State private var show = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                if shown {
                    Button { show = true } label: {
                        Image(systemName: "gearshape")
                            .font(.title3)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Settings")
                    .padding(.trailing, 8)
                }
            }
            .sheet(isPresented: $show) { SettingsView() }
    }
}

/// The bottom banner for transient messages (I604): a success check or a warning sign, the
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
                Text(t)
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

/// Q349: this version got HTTP 426 from the relay server; the button opens the download page.
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

/// A short centred screen that scrolls once large text makes it taller than the screen (I503).
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
        BrandLayout(text: WelcomeText.intro + " Allow notifications so this device can receive them.") {
            Button("Allow notifications") { Task { await model.requestNotifications() } }
                .buttonStyle(GreenButtonStyle())
            if model.notificationsOff {
                Text(S.notificationsOff)
                    .foregroundColor(.errorText)
                    .multilineTextAlignment(.center)
                Button("Open notification settings") { model.openNotificationSettings() }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
            }
        }
    }
}
