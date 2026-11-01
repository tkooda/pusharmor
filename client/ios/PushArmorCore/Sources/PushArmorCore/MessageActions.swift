import Foundation

/// History message actions (I622): which buttons a message shows, in order, the text preview,
/// and the default name of a saved text file.
public enum MessageAction: String, Equatable, Sendable {
    case read, copy, open, share, save
}

public enum MessageActions {
    /// Links and phone numbers: Copy, Open, Share. Plain text: Read, Copy, Share, Save.
    public static func actions(forType type: String) -> [MessageAction] {
        switch type {
        case "url", "tel": return [.copy, .open, .share]
        default: return [.read, .copy, .share, .save]
        }
    }

    /// How many lines the text box shows before it scrolls.
    public static let previewLines = 3

    /// The text box scrolls when the text has more than `previewLines` lines, or is long enough
    /// that it would wrap past them.
    public static func scrolls(_ text: String, charsPerLine: Int = 36) -> Bool {
        var lines = 0
        for part in text.split(separator: "\n", omittingEmptySubsequences: false) {
            lines += max(1, (part.count + charsPerLine - 1) / charsPerLine)
            if lines > previewLines { return true }
        }
        return false
    }

    /// YYYY-MM-DD_HHMMSS_message.txt in the given time zone (local time by default).
    public static func saveFilename(epoch: Int64, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd_HHmmss"
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(epoch))) + "_message.txt"
    }
}
