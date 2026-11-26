import Foundation

/// The device name rule: ASCII 32..126 except ` \ " { } < > | ! $ ; ?, 1 to 32 characters,
/// no leading "-". Lengths and positions count code points; only spaces are trimmed and collapsed.
public enum DeviceName {
    public static let maxLength = 32
    public static let tooShort = "Name too short"
    public static let invalidCharacters = "Invalid characters"

    static let excluded: Set<UInt32> = Set("`\\\"{}<>|!$;?".unicodeScalars.map { $0.value })

    static func allowed(_ u: Unicode.Scalar) -> Bool {
        u.value >= 32 && u.value <= 126 && !excluded.contains(u.value)
    }

    /// Trims leading and trailing spaces and collapses each run of spaces to one (ASCII space only).
    static func squeeze(_ u: [Unicode.Scalar]) -> [Unicode.Scalar] {
        var out: [Unicode.Scalar] = []
        for c in u where !(c == " " && (out.isEmpty || out.last == " ")) { out.append(c) }
        if out.last == " " { out.removeLast() }
        return out
    }

    static func string(_ u: [Unicode.Scalar]) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: u)
        return String(v)
    }

    /// A typed name (setup and rename): spaces are trimmed and collapsed first. Returns the
    /// name to save, or the error text when the result breaks the rule.
    public static func checkInput(_ s: String) -> (error: String?, name: String?) {
        let u = squeeze(Array(s.unicodeScalars))
        if u.isEmpty { return (tooShort, nil) }
        if u.count > maxLength || u.first == "-" || !u.allSatisfy(allowed) { return (invalidCharacters, nil) }
        return (nil, string(u))
    }

    /// The error text for a typed name, nil when it is accepted.
    public static func inputError(_ s: String) -> String? { checkInput(s).error }

    /// The name made from a system name: curly apostrophes become "'", every other disallowed
    /// character becomes "?", spaces are trimmed and collapsed, a leading "-" becomes "?", then
    /// the first 32 code points, with no space left at the end.
    public static func setupDefault(_ s: String) -> String {
        let mapped = s.unicodeScalars.map { u -> Unicode.Scalar in
            if u == "\u{2018}" || u == "\u{2019}" { return "'" }
            return allowed(u) ? u : "?"
        }
        var u = squeeze(mapped)
        if u.first == "-" { u[0] = "?" }
        return string(squeeze(Array(u.prefix(maxLength))))
    }

    /// A received or stored name as shown: every disallowed character becomes "?", spaces are
    /// trimmed and collapsed, a leading "-" becomes "?", and an empty name shows as "?".
    public static func display(_ s: String) -> String {
        var u = squeeze(s.unicodeScalars.map { allowed($0) ? $0 : "?" })
        if u.isEmpty { return "?" }
        if u.first == "-" { u[0] = "?" }
        return string(u)
    }

    /// ASCII case fold: A-Z become a-z, nothing else changes.
    public static func fold(_ s: String) -> String {
        string(s.unicodeScalars.map { $0.value >= 65 && $0.value <= 90 ? Unicode.Scalar($0.value + 32)! : $0 })
    }

    /// A setup default that equals another device's name (ignoring ASCII case) gets " (N)", N the
    /// smallest number from 2 that gives a free name; the base is cut so the name keeps 32 code
    /// points, with trailing spaces trimmed before the suffix.
    public static func uniqueDefault(_ base: String, taken: [String]) -> String {
        let used = Set(taken.map(fold))
        if !used.contains(fold(base)) { return base }
        var n = 2
        while true {
            let suffix = Array(" (\(n))".unicodeScalars)
            var cut = Array(base.unicodeScalars.prefix(max(0, maxLength - suffix.count)))
            while cut.last == " " { cut.removeLast() }
            let name = string(cut + suffix)
            if !used.contains(fold(name)) { return name }
            n += 1
        }
    }

    /// Rename: another device on the account that already has exactly this name.
    public static func usedBy(_ name: String, peers: [Peer]) -> Peer? {
        peers.first { $0.state != .removed && $0.name == name }
    }
}
