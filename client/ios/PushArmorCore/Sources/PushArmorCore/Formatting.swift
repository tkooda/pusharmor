import Foundation

/// Small pure helpers for the UI and sign-in.
public enum Pairing {
    public static let timeoutDays: Int64 = 30
    public static let timeout: Int64 = timeoutDays * 86400

    /// Countdown text: "X days" at 24 h or more left, "X hours" under 24 h, "X minutes"
    /// under 60 min (from started_at + 30 days). Days and hours round down; minutes round up
    /// so the row never reads "0 minutes" before it expires. nil when expired.
    public static func countdown(startedAt: Int64, now: Int64) -> String? {
        let left = startedAt + timeout - now
        if left <= 0 { return nil }
        func unit(_ v: Int64, _ one: String, _ many: String) -> String { "\(v) " + (v == 1 ? one : many) }
        if left >= 86400 { return unit(left / 86400, "day", "days") }
        if left >= 3600 { return unit(left / 3600, "hour", "hours") }
        return unit((left + 59) / 60, "minute", "minutes")
    }

    public static func isExpired(startedAt: Int64, now: Int64) -> Bool { now >= startedAt + timeout }
}

/// The dial string for a tel message: a leading "+" is kept, every other separator is dropped.
public enum DialString {
    public static func make(_ content: String) -> String {
        var t = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.lowercased().hasPrefix("tel:") { t = String(t.dropFirst(4)).trimmingCharacters(in: .whitespaces) }
        let digits = String(t.filter { $0.isASCII && $0.isNumber })
        return t.hasPrefix("+") ? "+" + digits : digits
    }
}

/// Email code entry (catalog Login client notes, ios 5.1).
public enum EmailCode {
    public static let length = 6

    /// Uppercase, O -> 0, I/L -> 1, drop every char outside the Crockford alphabet.
    public static func clean(_ s: String) -> String {
        var out = ""
        for ch in s.uppercased() {
            let c: Character
            switch ch {
            case "O": c = "0"
            case "I", "L": c = "1"
            default: c = ch
            }
            if Crockford.alphabet.contains(c) { out.append(c) }
        }
        return out
    }

    /// A pasted text: a line that is a standalone 6-char token (inner dashes or spaces
    /// allowed) wins; else the whole cleaned input when it is exactly 6 chars; else nil.
    public static func submittable(_ input: String) -> String? {
        for line in input.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            let t = line.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty, t.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == " ") })
            else { continue }
            let c = clean(t)
            if c.count == length && t.filter({ $0.isLetter || $0.isNumber }).count == length { return c }
        }
        let c = clean(input)
        return c.count == length ? c : nil
    }
}

/// APNs environment (ios 5.2): a pure function of the embedded.mobileprovision facts.
public enum APNsEnvironment {
    public static func pushType(fileFound: Bool, env: String?, isSimulator: Bool) -> PushInfo.Kind {
        if isSimulator { return .apnsSandbox }
        if fileFound && env == "development" { return .apnsSandbox }
        return .apns
    }

    /// The aps-environment entitlement from the plist inside an embedded.mobileprovision
    /// (a CMS blob); nil if absent or unreadable.
    public static func apsEnvironment(provision: Data) -> String? {
        let b = [UInt8](provision)
        let start = Array("<?xml".utf8), end = Array("</plist>".utf8)
        guard let s = find(b, start, from: 0), let e = find(b, end, from: s) else { return nil }
        let xml = Data(b[s ..< e + end.count])
        guard let pl = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
              let ent = pl["Entitlements"] as? [String: Any] else { return nil }
        return ent["aps-environment"] as? String
    }

    private static func find(_ h: [UInt8], _ n: [UInt8], from: Int) -> Int? {
        guard h.count >= n.count, from <= h.count - n.count else { return nil }
        for i in from ... (h.count - n.count) where h[i] == n[0] && Array(h[i ..< i + n.count]) == n {
            return i
        }
        return nil
    }
}
