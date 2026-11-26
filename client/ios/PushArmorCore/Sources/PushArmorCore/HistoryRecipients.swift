import Foundation

/// The Recipients list of an opened History item sent to two or more devices: one line per
/// device, its name as History shows it, then "Sent" or "Failed".
public enum HistoryRecipients {
    public static let title = "Recipients"
    public static let sent = "Sent"
    public static let failed = "Failed"

    public struct Line: Equatable, Sendable {
        public let name: String
        public let status: String
        public init(name: String, status: String) { self.name = name; self.status = status }
    }

    /// The lines by name; empty for a send to one device. `name` gives the shown name of a device ID.
    public static func lines(_ results: [String: String], name: (String) -> String) -> [Line] {
        guard results.count >= 2 else { return [] }
        let all = results.keys.sorted().map { Line(name: name($0), status: results[$0] == "sent" ? sent : failed) }
        return PeerLabel.sortedByName(all) { $0.name }
    }
}
