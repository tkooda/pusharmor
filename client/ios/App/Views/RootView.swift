import SwiftUI
import PushArmorCore

/// Root screen: one view per AppModel.Phase, plus the shared error alert and toast.
struct RootView: View {
    @EnvironmentObject var model: AppModel

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
                guard model.toast != nil else { return }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
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
                Button("Sign in") { model.phase = .signIn(.register) }
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
                SignInView(purpose: .unpause)
            }
        }
    }
}

struct WelcomeView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Text("PushArmor")
                .font(.largeTitle.bold())
            Text("PushArmor sends links, text and phone numbers between your own devices, end to end encrypted. Allow notifications so this device can receive them.")
            Button("Allow notifications") { Task { await model.requestNotifications() } }
                .buttonStyle(.borderedProminent)
            if model.notificationsOff {
                Text(S.notificationsOff)
                    .foregroundColor(.red)
                Button("Open notification settings") { model.openNotificationSettings() }
                    .buttonStyle(.bordered)
            }
            Spacer()
        }
        .padding(24)
    }
}
