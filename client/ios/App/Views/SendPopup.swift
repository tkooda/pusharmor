import SwiftUI
import PushArmorCore

/// The send popup: brand tile and caption, a bar at the send's step, and the step under it.
/// The Send screen and the share sheet show the same popup.
struct SendPopup: View {
    let caption: String
    let names: [String]
    /// The send's progress (25, 50, 75, 100) and its try number (2 or 3 when trying again).
    let step: Int
    let retry: Int

    var body: some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 16) {
                    BrandTileView(size: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(caption)
                        if names.count > 1 {
                            ForEach(Array(names.enumerated()), id: \.offset) { _, name in
                                Text("\u{2022} " + name)
                            }
                        }
                    }
                }
                ProgressView(value: Double(step), total: 100)
                    .progressViewStyle(.linear)
                    .tint(Color.brandGreen)
                    .padding(.top, 16)
                Text(retry > 1 ? DeleteProgress.retry(retry, RetryPolicy.serverDelays.count + 1)
                     : step < SendProgress.encrypted ? S.encryptingFor(names) : S.sendingTo(names))
                    .font(.caption)
                    .foregroundColor(.secondaryText)
                    .padding(.top, 4)
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(.horizontal, 32)
            .accessibilityElement(children: .combine)
            // VoiceOver stays on the popup while it shows.
            .accessibilityAddTraits(.isModal)
        }
    }
}
