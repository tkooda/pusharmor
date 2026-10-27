import SwiftUI
import PushArmorCore

struct CodeEntryView: View {
    let email: String
    let purpose: AuthPurpose
    @EnvironmentObject var model: AppModel
    @State private var raw = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Enter the code")
                .font(.title2.bold())
            Text("We sent a code to \(email).")
            TextField("Code", text: $raw)
                .textFieldStyle(.roundedBorder)
                .font(.title3.monospaced())
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textContentType(.oneTimeCode)
                .onChange(of: raw) { _, new in handle(new) }
            if busy { ProgressView() }
            Button("Back") { model.phase = .signIn(purpose) }
            Spacer()
        }
        .padding(24)
    }

    private func handle(_ input: String) {
        guard !busy else { return }
        if let code = EmailCode.submittable(input) {
            if raw != code { raw = code }
            busy = true
            Task {
                await model.emailVerify(code, purpose: purpose)
                busy = false
                raw = ""
            }
            return
        }
        let cleaned = EmailCode.clean(input)
        if cleaned != input { raw = cleaned }
    }
}
