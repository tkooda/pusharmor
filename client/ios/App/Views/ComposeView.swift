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
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.4)))
                .accessibilityLabel("Message")
            HStack {
                if !text.isEmpty {
                    Text(detected.rawValue.uppercased())
                        .font(.caption.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.2), in: Capsule())
                }
                Spacer()
                Text(SizeCap.label(text))
                    .font(.caption)
                    .foregroundColor(SizeCap.isWarning(text) ? .red : .secondary)
            }
            if !text.isEmpty && detected != .text {
                Toggle("Send as text", isOn: $asText)
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
                recipientRow(title: "All", note: nil, on: toAll)
            }
            .buttonStyle(.plain)
        }
        ForEach(candidates, id: \.id.text) { p in
            let ok = enabled(p)
            Button {
                if selected.contains(p.id.text) { selected.remove(p.id.text) } else { selected.insert(p.id.text) }
            } label: {
                recipientRow(title: model.label(p), note: note(p), on: selected.contains(p.id.text) && ok)
            }
            .buttonStyle(.plain)
            .disabled(!ok)
            .opacity(ok ? 1 : 0.5)
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
            Text("Send").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canSend)
    }

    private func note(_ p: Peer) -> String? {
        let label = model.label(p)
        if p.missing { return "(missing)" }
        if p.notPairedOnPeer { return p.declinedByPeer ? S.declinedBy(label) : S.notPairedOn(label) }
        if p.paused { return "signed out" }
        return nil
    }

    private func recipientRow(title: String, note: String?, on: Bool) -> some View {
        HStack {
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .foregroundColor(on ? .accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let n = note {
                    Text(n).font(.caption).foregroundColor(.secondary)
                }
            }
            Spacer()
        }
        .contentShape(Rectangle())
    }
}
