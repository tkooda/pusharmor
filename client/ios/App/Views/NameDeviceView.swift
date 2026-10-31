import SwiftUI
import PushArmorCore

struct NameDeviceView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""

    var body: some View {
        // scrolls at the largest text sizes (I503)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Name this device")
                    .font(.title2.bold())
                TextField("Name this device", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                Text("1 to 32 plain ASCII characters, no double quotes.")
                    .font(.caption)
                    .foregroundColor(.secondaryText)
                Button("Save") { Task { await model.setName(name) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!NameEntry.isValidName(name))
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}
