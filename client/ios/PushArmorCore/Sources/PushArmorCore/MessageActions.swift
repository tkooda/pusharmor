import Foundation

/// History message actions (I622): which buttons a message shows, in order,
/// and the default name of a saved text file.
public enum MessageAction: String, Equatable, Sendable {
    case copy, open, share, save
}

public enum MessageActions {
    /// Links and phone numbers: Copy, Open, Share. Plain text: Copy, Share, Save.
    public static func actions(forType type: String) -> [MessageAction] {
        switch type {
        case "url", "tel": return [.copy, .open, .share]
        default: return [.copy, .share, .save]
        }
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
