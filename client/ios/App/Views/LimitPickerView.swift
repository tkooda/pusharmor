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
                                    Text(S.thisPhoneOldInstall).font(.caption).foregroundColor(.secondary)
                                }
                                Text("Created " + Date(timeIntervalSince1970: TimeInterval(e.created)).formatted(date: .abbreviated, time: .omitted))
                                    .font(.caption).foregroundColor(.secondary)
                                Text("approves \(e.approves), approved by \(e.approvedBy)")
                                    .font(.caption).foregroundColor(.secondary)
                                if !e.reachable {
                                    Text("unreachable").font(.caption).foregroundColor(.orange)
                                }
                                if e.paused {
                                    Text("signed out").font(.caption).foregroundColor(.orange)
                                }
                            }
                        }
                    }
                } header: {
                    Text("This account has too many devices. Choose the ones to remove.")
                        .textCase(nil)
                }
            }
            .navigationTitle("Device limit")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.cancelLimit() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") { Task { await model.submitEvict() } }
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
