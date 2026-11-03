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
    @Environment(\.dynamicTypeSize) private var typeSize

    private var dayChoices: [Int] { Array(Set([1, 7, 30, 90, 365, model.historyDays])).sorted() }
    private var email: String? { model.me?.signedInEmail }
    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    var body: some View {
        NavigationStack {
            Form {
                // This device and its rename live here, not in Devices (F25); logged out, the
                // device name and account rows hide.
                if model.phase == .main {
                    Section("Device name") {
                        // Inline rename: Rename turns the name into a field, with Cancel and Save.
                        // Large text: Cancel and Save go below the field.
                        let stack = renaming && typeSize.isAccessibilitySize
                        let row = stack ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(spacing: 16))
                        row {
                            if renaming {
                                TextField("Name this device", text: $name)
                                    .autocorrectionDisabled()
                                    .focused($nameFocused)
                                    .submitLabel(.done)
                                    .onSubmit(saveName)
                                    .onAppear { nameFocused = true }
                                HStack(spacing: 16) {
                                    Button("Cancel") { renaming = false }
                                    Button("Save", action: saveName)
                                        .disabled(!NameEntry.isValidName(name))
                                }
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
                            // Dim label, the address on its own line, truncated in the middle.
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Logged in as")
                                    .font(.footnote)
                                    .foregroundColor(.secondaryText)
                                Text(e)
                                    .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
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

                Section("Sending") {
                    Toggle("Show an \"All\" button when choosing devices", isOn: boolBinding(SettingKey.showAll, true))
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
                    // Was Always hide content, inverted; lock screen applies only while content shows.
                    Toggle(S.showContentSwitch, isOn: boolBinding(SettingKey.showContent, true))
                    Text("When off, every notification shows \"New message from\" and the device name, with no content.")
                        .font(.caption).foregroundColor(.secondaryText)
                    Toggle(S.lockScreenSwitch, isOn: boolBinding(SettingKey.lockShow, true))
                        .disabled(!model.boolSetting(SettingKey.showContent, true))
                    Text("Follows the iOS Show Previews setting. Set it to When Unlocked to hide content on the lock screen. Your Apple Watch follows this choice.")
                        .font(.caption).foregroundColor(.secondaryText)
                }

                Section("History") {
                    Picker("Delete messages older than", selection: Binding(
                        get: { model.historyDays },
                        set: { model.setHistoryDays($0) }
                    )) {
                        ForEach(dayChoices, id: \.self) { Text($0 == 1 ? "1 day" : "\($0) days").tag($0) }
                    }
                    Button("Delete all history", role: .destructive) { confirmDeleteHistory = true }
                }

                if model.phase == .main {
                    Section("Account") {
                        // One centered row, Delete account then Log out. Log out acts at once.
                        // Stacks at large text sizes.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 32) { accountButtons }
                            VStack(spacing: 12) { accountButtons }
                        }
                        .buttonStyle(.borderless)
                        .frame(maxWidth: .infinity)
                    }
                }

                Section {
                    HStack(spacing: 8) {
                        BrandTileView(size: 30)
                        Wordmark(size: 22)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                    Text("License: MIT")
                    if let u = URL(string: "https://github.com/pusharmor/pusharmor") {
                        Link("Source", destination: u)
                    }
                    if let u = URL(string: "https://pusharmor.com/privacy") {
                        Link("Privacy policy", destination: u)
                    }
                } header: {
                    Text("About")
                } footer: {
                    Text(VersionText.make(version))
                }
            }
            // Like the other tabs: the last About row ends clear of the floating tab bar.
            .contentMargins(.bottom, 12, for: .scrollContent)
            .navigationTitle("Settings")
            // standard alerts; Cancel and the destructive action are placed by the system
            .alert("Delete all history?", isPresented: $confirmDeleteHistory) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) { model.deleteAllHistory() }
            } message: {
                Text("This deletes every sent and received message on this device.")
            }
            .alert("Delete account?", isPresented: $confirmDeleteAccount) {
                Button("Cancel", role: .cancel) {}
                Button("Continue", role: .destructive) { model.phase = .signIn(.deleteAccount) }
            } message: {
                Text("You must log in again to confirm. This cannot be undone.")
            }
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
