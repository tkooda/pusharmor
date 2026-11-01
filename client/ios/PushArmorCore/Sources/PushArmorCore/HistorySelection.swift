import Foundation

/// History multi-select (I621): long-press starts it with that row checked; a tap toggles a row;
/// unchecking the last row ends it. `ids` is nil while the mode is off.
public struct HistorySelection: Equatable, Sendable {
    public private(set) var ids: Set<Int64>?

    public init() { ids = nil }

    public var active: Bool { ids != nil }
    public var count: Int { ids?.count ?? 0 }

    public func contains(_ id: Int64) -> Bool { ids?.contains(id) ?? false }

    public mutating func start(_ id: Int64) { ids = [id] }

    public mutating func toggle(_ id: Int64) {
        guard var s = ids else { return }
        if s.contains(id) { s.remove(id) } else { s.insert(id) }
        ids = s.isEmpty ? nil : s
    }

    public mutating func exit() { ids = nil }

    /// Drops ids whose rows are gone (deleted, or hidden by the filter), which can end the mode.
    public mutating func keep(only visible: Set<Int64>) {
        guard let s = ids else { return }
        let k = s.intersection(visible)
        ids = k.isEmpty ? nil : k
    }

    /// "Delete 1 selected", "Delete 3 selected".
    public var deleteLabel: String { "Delete \(count) selected" }

    /// The confirm title: "Delete 1 message?", "Delete 3 messages?".
    public var confirmTitle: String { count == 1 ? "Delete 1 message?" : "Delete \(count) messages?" }
}
