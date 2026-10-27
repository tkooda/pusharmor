import Foundation

/// History filter (catalog Notice rule, History filter): "All", one entry per verified peer
/// by name (hidden while History holds rows from only one peer), "Unknown" (only while an
/// Unknown row exists). A peer entry lists RECEIVED rows from that peer only.
public enum HistoryFilter: Hashable, Sendable {
    case all
    case peer(String, String)   // id, name
    case unknown

    public var label: String {
        switch self {
        case .all: return "All"
        case .peer(_, let n): return n
        case .unknown: return "Unknown"
        }
    }

    public static func options(rows: [HistoryRow], peers: [Peer]) -> [HistoryFilter] {
        var out: [HistoryFilter] = [.all]
        let ids = Set(rows.compactMap { $0.peerId })
        if ids.count > 1 {
            let received = Set(rows.filter { $0.dir == .incoming }.compactMap { $0.peerId })
            let named = peers.filter { received.contains($0.id.text) }
                .map { HistoryFilter.peer($0.id.text, $0.name ?? PeerLabel.unnamed(platform: $0.platform, created: $0.created)) }
            out += named.sorted { $0.label < $1.label }
        }
        if rows.contains(where: { $0.peerId == nil }) { out.append(.unknown) }
        return out
    }

    public static func apply(_ f: HistoryFilter, _ rows: [HistoryRow]) -> [HistoryRow] {
        switch f {
        case .all: return rows
        case .peer(let id, _): return rows.filter { $0.dir == .incoming && $0.peerId == id }
        case .unknown: return rows.filter { $0.peerId == nil }
        }
    }
}
