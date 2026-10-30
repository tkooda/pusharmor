import SwiftUI
import PushArmorCore

/// Compose box and recipient list (ios section 8.1). Used inside the Home list.
struct ComposeView: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    @State private var asText = false
    @State private var toAll = false
    @State private var selected: Set<String> = []

    private var candidates: [Peer] {
        model.peers.filter { $0.state == .approved && $0.pinned && !$0.hidden }
    }

    private var detected: SendType { SendDetection.detect(text) }

    private var hasRecipient: Bool {
        if toAll && model.showAllOption { return true }
        return candidates.contains { selected.contains($0.id.text) && enabled($0) }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !SizeCap.isOver(text) && hasRecipient
    }

    private func enabled(_ p: Peer) -> Bool { p.approvesMe && !p.missing }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $text)
                .frame(minHeight: 90)
                .accessibilityLabel("Message")
            HStack {
                if !text.isEmpty {
                    Label(badge.title, systemImage: badge.symbol)
                        .font(.caption.bold())
                        .foregroundStyle(Color.iconTileFg)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 24)
                        .background(Color.iconTileBg, in: Capsule())
                }
                Spacer()
                Text(counter)
                    .font(.caption)
                    .foregroundColor(SizeCap.isWarning(text) ? .red : .secondaryText)
            }
            if !text.isEmpty && detected != .text {
                Toggle("Send as text", isOn: $asText)
                    .tint(.brandGreen)
            }
        }
        #if DEBUG
        .onAppear {
            if ScreenshotSample.isOn && text.isEmpty {
                text = ScreenshotSample.draft
                selected = [ScreenshotSample.draftPeer]
            }
        }
        #endif

        if model.showAllOption {
            Button {
                toAll.toggle()
            } label: {
                recipientRow(title: "All", symbol: "laptopcomputer.and.iphone", platform: nil, note: nil, on: toAll)
            }
            .buttonStyle(.plain)
        }
        ForEach(candidates, id: \.id.text) { p in
            let ok = enabled(p)
            Button {
                if selected.contains(p.id.text) { selected.remove(p.id.text) } else { selected.insert(p.id.text) }
            } label: {
                recipientRow(title: model.label(p), symbol: platformSymbol(p.platform), platform: PeerLabel.platformName(p.platform),
                             note: note(p), on: selected.contains(p.id.text) && ok)
            }
            .buttonStyle(.plain)
            .disabled(!ok)
            .opacity(ok ? 1 : 0.45)
        }

        Button {
            let t = text
            let a = asText
            let all = toAll && model.showAllOption
            let ids = all ? [] : candidates.filter { selected.contains($0.id.text) && enabled($0) }.map { $0.id.text }
            Task {
                await model.send(t, asText: a, toAll: all, peerIds: ids)
                text = ""
                asText = false
            }
        } label: {
            Label(sendLabel, systemImage: "paperplane.fill")
        }
        .buttonStyle(GreenButtonStyle())
        .disabled(!canSend)
        .listRowInsets(EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16))
    }

    /// Peers the Send button reaches.
    private var recipientCount: Int {
        if toAll && model.showAllOption { return model.allSet.count }
        return candidates.filter { selected.contains($0.id.text) && enabled($0) }.count
    }

    private var sendLabel: String {
        let n = recipientCount
        if n <= 0 { return "Send" }
        return n == 1 ? "Send to 1 device" : "Send to \(n) devices"
    }

    /// "39 / 2048" (SizeCap.label without the brackets), or "Too long (2049 / 2048)".
    private var counter: String {
        let l = SizeCap.label(text)
        return l.hasPrefix("(") && l.hasSuffix(")") ? String(l.dropFirst().dropLast()) : l
    }

    private var badge: (title: String, symbol: String) {
        switch detected {
        case .url: return ("URL", "link")
        case .text: return ("Text", "text.alignleft")
        case .tel: return ("Phone", "phone")
        }
    }

    private func note(_ p: Peer) -> String? {
        let label = model.label(p)
        if p.missing { return "(missing)" }
        if p.notPairedOnPeer { return p.declinedByPeer ? S.declinedBy(label) : S.notPairedOn(label) }
        if p.paused { return "Signed out" }
        return nil
    }

    private func recipientRow(title: String, symbol: String, platform: String?, note: String?, on: Bool) -> some View {
        HStack(spacing: 14) {
            IconTile(symbol)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                if let pl = platform {
                    Text(pl).font(.subheadline).foregroundColor(.secondaryText)
                }
                if let n = note {
                    StatusLine(kind: .off, text: n)
                }
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            Spacer()
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(on ? Color.accentColor : Color.secondaryText)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
