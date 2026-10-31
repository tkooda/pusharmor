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

    /// The Send button: remembers the selection on send only, so an abandoned selection
    /// is not restored (L7), then sends. True when sent, so the draft clears only then.
    @MainActor
    static func send(_ ids: Set<String>, _ run: () async -> Bool) async -> Bool {
        save(ids)
        return await run()
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

    /// Device chips to show, in list order. With the keyboard up only the chosen
    /// recipients show, so the block stays short and every recipient stays visible.
    /// With none chosen all show, so a device can still be chosen.
    static func visibleChips(_ ids: [String], recipients: Set<String>, keyboardUp: Bool) -> [String] {
        let chosen = ids.filter { recipients.contains($0) }
        return keyboardUp && !chosen.isEmpty ? chosen : ids
    }

    /// The "All" chip: with the keyboard up it shows only while it is on.
    static func showsAllChip(available: Bool, on: Bool, keyboardUp: Bool) -> Bool {
        available && (!keyboardUp || on)
    }

    /// Height cap for the chip area; past it the chips scroll inside their own area
    /// (very small screens only) while Send stays pinned.
    static func chipAreaMaxHeight(keyboardUp: Bool) -> CGFloat { keyboardUp ? 118 : 320 }

    /// Space the message list spends on rows and margins besides the message field itself
    /// (top margin, row padding, caption line, "Send as text" row, bottom margin).
    static let messageChrome: CGFloat = 150

    /// Message field height bounds (F20). It starts 4 text lines tall (plus the editor's
    /// 8 pt insets) and grows with its text until it fills the visible list area above the
    /// pinned chips and Send; past that it scrolls inside itself.
    static func messageHeight(lineHeight: CGFloat, visible: CGFloat) -> (min: CGFloat, max: CGFloat) {
        let low = (lineHeight * 4 + 16).rounded()
        return (low, max(low, (visible - messageChrome).rounded(.down)))
    }

    /// Send button title (F21): a single recipient is named in quotes, more are counted.
    static func sendTitle(count: Int, soleName: String?) -> String {
        if count <= 0 { return "Send" }
        if count == 1 { return soleName.map { "Send to \"\($0)\"" } ?? "Send to 1 device" }
        return "Send to \(count) devices"
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

/// The Send tab: message card; the device chips and Send stay pinned
/// above the tab bar (and above the keyboard).
struct ComposeView: View {
    @EnvironmentObject var model: AppModel
    /// The draft survives process death (I504); the system restores it with the scene.
    @SceneStorage("sendDraft") private var text = ""
    @State private var asText = false
    @State private var toAll = false
    @State private var selected: Set<String> = []
    @State private var restored = false
    /// Global tops of the list and of the pinned send bar; between them is the visible list area.
    @State private var listTop: CGFloat = 0
    @State private var barTop: CGFloat = 0
    /// Starts at one chip row (chip minHeight), so the chips do not flicker in from 0.
    @State private var chipsHeight: CGFloat = 34
    @FocusState private var editing: Bool
    /// Chip name width: 150 pt at the default text size, wider at large Dynamic Type (L8).
    @ScaledMetric(relativeTo: .subheadline) private var chipNameWidth: CGFloat = 150

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

    private func enabled(_ p: Peer) -> Bool { p.canReceive }

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
        }
        .contentMargins(.bottom, 12, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { listTop = $0 }
        .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
        .onAppear { restoreSelection() }
        .onChange(of: candidates.map { $0.id.text }) { _, _ in restoreSelection() }
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
            let h = SendScreenRules.messageHeight(
                lineHeight: UIFont.preferredFont(forTextStyle: .body).lineHeight, visible: barTop - listTop)
            TextEditor(text: $text)
                .focused($editing)
                .frame(minHeight: h.min, maxHeight: h.max)
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
                .padding(4)
                .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(editing ? Color.brandGreen : Color(uiColor: .separator), lineWidth: editing ? 1.5 : 1)
                )
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
                            .foregroundColor(.errorText)
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
                    // Hugs the chips up to the cap, so the message field gets the rest.
                    ScrollView {
                        chips.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { chipsHeight = $0 }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: min(chipsHeight, SendScreenRules.chipAreaMaxHeight(keyboardUp: editing)))
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
                let sel = selected
                Task {
                    // A failed send keeps the draft, so "Not sent. Try again." can be retried.
                    if await RecipientMemory.send(sel, { await model.send(t, asText: a, toAll: all, peerIds: ids) }) {
                        text = ""
                        asText = false
                    }
                }
            } label: {
                Label {
                    if let name = soleRecipientName {
                        // The name truncates inside the quotes; the button stays one line.
                        HStack(spacing: 0) {
                            Text("Send to \"").fixedSize()
                            Text(name).lineLimit(1).truncationMode(.tail)
                            Text("\"").fixedSize()
                        }
                    } else {
                        Text(sendLabel)
                    }
                } icon: {
                    Image(systemName: "paperplane.fill")
                }
            }
            .buttonStyle(GreenButtonStyle())
            .disabled(!canSend || model.busy.contains("send"))
            .accessibilityLabel(sendLabel)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemGroupedBackground))
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { barTop = $0 }
    }

    /// The wrapping chip toggles. With the keyboard up only the chosen devices show.
    private var chips: some View {
        let shown = Set(SendScreenRules.visibleChips(
            candidates.map { $0.id.text },
            recipients: Set(candidates.filter { selected.contains($0.id.text) && enabled($0) }.map { $0.id.text }),
            keyboardUp: editing))
        return ChipFlow(spacing: 8) {
            if SendScreenRules.showsAllChip(available: showAll, on: toAll, keyboardUp: editing) {
                Button {
                    toAll.toggle()
                } label: {
                    chip(title: "All", symbol: "laptopcomputer.and.iphone", on: toAll)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(toAll ? .isSelected : [])
            }
            ForEach(candidates.filter { shown.contains($0.id.text) }, id: \.id.text) { p in
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

    /// Peers the Send button reaches.
    private var recipientCount: Int {
        if toAll && showAll { return model.allSet.count }
        return candidates.filter { selected.contains($0.id.text) && enabled($0) }.count
    }

    /// The one chosen device's name, when exactly one is chosen (not via "All").
    private var soleRecipientName: String? {
        if toAll && showAll { return nil }
        let chosen = candidates.filter { selected.contains($0.id.text) && enabled($0) }
        return chosen.count == 1 ? model.label(chosen[0]) : nil
    }

    private var sendLabel: String {
        SendScreenRules.sendTitle(count: recipientCount, soleName: soleRecipientName)
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
        if p.loggedOut { return "Logged out" }
        if !p.listening { return "Send only" }
        return nil
    }

    /// Bordered capsule toggle; the name ellipsizes at chipNameWidth (at most 260 pt).
    private func chip(title: String, symbol: String, on: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: on ? "checkmark" : symbol)
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: min(chipNameWidth, 260), alignment: .leading)
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
