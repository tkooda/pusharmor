import SwiftUI
import PushArmorCore

struct CodeEntryView: View {
    let email: String
    let purpose: AuthPurpose
    @EnvironmentObject var model: AppModel
    @State private var raw = ""
    @State private var busy = false
    @FocusState private var focused: Bool
    @ScaledMetric private var scaled: CGFloat = 28
    // Six cells share the width: past about 44 pt a monospaced glyph no longer fits a cell.
    private var cellSize: CGFloat { min(scaled, 44) }

    private var chars: [String] { EmailCode.clean(raw).map(String.init) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Enter the code")
                .font(.title2.bold())
            Text("We sent a code to \(email).")
            ZStack {
                HStack(spacing: 8) {
                    ForEach(0 ..< EmailCode.length, id: \.self) { i in
                        Text(i < chars.count ? chars[i] : " ")
                            .font(.system(size: cellSize, weight: .semibold, design: .monospaced))
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                            .foregroundStyle(Color.primary)
                            .frame(maxWidth: .infinity, minHeight: cellSize * 2)
                            .background(Color.fpCell, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(focused && i == min(chars.count, EmailCode.length - 1) ? Color.accentColor : Color(.systemGray),
                                            lineWidth: focused && i == min(chars.count, EmailCode.length - 1) ? 2 : 1)
                            )
                    }
                }
                .accessibilityHidden(true)
                // The field takes the typing and the one-time code; the cells show it.
                TextField("Code", text: $raw)
                    .focused($focused)
                    .foregroundStyle(Color.clear)
                    .tint(.clear)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textContentType(.oneTimeCode)
                    .keyboardType(.asciiCapable)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onChange(of: raw) { _, new in handle(new) }
            }
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
            .onAppear { focused = true }
            if busy { ProgressView() }
            Button("Back") { model.leaveCode(purpose) }
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
