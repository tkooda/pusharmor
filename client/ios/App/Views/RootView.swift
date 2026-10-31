import Combine
import SwiftUI
import UIKit
import PushArmorCore

/// Root screen: one view per AppModel.Phase, plus the shared error alert and toast.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // Q349: after a 426 nothing else works, so the update screen replaces every other one.
        Group { if model.updateRequired { UpdateView() } else { content } }
            .onReceive(NotificationCenter.default.publisher(for: APIClient.upgradeRequired).receive(on: RunLoop.main)) { _ in
                model.updateRequired = true
            }
            .overlay(alignment: .center) { // centred: at the bottom it covered Send and the tab bar (I577), at the top the large title (I584)
                if let t = model.toast, !model.updateRequired {
                    Text(t)
                        .font(.callout)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.horizontal, 16)
                        .transition(.opacity)
                        .allowsHitTesting(false)
                }
            }
            .animation(.default, value: model.toast)
            .task(id: model.toast) {
                guard let t = model.toast else { return }
                #if DEBUG
                if ScreenshotSample.sentToast != nil { return } // screen review: the results stay on screen
                #endif
                // VoiceOver reads the toast; slow readers get it on screen for longer.
                UIAccessibility.post(notification: .announcement, argument: t)
                let slow = UIAccessibility.isVoiceOverRunning || typeSize.isAccessibilitySize
                try? await Task.sleep(nanoseconds: slow ? 8_000_000_000 : 4_000_000_000)
                if !Task.isCancelled { model.toast = nil }
            }
            .alert("PushArmor", isPresented: Binding(
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
