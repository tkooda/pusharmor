import SwiftUI
import PushArmorCore

/// History section: filter control and rows. Used inside the Home list.
struct HistoryView: View {
    @EnvironmentObject var model: AppModel
    @State private var filter: HistoryFilter = .all

    private var options: [HistoryFilter] { HistoryFilter.options(rows: model.history, peers: model.peers) }

    /// The selected filter, or All when it is gone or has no rows.
    private var effective: HistoryFilter {
        if filter != .all && (!options.contains(filter) || HistoryFilter.apply(filter, model.history).isEmpty) {
            return .all
        }
        return filter
    }

    var body: some View {
        let rows = HistoryFilter.apply(effective, model.history)
        Section("History") {
            if options.count > 1 {
                filterControl
            }
            if rows.isEmpty {
                VStack(spacing: 8) {
                    MessagesIllustration()
                    Text("No messages yet")
                        .font(.title2.weight(.semibold))
                    Text(S.noMessagesBody)
                        .font(.subheadline)
                        .foregroundColor(.secondaryText)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
            }
            ForEach(rows, id: \.rowid) { row in
                HistoryRowView(row: row)
            }
            .onDelete { idx in
                for i in idx { model.deleteRow(rows[i]) }
            }
        }
    }

    @ViewBuilder
    private var filterControl: some View {
        let sel = Binding<HistoryFilter>(get: { effective }, set: { filter = $0 })
        if options.count <= 4 {
            Picker("Filter", selection: sel) {
                ForEach(options, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
        } else {
            Menu {
                Picker("Filter", selection: sel) {
                    ForEach(options, id: \.self) { Text($0.label).tag($0) }
                }
            } label: {
                Label(effective.label, systemImage: "line.3.horizontal.decrease.circle")
            }
        }
    }
}

struct HistoryRowView: View {
    let row: HistoryRow
    @EnvironmentObject var model: AppModel

    private var peer: Peer? { row.peerId.flatMap { id in model.peers.first { $0.id.text == id } } }
    private var outgoing: Bool { row.dir == .outgoing }
    private var unknown: Bool { !outgoing && row.peerId == nil }
    private var isEvent: Bool { row.type == "event" }

    private var senderName: String {
        if outgoing { return "Sent" }
        if unknown { return S.unknownSender }
        guard let p = peer else { return S.aPeer }
        let l = PeerLabel.label(p)
        return p.state == .removed ? l + " (removed)" : l
    }

    private var iconName: String {
        if outgoing { return "paperplane" }
        if unknown { return "app.badge" }
        return platformSymbol(peer?.platform)
    }

    private var unread: Bool { !row.read && !isEvent && !outgoing }

    private var contentText: String {
        isEvent && row.count > 1 ? "\(row.content) (\(row.count))" : row.content
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
        return S.sentTo(sent, obj.count)
    }

    /// The one recipient's name when the message went to exactly one device and reached it (F22).
    private var soleRecipientName: String? {
        guard let obj = results, obj.count == 1, let only = obj.first, only.value == "sent",
              let p = model.peers.first(where: { $0.id.text == only.key })
        else { return nil }
        return PeerLabel.label(p)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if unread {
                Circle().fill(Color.accentColor).frame(width: 10, height: 10)
                    .padding(.top, 10)
                    .accessibilityLabel("Unread")
            } else {
                Color.clear.frame(width: 10, height: 10)
            }
            if isEvent {
                Image(systemName: iconName)
                    .foregroundColor(.secondaryText)
                    .frame(width: 30, height: 30)
                    .accessibilityHidden(true)
            } else {
                IconTile(iconName)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    sender
                    Spacer(minLength: 8)
                    time
                        .font(.subheadline)
                        .foregroundColor(.secondaryText)
                }
                VStack(alignment: .leading, spacing: 2) {
                    content
                        .font(isEvent ? .subheadline : .body)
                        .foregroundColor(.secondaryText)
                    if let name = soleRecipientName {
                        // The name truncates inside the quotes; the line stays one line.
                        HStack(spacing: 0) {
                            Text("Sent to \"").fixedSize()
                            Text(name).lineLimit(1).truncationMode(.tail)
                            Text("\"").fixedSize()
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
        // The whole row is one tap target and one VoiceOver button; the sender link is
        // a named action.
        .contentShape(Rectangle())
        .onTapGesture { tap() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11yLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { tap() }
        .accessibilityActions {
            if !unknown && !outgoing, let id = row.peerId {
                Button("Show \(senderName)") { model.highlightPeer = id }
            }
        }
    }

    private var a11yLabel: String {
        [unread ? "Unread" : nil, senderName, timeLabel, contentText, resultsSummary]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    private var timeLabel: String {
        let d = Date(timeIntervalSince1970: TimeInterval(row.createdLocal))
        if Calendar.current.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.month().day())
    }

    private var senderText: Text {
        Text(senderName).font(unread ? .headline : .body)
    }

    @ViewBuilder
    private var sender: some View {
        if !unknown && !outgoing, let id = row.peerId {
            Button { model.highlightPeer = id } label: { senderText.foregroundColor(.primary) }
                .buttonStyle(.plain)
                .accessibilityLabel(senderName)
        } else {
            senderText.accessibilityLabel(senderName)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch row.type {
        case "url": Text(contentText).lineLimit(1).truncationMode(.middle)
        case "tel": Text(contentText).lineLimit(1)
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
        if isEvent {
            if let id = row.peerId { model.highlightPeer = id }
            return
        }
        if row.type == "url" && !outgoing {
            model.open(row)
        } else {
            model.markRead(row)
            model.detailRow = row
        }
    }
}
