import SwiftUI
import PushArmorCore

struct NameDeviceView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""

    var body: some View {
        // scrolls at the largest text sizes
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Name this device")
                    .font(.title2.bold())
                TextField("Name this device", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .onSubmit(save)
                Text("Use 1 to 32 plain ASCII characters, with no double quote.")
                    .font(.caption)
                    .foregroundColor(.secondaryText)
                Button("Save", action: save)
                    .buttonStyle(.borderedProminent)
                    .disabled(!NameEntry.isValidName(name) || model.busy.contains("setName"))
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    /// Save, and the Return key: only a valid name, one run at a time.
    private func save() {
        guard NameEntry.isValidName(name), !model.busy.contains("setName") else { return }
        Task { await model.setName(name) }
    }
}
