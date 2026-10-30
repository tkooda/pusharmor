import SwiftUI
import PushArmorCore

/// Remembers which devices the last send went to (F2). Pure rule, tested in RecipientMemoryTests.
enum RecipientMemory {
    static let defaultsKey = "lastSelectedDeviceIds"

    /// Remembered ids that still exist and can receive. Empty when none qualify (the default).
    static func preselect(remembered: [String], candidates: [(id: String, canReceive: Bool)]) -> Set<String> {
        let ok = Set(candidates.filter { $0.canReceive }.map { $0.id })
        return Set(remembered).intersection(ok)
    }

    static func load() -> [String] {
        UserDefaults.standard.stringArray(forKey: defaultsKey) ?? []
    }

    static func save(_ ids: Set<String>) {
        UserDefaults.standard.set(ids.sorted(), forKey: defaultsKey)
    }
}

/// Pure Send screen rules (F12, F13). Tested in SendScreenRulesTests.
enum SendScreenRules {
    /// Chip block header, for example "Send to (2 of 3)".
    static func header(selected: Int, total: Int) -> String { "Send to (\(selected) of \(total))" }

    /// The "All" chip shows only with 2 or more devices, and only when the setting allows it.
    static func showsAll(setting: Bool, deviceCount: Int) -> Bool { setting && deviceCount >= 2 }

    /// The byte counter shows only from 90 percent of the cap (and while over it).
    static func showsCounter(_ text: String) -> Bool { SizeCap.isWarning(text) }

    /// With exactly one device that can receive, that device is preselected.
    static func soleDevice(_ candidates: [(id: String, canReceive: Bool)]) -> String? {
        guard candidates.count == 1, candidates[0].canReceive else { return nil }
        return candidates[0].id
    }

    /// Quiet line under the message: how it will arrive.
    static func caption(_ type: SendType, asText: Bool) -> (title: String, symbol: String) {
        if asText { return ("Will arrive as text", "text.alignleft") }
        switch type {
        case .url: return ("Will open as a link", "link")
        case .tel: return ("Will open as a phone number", "phone")
        case .text: return ("Will arrive as text", "text.alignleft")
        }
    }
}

/// Wraps chips onto as many lines as needed, left aligned.
struct ChipFlow: Layout {
    var spacing: CGFloat = 8

    private struct Item {
        let index: Int
        let x: CGFloat
        let size: CGSize
    }

