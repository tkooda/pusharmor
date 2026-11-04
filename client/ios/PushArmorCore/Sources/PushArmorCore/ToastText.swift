import Foundation

/// Texts for the bottom banner that are not errors from a call.
public enum ToastText {
    public static let copied = "Copied"
    public static let copyFailed = "Unable to copy\nSelect the text and copy it by hand"

    /// The banner after a Copy: "Copied" when the value is not blank and the pasteboard
    /// holds text afterwards, else the two-line error.
    public static func copyResult(_ value: String, pasteboardHasText: Bool) -> (text: String, ok: Bool) {
        let ok = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pasteboardHasText
        return ok ? (copied, true) : (copyFailed, false)
    }

    /// The banner as shown and spoken: no line ends with a period. Text inside a line keeps
    /// its periods, and the same texts keep them where they show as inline text or alerts.
    public static func shown(_ t: String) -> String {
        t.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.hasSuffix(".") && !$0.hasSuffix("..") ? String($0.dropLast()) : String($0) }
            .joined(separator: "\n")
    }
}
