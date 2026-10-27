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
                Text("No messages yet").foregroundColor(.secondary)
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
        switch peer?.platform {
        case "iphone": return "iphone"
        case "android": return "smartphone"
        case "chrome", "firefox": return "laptopcomputer"
        default: return "questionmark.circle"
        }
    }

    private var contentText: String {
        isEvent && row.count > 1 ? "\(row.content) (\(row.count))" : row.content
    }

    private var resultsSummary: String? {
        guard outgoing, let r = row.results,
              let d = r.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: String]
        else { return nil }
        let sent = obj.values.filter { $0 == "sent" }.count
        return S.sentTo(sent, obj.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .top, spacing: 10) {
            Button {
                if !unknown && !outgoing, let id = row.peerId { model.highlightPeer = id }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: iconName)
                        .frame(width: 24)
                        .foregroundColor(.secondary)
                    Text(senderName)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(senderName)
            .disabled(unknown || outgoing)
            Spacer()
            if !row.read && !isEvent && !outgoing {
                Circle().fill(Color.accentColor).frame(width: 9, height: 9)
                    .accessibilityLabel("Unread")
            }
        }
        VStack(alignment: .leading, spacing: 2) {
            Text(contentText)
                .lineLimit(3)
            if let s = resultsSummary {
                Text(s).font(.caption).foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { tap() }
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