    private struct Row {
        var y: CGFloat
        var height: CGFloat = 0
        var width: CGFloat = 0
        var items: [Item] = []
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let widest = rows.map { $0.width }.max() ?? 0
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews: subviews) {
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + row.y),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(item.size))
            }
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row(y: 0)
        for i in subviews.indices {
            var size = subviews[i].sizeThatFits(.unspecified)
            size.width = min(size.width, width)
            let x = row.items.isEmpty ? 0 : row.width + spacing
            if !row.items.isEmpty && x + size.width > width {
                let nextY = row.y + row.height + spacing
                rows.append(row)
                row = Row(y: nextY)
                row.items.append(Item(index: i, x: 0, size: size))
                row.width = size.width
                row.height = size.height
            } else {
                row.items.append(Item(index: i, x: x, size: size))
                row.width = x + size.width
                row.height = max(row.height, size.height)
            }
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// The Send tab: message card and history scroll; the device chips and Send stay pinned
/// above the tab bar (and above the keyboard).
struct ComposeView: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    @State private var asText = false
    @State private var toAll = false
    @State private var selected: Set<String> = []
    @State private var restored = false

    private var candidates: [Peer] {
        model.peers.filter { $0.state == .approved && $0.pinned && !$0.hidden }
    }

    private var showAll: Bool {
        SendScreenRules.showsAll(setting: model.showAllOption, deviceCount: candidates.count)
    }

    /// Restore the remembered selection once devices are known. Never overrides a choice made this session.
    private func restoreSelection() {
        guard !restored, !candidates.isEmpty else { return }
        restored = true
        if !selected.isEmpty { return }
        let cands = candidates.map { (id: $0.id.text, canReceive: enabled($0)) }
        selected = RecipientMemory.preselect(remembered: RecipientMemory.load(), candidates: cands)
        if selected.isEmpty, let only = SendScreenRules.soleDevice(cands) {
            selected = [only]
        }
    }

    private var detected: SendType { SendDetection.detect(text) }

    private var hasRecipient: Bool {
        if toAll && showAll { return true }
        return candidates.contains { selected.contains($0.id.text) && enabled($0) }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !SizeCap.isOver(text) && hasRecipient
    }

    private func enabled(_ p: Peer) -> Bool { p.approvesMe && !p.missing }

    var body: some View {
        List {
            HomeBanners()
            Section {
                messageCard
                if !text.isEmpty && detected != .text {
                    Toggle("Send as text", isOn: $asText)
                        .font(.subheadline)
                        .foregroundColor(.secondaryText)
                        .tint(.brandGreen)
                }
            }
            HistoryView()
        }
        .contentMargins(.bottom, 12, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
        .onAppear { restoreSelection() }
        .onChange(of: candidates.map { $0.id.text }) { _, _ in restoreSelection() }
        .onChange(of: selected) { _, v in if restored { RecipientMemory.save(v) } }
        #if DEBUG
        .onAppear {
            if ScreenshotSample.isOn && text.isEmpty {
                text = ScreenshotSample.draft
                selected = [ScreenshotSample.draftPeer]
            }
        }
        #endif
    }

    private var messageCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $text)
                .frame(minHeight: 118)
                .scrollContentBackground(.hidden)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Message")
                            .foregroundColor(.secondaryText)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityLabel("Message")
            if !text.isEmpty {
                HStack(spacing: 8) {
                    let c = SendScreenRules.caption(detected, asText: asText)
                    Label(c.title, systemImage: c.symbol)
                        .font(.footnote)
                        .foregroundColor(.secondaryText)
                    Spacer(minLength: 8)
                    if SendScreenRules.showsCounter(text) {
                        Text(counter)
                            .font(.footnote)
                            .foregroundColor(.red)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// Device chips and the Send button, pinned at the bottom.
    private var sendBar: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !candidates.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(SendScreenRules.header(selected: min(recipientCount, candidates.count), total: candidates.count))
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(.secondaryText)
                        .accessibilityAddTraits(.isHeader)
                    ChipFlow(spacing: 8) {
                        if showAll {
                            Button {
                                toAll.toggle()
                            } label: {
                                chip(title: "All", symbol: "laptopcomputer.and.iphone", on: toAll)
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(toAll ? .isSelected : [])
                        }
                        ForEach(candidates, id: \.id.text) { p in
                            let ok = enabled(p)
                            let on = selected.contains(p.id.text) && ok
                            Button {
                                if selected.contains(p.id.text) { selected.remove(p.id.text) } else { selected.insert(p.id.text) }
                            } label: {
                                chip(title: model.label(p), symbol: platformSymbol(p.platform), on: on)
                            }
                            .buttonStyle(.plain)
                            .disabled(!ok)
                            .opacity(ok ? 1 : 0.45)
                            .accessibilityValue(note(p) ?? "")
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.cardEdge, lineWidth: 1))
            }
            Button {
                let t = text
                let a = asText
                let all = toAll && showAll
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
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// Peers the Send button reaches.
    private var recipientCount: Int {
        if toAll && showAll { return model.allSet.count }
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

    private func note(_ p: Peer) -> String? {
        let label = model.label(p)
        if p.missing { return "(missing)" }
        if p.notPairedOnPeer { return p.declinedByPeer ? S.declinedBy(label) : S.notPairedOn(label) }
        if p.paused { return "Signed out" }
        return nil
    }

    /// Bordered capsule toggle; the name ellipsizes at 150 pt.
    private func chip(title: String, symbol: String, on: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: on ? "checkmark" : symbol)
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 150, alignment: .leading)
        }
        .font(.subheadline.weight(on ? .semibold : .regular))
        .foregroundStyle(on ? Color(uiColor: .systemBackground) : Color.primary)
        .padding(.horizontal, 12)
        .frame(minHeight: 34)
        .background(Capsule().fill(on ? Color.accentColor : Color.clear))
        .overlay(Capsule().strokeBorder(on ? Color.clear : Color(uiColor: .separator), lineWidth: 1))
        .contentShape(Capsule())
    }
}
