import SwiftUI
import PushArmorCore

struct NameDeviceView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Name this device")
                .font(.title2.bold())
            TextField("Name this device", text: $name)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            Text("1 to 32 plain ASCII characters.")
                .font(.caption)
                .foregroundColor(.secondary)
            Button("Save") { Task { await model.setName(name) } }
                .buttonStyle(.borderedProminent)
                .disabled(!NameEntry.isValidName(name))
            Spacer()
        }
        .padding(24)
    }
}
