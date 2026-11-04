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
}
