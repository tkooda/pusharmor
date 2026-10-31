import SwiftUI
import PushArmorCore

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @FocusState private var nameFocused: Bool
    @State private var renaming = false
    @State private var confirmDeleteHistory = false
    @State private var confirmDeleteAccount = false
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.system.rawValue

    private var dayChoices: [Int] { Array(Set([1, 7, 30, 90, 365, model.historyDays])).sorted() }
    private var email: String? { model.me?.signedInEmail }
    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Show \"All\" option", isOn: boolBinding(SettingKey.showAll, true))
                        .tint(.brandGreen)
                }

                Section("History") {
                    Picker("Keep messages for", selection: Binding(
                        get: { model.historyDays },
                        set: { model.setHistoryDays($0) }
                    )) {
                        ForEach(dayChoices, id: \.self) { Text($0 == 1 ? "1 day" : "\($0) days").tag($0) }
                    }
                    if confirmDeleteHistory {
                        Text("Delete all history?")
                        HStack {
                            Button("Delete", role: .destructive) {
                                confirmDeleteHistory = false
                                model.deleteAllHistory()
                            }
                            Button("Cancel") { confirmDeleteHistory = false }
                        }
                        .buttonStyle(.borderless)
                    } else {
                        Button("Delete all history", role: .destructive) { confirmDeleteHistory = true }
                    }
                }

                let hidden = model.peers.filter { $0.hidden }
                if !hidden.isEmpty {
                    Section("Hidden devices") {
                        ForEach(hidden, id: \.id.text) { p in
                            HStack {
                                Text(model.label(p))
                                Spacer()
                                Button("Unhide") { model.setHidden(p, false) }
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                }

                Section("Notifications") {
                    if model.notificationsOff {
                        Text(S.notificationsOff).foregroundColor(.errorText)
                        Button("Open notification settings") { model.openNotificationSettings() }
                    } else {
                        Label {
                            Text("Notifications are on")
                        } icon: {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.success)
                        }
                    }
                }

                // This device and its rename live here, not in Devices (F25); logged out, the
                // device name and account rows hide (I612).
                if model.phase == .main {
                    Section("Device name") {
                        // Inline rename: Rename turns the name into a field, with Cancel and Save (I609).
                        HStack(spacing: 16) {
                            if renaming {
                                TextField("Name this device", text: $name)
                                    .autocorrectionDisabled()
                                    .focused($nameFocused)
                                    .submitLabel(.done)
                                    .onSubmit(saveName)
                                    .onAppear { nameFocused = true }
                                Button("Cancel") { renaming = false }
                                Button("Save", action: saveName)
                                    .disabled(!NameEntry.isValidName(name))
                            } else {
                                Text(model.me?.name ?? "This device")
                                Spacer(minLength: 8)
                                Button("Rename") {
                                    name = model.me?.name ?? ""
                                    renaming = true
                                }
                            }
                        }
                        .buttonStyle(.borderless)
                        if let e = email {
                            // Dim label, the address on its own line, truncated in the middle (I460).
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Logged in as")
                                    .font(.footnote)
                                    .foregroundColor(.secondaryText)
                                Text(e)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .accessibilityElement(children: .combine)
                            if e.lowercased().hasSuffix("@privaterelay.appleid.com") {
                                Text(S.relayHelp).font(.caption).foregroundColor(.secondaryText)
                            }
                        }
                    }
                }

                Section {
                    Picker("Theme", selection: Binding(
                        get: { AppearancePreference(stored: appearance) },
                        set: { appearance = $0.rawValue }
                    )) {
                        ForEach(AppearancePreference.allCases) { Text($0.title).tag($0) }
                    }
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("Dark uses a true black background.")
                }

                Section {
                    // Was Always hide content, inverted; lock screen applies only while content shows (I610).
                    Toggle(S.showContentSwitch, isOn: boolBinding(SettingKey.showContent, true))
                        .tint(.brandGreen)
                    Text("When off, every notification shows \"New message from\" and the device name, with no content.")
                        .font(.caption).foregroundColor(.secondaryText)
                    Toggle(S.lockScreenSwitch, isOn: boolBinding(SettingKey.lockShow, true))
                        .tint(.brandGreen)
                        .disabled(!model.boolSetting(SettingKey.showContent, true))
                    Text("Follows the iOS Show Previews setting. Set it to When Unlocked to hide content on the lock screen. Your Apple Watch follows this choice.")
                        .font(.caption).foregroundColor(.secondaryText)
                }

                if model.phase == .main {
                    Section("Account") {
                        if confirmDeleteAccount {
                            Text("Delete this account? You must log in again to confirm. This cannot be undone.")
                            HStack {
                                Button("Continue", role: .destructive) {
                                    confirmDeleteAccount = false
                                    model.phase = .signIn(.deleteAccount)
                                }
                                Button("Cancel") { confirmDeleteAccount = false }
                            }
                            .buttonStyle(.borderless)
                        } else {
                            // One centered row, Delete account then Log out (I610). Log out acts at once (Q367);
                            // it hides while the Delete account confirm shows (I457). Stacks at large text sizes.
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 32) { accountButtons }
                                VStack(spacing: 12) { accountButtons }
                            }
                            .buttonStyle(.borderless)
                            .frame(maxWidth: .infinity)
                        }
                    }
                }

                Section("About") {
                    HStack(spacing: 8) {
                        BrandTileView(size: 30)
                        Wordmark(size: 22)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                    LabeledContent("Version", value: version)
                    Text("License: MIT")
                    if let u = URL(string: "https://github.com/pusharmor/pusharmor") {
                        Link("Source", destination: u)
                    }
                    if let u = URL(string: "https://pusharmor.com/privacy") {
                        Link("Privacy policy", destination: u)
                    }
                }
            }
            // Like the other tabs: the last About row ends clear of the floating tab bar (I569).
            .contentMargins(.bottom, 12, for: .scrollContent)
            .navigationTitle("Settings")
            .safeAreaInset(edge: .bottom, spacing: 0) { ToastBanner() }
        }
    }

    @ViewBuilder private var accountButtons: some View {
        Button("Delete account", role: .destructive) { confirmDeleteAccount = true }
        Button("Log out") { Task { await model.signOut() } }
    }

    private func saveName() {
        guard NameEntry.isValidName(name) else { return }
        renaming = false
        if name != model.me?.name { Task { await model.rename(name) } }
    }

    private func boolBinding(_ key: String, _ def: Bool) -> Binding<Bool> {
        Binding(
            get: { model.boolSetting(key, def) },
            set: { model.setBool(key, $0) }
        )
    }
}
