import Foundation

/// History rows: one row is open at a time. A tap on the open row closes it; a tap on
/// any other row opens that row and closes the open one, on the first tap.
public enum HistoryExpand {
    /// The row id that is open after a tap on `tapped`; nil when none is.
    public static func tap(open: Int64?, tapped: Int64) -> Int64? {
        open == tapped ? nil : tapped
    }
}
