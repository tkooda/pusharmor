import SwiftUI
import UIKit
import PushArmorCore

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @State private var confirmDeleteHistory = false
    @State private var confirmSignOut = false
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
                    Picker("Auto-delete after", selection: Binding(
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

                Section("This device") {
                    TextField("Name this device", text: $name)
                        .autocorrectionDisabled()
                    Button("Save") { Task { await model.rename(name) } }
                        .disabled(!NameEntry.isValidName(name) || name == model.me?.name)
                    if let id = model.me?.id?.text {
                        HStack {
                            Text(id)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                            Spacer()
                            Button("Copy") { UIPasteboard.general.string = id }
                                .buttonStyle(.borderless)
                        }
                    }
                    if let e = email {
                        Text(S.signedInAs(e))
                        if e.lowercased().hasSuffix("@privaterelay.appleid.com") {
                            Text(S.relayHelp).font(.caption).foregroundColor(.secondaryText)
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
                    Toggle(S.lockScreenSwitch, isOn: boolBinding(SettingKey.lockShow, true))
                        .tint(.brandGreen)
                    Text("Follows the iOS Show Previews setting. Set it to When Unlocked to hide content on the lock screen. Your Apple Watch follows this choice. To hide content at all times, turn on Always hide content.")
                        .font(.caption).foregroundColor(.secondaryText)
                    Toggle(S.alwaysHide, isOn: boolBinding(SettingKey.alwaysHide, false))
                        .tint(.brandGreen)
                    Text("Every notification shows \"New message from\" and the device name, with no content.")
                        .font(.caption).foregroundColor(.secondaryText)
                }

                Section("Account") {
                    if confirmSignOut {
                        Text("Log out of this device? Keys, paired devices, names, and history stay on this device.")
                        HStack {
                            Button("Log out", role: .destructive) {
                                confirmSignOut = false
                                Task { await model.signOut() }
                            }
                            Button("Cancel") { confirmSignOut = false }
                        }
                        .buttonStyle(.borderless)
                    } else {
                        Button("Log out") { confirmSignOut = true }
                    }
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
                        Button("Delete account", role: .destructive) { confirmDeleteAccount = true }
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
            .navigationTitle("Settings")
            .onAppear { name = model.me?.name ?? "" }
        }
    }

    private func boolBinding(_ key: String, _ def: Bool) -> Binding<Bool> {
        Binding(
            get: { model.boolSetting(key, def) },
            set: { model.setBool(key, $0) }
        )
    }
}
