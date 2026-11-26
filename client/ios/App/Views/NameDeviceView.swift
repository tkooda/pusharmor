import SwiftUI
import UIKit
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
                Button("Save", action: save)
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy.contains("setName"))
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        // a new setup: the field starts with the device type as the name
        .onAppear {
            if name.isEmpty {
                name = Self.defaultName(pad: UIDevice.current.userInterfaceIdiom == .pad, taken: model.peers.compactMap { $0.name })
            }
        }
    }

    /// The name a new setup offers: "iPhone" or "iPad", with " (2)" and up when another device
    /// on the account already has it.
    static func defaultName(pad: Bool, taken: [String]) -> String {
        DeviceName.uniqueDefault(pad ? "iPad" : "iPhone", taken: taken)
    }

    /// Save, and the Return key: only a valid name, one run at a time. A name that breaks the
    /// rule shows why and stays in the field.
    private func save() {
        guard !model.busy.contains("setName") else { return }
        let c = DeviceName.checkInput(name)
        guard let n = c.name else { model.toast = c.error; return }
        Task { await model.setName(n) }
    }
}
