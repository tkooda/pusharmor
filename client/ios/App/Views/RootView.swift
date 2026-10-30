import SwiftUI
import UIKit
import PushArmorCore

/// Root screen: one view per AppModel.Phase, plus the shared error alert and toast.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        content
            .overlay(alignment: .bottom) {
                if let t = model.toast {
                    Text(t)
                        .font(.callout)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.bottom, 24)
                        .padding(.horizontal, 16)
                        .transition(.opacity)
                        .allowsHitTesting(false)
                }
            }
            .animation(.default, value: model.toast)
            .task(id: model.toast) {
                guard let t = model.toast else { return }
                // VoiceOver reads the toast; slow readers get it on screen for longer.
                UIAccessibility.post(notification: .announcement, argument: t)
                let slow = UIAccessibility.isVoiceOverRunning || typeSize.isAccessibilitySize
                try? await Task.sleep(nanoseconds: slow ? 8_000_000_000 : 4_000_000_000)
                if !Task.isCancelled { model.toast = nil }
            }
            .alert("PushArmor", isPresented: Binding(
                get: { model.errorText != nil },
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
            SignInView(purpose: purpose)
        case .code(let email, let purpose):
            CodeEntryView(email: email, purpose: purpose)
        case .limitPicker:
            LimitPickerView()
        case .nameDevice:
            NameDeviceView()
        case .main:
            MainView()
        case .removed:
            VStack(spacing: 20) {
                Text(S.thisDeviceRemoved)
                    .multilineTextAlignment(.center)
                Button("Log in") { model.phase = .signIn(.register) }
                    .buttonStyle(.borderedProminent)
            }
            .padding(24)
        case .banned:
            Text("This account is blocked.")
                .multilineTextAlignment(.center)
                .padding(24)
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
