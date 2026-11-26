import SwiftUI
import PushArmorCore

struct LimitPickerView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.limitEntries) { e in
                        Toggle(isOn: binding(e.id)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(PeerLabel.platformName(e.platform))
                                if e.oldInstall {
                                    Text(S.thisPhoneOldInstall).font(.caption).foregroundColor(.secondaryText)
                                }
                                if let id = PeerId(text: e.id) {
                                    Text("ID: " + Ids.deviceId(id.raw))
                                        .font(.caption).foregroundColor(.secondaryText)
                                }
                                Text("Added: " + PeerLabel.addedDate(e.created))
                                    .font(.caption).foregroundColor(.secondaryText)
                                Text(S.trusts(e.approves, trustedBy: e.approvedBy))
                                    .font(.caption).foregroundColor(.secondaryText)
                                if !e.reachable {
                                    Text(S.unreachable).font(.caption).foregroundColor(.warningText)
                                }
                                if e.loggedOut {
                                    Text(S.loggedOutBadge).font(.caption).foregroundColor(.warningText)
                                }
                            }
                        }
                    }
                } header: {
                    Text("This account has too many devices. Choose the ones to remove.")
                        .textCase(nil)
                }
                // removing the chosen devices, then logging in
                if model.busy.contains("evict"), let c = model.caption {
                    Section {
                        StepProgressView(caption: c)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle("Device limit")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.cancelLimit() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Remove", role: .destructive) { Task { await model.submitEvict() } }
                        .disabled(model.busy.contains("evict") || model.limitTicked.isEmpty)
                }
            }
        }
    }

    private func binding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { model.limitTicked.contains(id) },
            set: { on in
                if on { model.limitTicked.insert(id) } else { model.limitTicked.remove(id) }
            }
        )
    }
}
