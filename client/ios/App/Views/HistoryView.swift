import SwiftUI
import PushArmorCore

/// History section: filter control and rows. Used inside the History tab list.
struct HistoryView: View {
    @EnvironmentObject var model: AppModel
    @State private var filter: HistoryFilter = .all
    /// Multi-select; the History tab owns it and ends it when the tab goes away.
    @Binding var selection: HistorySelection
    @Binding var confirmDelete: Bool
    /// Switch to the Send tab and the Devices tab.
    let onSend: () -> Void
    let onPair: () -> Void

    private var options: [HistoryFilter] { HistoryFilter.options(rows: model.history, peers: model.peers) }

    /// The selected filter; it stays selected when it matches nothing (never All in its place).
    private var effective: HistoryFilter { HistoryFilter.current(filter, options: options) }

    /// The filter choices: the selected filter stays among them while it has no rows.
    private var choices: [HistoryFilter] { HistoryFilter.choices(options, chosen: effective) }

    var body: some View {
        let rows = HistoryFilter.apply(effective, model.history)
        // sent files not in History yet show under All only (a device filter lists received rows)
        let pending = effective == .all ? model.pendingSends : []
        Section {
            // a delete in several calls: a thin bar with the step under it
            if let p = model.deleteProgress, p.total > 1 {
                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: Double(p.done), total: Double(p.total))
                    Text(p.caption)
                        .font(.caption)
                        .foregroundColor(.secondaryText)
                }
                .listRowSeparator(.hidden)
            }
            if choices.count > 1 {
                filterControl
            }
            if !rows.isEmpty {
                HStack {
                    selectAll(rows.map(\.rowid))
                    Spacer()
                    if selection.active {
                        deleteButton
                    }
                }
                .listRowSeparator(.hidden)
            }
            // sent files whose message has not gone yet, newest first
            ForEach(pending, id: \.id) { PendingSendRow(file: $0) }
            if rows.isEmpty && pending.isEmpty && effective != .all {
                Text(HistoryFilter.noMatch)
                    .foregroundColor(.secondaryText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
            } else if rows.isEmpty && pending.isEmpty {
                VStack(spacing: 8) {
                    MessagesIllustration()
                    Text("No messages yet")
                        .font(.title2.weight(.semibold))
                    if model.needsFirstPair {
                        PairFirstPrompt(onPair: onPair)
                    } else {
                        Text(S.noMessagesBody)
                            .font(.subheadline)
                            .foregroundColor(.secondaryText)
                            .multilineTextAlignment(.center)
                        Button("Send a message", action: onSend)
                            .buttonStyle(.bordered)
                            .padding(.top, 8)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
            }
            ForEach(rows, id: \.rowid) { row in
                HistoryRowView(row: row, expanded: model.detailRow != nil && model.detailRow?.rowid == row.rowid,
                               selecting: selection.active, selected: selection.contains(row.rowid),
                               onToggle: { selection.toggle(row.rowid) }, onLongPress: { selection.start(row.rowid) })
            }
        }
    }

    /// The select-all checkbox in the checkbox column: empty, a dash for some, a check for all.
    private func selectAll(_ shown: [Int64]) -> some View {
        let state = selection.allState(of: shown)
        return Button { selection.toggleAll(shown) } label: {
            HStack(spacing: 10) {
                Image(systemName: state == .all ? "checkmark.circle.fill" : (state == .partial ? "minus.circle.fill" : "circle"))
                    .foregroundColor(state == .empty ? .secondaryText : .accentColor)
                    .imageScale(.large)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Select all")
        .accessibilityValue(state == .all ? "All selected" : (state == .partial ? "Some selected" : "None selected"))
    }

    private var deleteButton: some View {
        Button { confirmDelete = true } label: {
            Text(selection.deleteLabel)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.red)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(Capsule().fill(Color.red.opacity(0.15)))
                // A 44 pt tap area; the outer negative padding keeps the pill's size and place.
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -6)
    }

    @ViewBuilder
    private var filterControl: some View {
        let sel = Binding<HistoryFilter>(get: { effective }, set: { filter = $0 })
        if choices.count <= 4 {
            Picker("Filter", selection: sel) {
                ForEach(choices, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
        } else {
            Menu {
                Picker("Filter", selection: sel) {
                    ForEach(choices, id: \.self) { Text($0.label).tag($0) }
                }
            } label: {
                Label(effective.label, systemImage: "line.3.horizontal.decrease.circle")
            }
        }
    }
}

/// "Recipients" with a disclosure chevron: a tap shows or hides one line per device, its name
/// then "Sent" or "Failed". It starts closed each time its History item opens.
struct RecipientsList: View {
    let lines: [HistoryRecipients.Line]
    @State private var open = false

    var body: some View {
        DisclosureGroup(HistoryRecipients.title, isExpanded: $open) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(l.name)
                        Spacer(minLength: 8)
                        Text(l.status).foregroundColor(.secondaryText)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 4)
        }
        .font(.subheadline)
        .accessibilityIdentifier("recipients")
    }
}

struct HistoryRowView: View {
    let row: HistoryRow
    /// Open: the text and the action buttons show under the row; a tap opens or closes it.
    var expanded = false
    /// Multi-select: a checkbox shows on the left and a tap toggles it.
    var selecting = false
    var selected = false
    var onToggle: () -> Void = {}
    var onLongPress: () -> Void = {}
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The event icon grows with the text, like IconTile.
    @ScaledMetric private var eventIcon: CGFloat = 30
    /// The icon column of a row (IconTile and its spacing): a file's state lines up with the text.
    @ScaledMetric private var textInset: CGFloat = 30
    /// A ready image file decodes (checked per file state): closed, a file that does not keeps
    /// "Preview not available" under its name.
    @State private var decodes: Bool?

    private var peer: Peer? { row.peerId.flatMap { id in model.peers.first { $0.id.text == id } } }
    private var outgoing: Bool { row.dir == .outgoing }
    private var unknown: Bool { !outgoing && row.peerId == nil }
    private var isEvent: Bool { row.type == "event" }
    /// A message type from a newer version: it shows S.unknownType and does not open.
    private var isUnknownType: Bool { row.type == "unknown" }
    /// A file row: its state shows under it; open, its buttons show too.
    private var isFile: Bool { row.type == "file" }
    private var file: FileRecord? { isFile ? model.files[row.rowid] : nil }

    private var senderName: String {
        if outgoing { return "Sent" }
        if unknown { return S.unknownSender }
        guard let p = peer else { return S.aPeer }
        let l = model.historyLabel(p)
        return p.state == .removed ? l + " (removed)" : l
    }

    private var iconName: String {
        if outgoing { return "paperplane" }
        if isFile { return FileUi.symbol(FileUi.kind(row.content)) }
        if unknown { return "app.badge" }
        return platformSymbol(peer?.platform)
    }

    private var unread: Bool { !row.read && !isEvent && !outgoing }

    /// A delete that did not reach every device: the names of those still to take it.
    private var notDeletedOn: [String] {
        row.delPending.compactMap { id in model.peers.first { $0.id.text == id } }.map { model.historyLabel($0) }
    }

    private var isOpen: Bool { expanded && !selecting && !isEvent && !isUnknownType && !isFile }

    /// A file row opened by a tap: its buttons show.
    private var fileOpen: Bool { expanded && !selecting && isFile }

    /// A closed file row whose file is on this device has no buttons under its name, only
    /// "Preview not available" for an image that does not decode.
    /// A closed sent file row with no copy kept has nothing either: no expiry.
    private func fileDetailShows(_ f: FileRecord) -> Bool {
        if fileOpen { return true }
        if outgoing && f.state == "sent" { return false }
        if case .ready = model.fileStatus(f) { return FileUi.previewNotAvailable(name: f.name, decodes: decodes ?? true) }
        return true
    }

    private var contentText: String {
        if isUnknownType { return S.unknownType }
        return isEvent && row.count > 1 ? "\(row.content) (\(row.count))" : row.content
    }

    private var results: [String: String]? {
        guard outgoing, let r = row.results,
              let d = r.data(using: .utf8)
        else { return nil }
        return try? JSONSerialization.jsonObject(with: d) as? [String: String]
    }

    private var resultsSummary: String? {
        guard let obj = results else { return nil }
        if let name = soleRecipientName { return S.sentToOne(name) }
        let sent = obj.values.filter { $0 == "sent" }.count
        return S.historySentTo(sent, obj.count)
    }

    /// The one recipient's name when the message went to exactly one device and reached it (F22).
    private var soleRecipientName: String? {
        guard let obj = results, obj.count == 1, let only = obj.first, only.value == "sent",
              let p = model.peers.first(where: { $0.id.text == only.key })
        else { return nil }
        return model.historyLabel(p)
    }

    /// A send to two or more devices: the lines of its Recipients list.
    private var recipientLines: [HistoryRecipients.Line] {
        HistoryRecipients.lines(results ?? [:]) { id in model.peers.first { $0.id.text == id }.map { model.historyLabel($0) } ?? S.aPeer }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            summary
            if isOpen { MessageDetailView(row: row, notDeletedOn: notDeletedOn, recipients: recipientLines) }
            if let f = file, !selecting, fileDetailShows(f) { FileRowDetail(file: f, outgoing: outgoing, open: fileOpen, recipients: recipientLines).padding(.leading, textInset + 10) }
        }
        .task(id: file.map { "\($0.id):\($0.state)" }) {
            guard let f = file, FileUi.kind(f.name) == .image else { return }
            let url = model.plainURL(f)
            decodes = await Task.detached { FileRowDetail.decodes(url) }.value
        }
    }

    private var summary: some View {
        // Unread rows are bold, with no marker column, so the times line up (F32).
        HStack(alignment: .top, spacing: 10) {
            if selecting {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(selected ? .accentColor : .secondaryText)
                    .imageScale(.large)
                    .accessibilityHidden(true)
            }
            if isEvent {
                Image(systemName: iconName)
                    .foregroundColor(.secondaryText)
                    .frame(width: eventIcon, height: eventIcon)
                    .accessibilityHidden(true)
            } else {
                IconTile(iconName)
            }
            VStack(alignment: .leading, spacing: 2) {
                // at accessibility sizes the time goes under the name, so the name is not squeezed
                let header = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
                header {
                    sender
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    time
                        .font(.subheadline.monospacedDigit())
                        .fontWeight(unread ? .semibold : nil)
                        .foregroundColor(.secondaryText)
                        .lineLimit(1)
                        .fixedSize()
                }
                VStack(alignment: .leading, spacing: 2) {
                    if !isOpen {
                        content
                            .font(isEvent ? .subheadline : .body)
                            .fontWeight(unread ? .semibold : nil)
                            .foregroundColor(unread ? .primary : .secondaryText)
                            .strikethrough(!notDeletedOn.isEmpty)
                    }
                    // open: the detail shows it under the struck through text
                    if !isOpen, !notDeletedOn.isEmpty {
                        Text(S.notDeletedOn(notDeletedOn)).font(.caption).foregroundColor(.errorText)
                    }
                    if let name = soleRecipientName {
                        // The name truncates inside the quotes, never its device ID; the line stays one line.
                        let cut = PeerLabel.idSplit(name)
                        HStack(spacing: 0) {
                            Text("Sent to \"").fixedSize()
                            Text(cut.name).lineLimit(typeSize.isAccessibilitySize ? 2 : 1).truncationMode(.tail)
                            Text(cut.id + "\"").fixedSize()
                        }
                        .font(.caption).foregroundColor(.secondaryText)
                    } else if let s = resultsSummary {
                        Text(s).font(.caption).foregroundColor(.secondaryText)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        }
        // The whole row is one tap target and one VoiceOver element: a button, except an event row outside select mode.
        .contentShape(Rectangle())
        .onTapGesture { selecting ? onToggle() : tap() }
        .onLongPressGesture { if selecting { onToggle() } else { onLongPress() } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11yLabel)
        .accessibilityValue(isEvent || isUnknownType || selecting ? "" : (isOpen || fileOpen ? "Expanded" : "Collapsed"))
        .accessibilityAddTraits(selecting && selected ? [.isButton, .isSelected] : (selecting || !isEvent ? AccessibilityTraits.isButton : []))
        .accessibilityAction { selecting ? onToggle() : tap() }
        .accessibilityAction(named: "Select") { if selecting { onToggle() } else { onLongPress() } }
    }

    private var a11yLabel: String {
        [unread ? "Unread" : nil, senderName, timeLabel, contentText,
         isFile ? FileUi.detail(row.content, size: file?.size ?? 0) : nil, resultsSummary,
         notDeletedOn.isEmpty ? nil : S.notDeletedOn(notDeletedOn)]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    private var timeLabel: String {
        let d = Date(timeIntervalSince1970: TimeInterval(row.createdLocal))
        if Calendar.current.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.month().day())
    }

    private var sender: some View {
        Text(senderName).font(unread ? .headline : .body)
    }

    @ViewBuilder
    private var content: some View {
        switch row.type {
        case "url": Text(contentText).lineLimit(typeSize.isAccessibilitySize ? 3 : 1).truncationMode(.middle)
        case "tel": Text(contentText).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
        case "file":
            VStack(alignment: .leading, spacing: 2) {
                Text(contentText).lineLimit(typeSize.isAccessibilitySize ? 3 : 1).truncationMode(.middle)
                if let f = file, fileOpen {
                    Text(FileUi.detail(f.name, size: f.size)).font(.caption).foregroundColor(.secondaryText)
                }
            }
        case "unknown":
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Image(systemName: "xmark.circle.fill").imageScale(.small)
                Text(contentText)
            }
            .foregroundColor(.errorText)
        default: Text(contentText).lineLimit(3)
        }
    }

    @ViewBuilder
    private var time: some View {
        let d = Date(timeIntervalSince1970: TimeInterval(row.createdLocal))
        if Calendar.current.isDateInToday(d) {
            Text(d, style: .time)
        } else if Calendar.current.isDateInYesterday(d) {
            Text("Yesterday")
        } else {
            Text(d.formatted(.dateTime.month().day()))
        }
    }

    private func tap() {
        if isEvent { return }
        model.markRead(row)
        if isUnknownType { return }
        model.detailRow = HistoryExpand.tap(open: model.detailRow?.rowid, tapped: row.rowid) == nil ? nil : row
    }
}
