import Foundation

/// Phone number detection and send-type precedence (catalog Phone number detection),
/// one ASCII rule on every platform via NSRegularExpression.
public enum PhoneDetection {
    private static let phone = try! NSRegularExpression(pattern: "^\\+?(?:[ ().-]*[0-9]){7,15}[ ().-]*$")
    private static let ipv4 = try! NSRegularExpression(pattern: "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")
    private static let date = try! NSRegularExpression(
        pattern: "^([0-9]{4}([-. ])[0-9]{2}\\2[0-9]{2}|[0-9]{2}([-. ])[0-9]{2}\\3[0-9]{4})$")

    /// Trim TAB LF FF CR SPACE and NBSP, strip one leading "tel:".
    public static func clean(_ s: String) -> String {
        var t = trimmed(s)
        if t.hasPrefix("tel:") { t = String(t.dropFirst(4)) }
        return t
    }

    static func trimmed(_ s: String) -> String {
        let ws: Set<Unicode.Scalar> = [" ", "\t", "\n", "\r", "\u{0C}", "\u{A0}"]
        var sc = Array(s.unicodeScalars)
        while let f = sc.first, ws.contains(f) { sc.removeFirst() }
        while let l = sc.last, ws.contains(l) { sc.removeLast() }
        var out = ""
        out.unicodeScalars.append(contentsOf: sc)
        return out
    }

    private static func matches(_ r: NSRegularExpression, _ s: String) -> Bool {
        r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// True if the input (after trim and tel: strip) is a phone number.
    public static func isPhone(_ input: String) -> Bool {
        let s = clean(input)
        // ASCII digits only: NSRegularExpression [0-9] is ASCII, but guard non-ASCII anyway
        guard s.utf8.allSatisfy({ $0 < 0x80 }) else { return false }
        return matches(phone, s) && !matches(ipv4, s) && !matches(date, s)
    }
}

/// One http(s) URL rule (catalog Receiver acceptance): a strict parse, scheme http or https
/// (case-insensitive), non-empty host, no userinfo. The result carries the WHATWG-style href
/// (lowercase scheme and host, IDN host as punycode, default port dropped, "/" for an empty
/// path) shown in the notification, History and the Open action, and the host shown to the
/// user. Anything else is shown as plain text.
public struct ParsedURL: Equatable, Sendable {
    public let href: String
    public let host: String
    public var url: URL? { URL(string: href) }
}

public enum URLRule {
    private static let hostForbidden: Set<Unicode.Scalar> = [" ", "#", "%", "/", ":", "<", ">", "?", "@", "[", "\\", "]", "^", "|"]
    private static let pathEncode = Set(" \"#<>?`{}^".utf8)
    private static let queryEncode = Set(" \"#<>'".utf8)
    private static let fragmentEncode = Set(" \"<>`".utf8)
    private static let quad = try! NSRegularExpression(
        pattern: "^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$")

    /// Hand parse that follows the WHATWG URL rules for the supported shapes, after the shared
    /// shape rules (golden url_parse): no control or DEL, no leading or trailing space, no "@"
    /// or "%" in the authority, a numeric host only as a dotted quad, then the shared UTS 46
    /// guard and IDN conversion. Works on Unicode scalars so a combining mark cannot hide a delimiter.
    public static func parse(_ s: String) -> ParsedURL? {
        let sc = Array(s.unicodeScalars)
        guard let first = sc.first, let end = sc.last, first != " ", end != " ",
              !sc.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else { return nil }
        guard let colon = sc.firstIndex(of: ":") else { return nil }
        let scheme = str(sc[..<colon]).lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        guard colon + 2 < sc.count, sc[colon + 1] == "/", sc[colon + 2] == "/" else { return nil }
        let start = colon + 3
        if start < sc.count && (sc[start] == "/" || sc[start] == "\\") { return nil }
        let authEnd = sc[start...].firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" || $0 == "\\" }) ?? sc.count
        let authority = Array(sc[start..<authEnd])
        if authority.contains("@") || authority.contains("%") { return nil }
        var hostPart = authority[...]
        var port: ArraySlice<Unicode.Scalar>? = nil
        if hostPart.first == "[" {
            guard let close = hostPart.firstIndex(of: "]") else { return nil }
            let after = hostPart[(close + 1)...]
            if !after.isEmpty {
                guard after.first == ":" else { return nil }
                port = after.dropFirst()
            }
            hostPart = hostPart[...close]
            let inner = hostPart.dropFirst().dropLast()
            guard !inner.isEmpty, inner.allSatisfy({ $0.properties.isASCIIHexDigit || $0 == ":" || $0 == "." }) else { return nil }
        } else if let c = hostPart.lastIndex(of: ":") {
            port = hostPart[(c + 1)...]
            hostPart = hostPart[..<c]
        }
        guard !hostPart.isEmpty else { return nil }
        let host: String
        if hostPart.first == "[" {
            host = str(hostPart).lowercased()
        } else {
            guard let h = asciiHost(Array(hostPart)) else { return nil }
            host = h
        }
        var portText = ""
        if let p = port, !p.isEmpty {
            guard p.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) else { return nil }
            let digits = p.drop(while: { $0 == "0" })
            guard digits.count <= 5 else { return nil }
            let v = digits.isEmpty ? 0 : Int(str(digits))!
            guard v <= 65535 else { return nil }
            if !((scheme == "https" && v == 443) || (scheme == "http" && v == 80)) { portText = ":" + String(v) }
        }
        var rest = Array(sc[authEnd...])
        var query: [Unicode.Scalar]? = nil
        var fragment: [Unicode.Scalar]? = nil
        if let i = rest.firstIndex(of: "#") { fragment = Array(rest[(i + 1)...]); rest = Array(rest[..<i]) }
        if let i = rest.firstIndex(of: "?") { query = Array(rest[(i + 1)...]); rest = Array(rest[..<i]) }
        let slash: Unicode.Scalar = "/"
        var path = dotSegments(encode(rest.map { $0 == "\\" ? slash : $0 }, pathEncode))
        if path.isEmpty { path = "/" }
        var href = scheme + "://" + host + portText + path
        if let q = query { href += "?" + encode(q, queryEncode) }
        if let f = fragment { href += "#" + encode(f, fragmentEncode) }
        return ParsedURL(href: href, host: host)
    }

    private static func str<S: Sequence>(_ x: S) -> String where S.Element == Unicode.Scalar {
        var out = ""
        out.unicodeScalars.append(contentsOf: x)
        return out
    }

    /// Shared UTS 46 guard (golden url_parse): a host a browser would map or reject stays text.
    /// The host must equal its NFKC form; each non-ASCII scalar must equal its own full
    /// lowercase mapping and not be ignorable (Default_Ignorable_Code_Point, plus U+3002, which
    /// UTS 46 maps to "."); no label may start with a combining mark (Mn, Mc, Me).
    static func idnOk(_ h: [Unicode.Scalar]) -> Bool {
        if Array(str(h).precomposedStringWithCompatibilityMapping.unicodeScalars) != h { return false }
        for c in h where !c.isASCII {
            if ignorable(c.value) || Array(c.properties.lowercaseMapping.unicodeScalars) != [c] { return false }
        }
        let marks: [Unicode.GeneralCategory] = [.nonspacingMark, .spacingMark, .enclosingMark]
        return !h.split(separator: ".").contains { marks.contains($0.first!.properties.generalCategory) }
    }

    static func ignorable(_ c: UInt32) -> Bool {
        c == 0xad || c == 0x34f || c == 0x61c || (0x115f...0x1160).contains(c) || (0x17b4...0x17b5).contains(c) ||
            (0x180b...0x180f).contains(c) || (0x200b...0x200f).contains(c) || (0x202a...0x202e).contains(c) ||
            (0x2060...0x206f).contains(c) || c == 0x3002 || c == 0x3164 || (0xfe00...0xfe0f).contains(c) ||
            c == 0xfeff || c == 0xffa0 || (0xfff0...0xfff8).contains(c) || (0x1bca0...0x1bca3).contains(c) ||
            (0x1d173...0x1d17a).contains(c) || (0xe0000...0xe0fff).contains(c)
    }

    /// Shared IDN conversion (golden url_parse), after idnOk: ASCII A-Z to lowercase, then a
    /// label with a non-ASCII scalar becomes "xn--" punycode. nil on forbidden chars, a host
    /// idnOk rejects, or a numeric host that is not a dotted quad.
    static func asciiHost(_ h: [Unicode.Scalar]) -> String? {
        if h.contains(where: { hostForbidden.contains($0) }) || !idnOk(h) { return nil }
        let lower = h.map { ($0.value >= 0x41 && $0.value <= 0x5a) ? Unicode.Scalar($0.value + 32)! : $0 }
        var labels: [String] = []
        for label in lower.split(separator: ".", omittingEmptySubsequences: false) {
            if label.allSatisfy({ $0.isASCII }) {
                labels.append(str(label))
            } else {
                guard let p = Punycode.encode(str(label)) else { return nil }
                labels.append("xn--" + p)
            }
        }
        let out = labels.joined(separator: ".")
        if out.isEmpty { return nil }
        if labels.count > 1 && labels.last == "" { labels.removeLast() }
        let last = labels.last ?? ""
        let isDigit = { (b: UInt8) in b >= 0x30 && b <= 0x39 }
        let endsInNumber = (!last.isEmpty && last.utf8.allSatisfy(isDigit)) ||
            (last.hasPrefix("0x") && last.utf8.dropFirst(2).allSatisfy { isDigit($0) || ($0 >= 0x61 && $0 <= 0x66) })
        if endsInNumber && quad.firstMatch(in: out, range: NSRange(out.startIndex..., in: out)) == nil { return nil }
        return out
    }

    /// Percent-encode non-ASCII (as UTF-8) and the bytes in the set; existing escapes stay.
    static func encode(_ s: [Unicode.Scalar], _ set: Set<UInt8>) -> String {
        var out = ""
        for b in str(s).utf8 {
            if b >= 0x80 || set.contains(b) {
                out += String(format: "%%%02X", b)
            } else {
                out.unicodeScalars.append(Unicode.Scalar(b))
            }
        }
        return out
    }

    /// WHATWG dot segments: "." and ".." (also as %2e) collapse; the root is never left.
    static func dotSegments(_ path: String) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var out: [String] = []
        for (i, seg) in parts.enumerated() {
            let last = i == parts.count - 1
            switch seg.lowercased() {
            case ".", "%2e":
                if last { out.append("") }
            case "..", ".%2e", "%2e.", "%2e%2e":
                if out.count > 1 { out.removeLast() }
                if last { out.append("") }
            default:
                out.append(seg)
            }
        }
        return out.joined(separator: "/")
    }

    /// Re-check before opening (section 10): scheme http or https, case-insensitive.
    public static func isOpenable(_ u: URL) -> Bool {
        guard let s = u.scheme?.lowercased() else { return false }
        return s == "http" || s == "https"
    }
}

/// RFC 3492 punycode encoder (for IDN hosts).
enum Punycode {
    static func encode(_ input: String) -> String? {
        let base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700
        let cps = input.unicodeScalars.map { Int($0.value) }
        var out = cps.filter { $0 < 0x80 }.map { Character(Unicode.Scalar(UInt8($0))) }
        let b = out.count
        var h = b
        if b > 0 { out.append("-") }
        var n = 0x80, delta = 0, bias = 72
        func digit(_ d: Int) -> Character { Character(Unicode.Scalar(UInt8(d < 26 ? d + 97 : d + 22))) }
        func adapt(_ d0: Int, _ num: Int, _ first: Bool) -> Int {
            var d = first ? d0 / damp : d0 / 2
            d += d / num
            var k = 0
            while d > ((base - tMin) * tMax) / 2 { d /= base - tMin; k += base }
            return k + (base - tMin + 1) * d / (d + skew)
        }
        while h < cps.count {
            guard let m = cps.filter({ $0 >= n }).min() else { return nil }
            delta += (m - n) * (h + 1)
            n = m
            for c in cps {
                if c < n { delta += 1 }
                if c == n {
                    var q = delta
                    var k = base
                    while true {
                        let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)
                        if q < t { break }
                        out.append(digit(t + (q - t) % (base - t)))
                        q = (q - t) / (base - t)
                        k += base
                    }
                    out.append(digit(q))
                    bias = adapt(delta, h + 1, h == b)
                    delta = 0
                    h += 1
                }
            }
            delta += 1
            n += 1
        }
        return String(out)
    }
}

/// Send type badge: tel: URI > one http(s) URL > phone > text.
public enum SendType: String, Sendable { case url, text, tel }

public enum SendDetection {
    public static func detect(_ input: String) -> SendType {
        let t = PhoneDetection.trimmed(input)
        if t.lowercased().hasPrefix("tel:") && PhoneDetection.isPhone(t) { return .tel }
        if URLRule.parse(t) != nil { return .url }
        if PhoneDetection.isPhone(t) { return .tel }
        return .text
    }
}

/// Size cap helpers (catalog Size cap).
public enum SizeCap {
    public static let bytes = 2048

    public static func count(_ s: String) -> Int { s.utf8.count }

    /// Red at 90 pc.
    public static func isWarning(_ s: String) -> Bool { count(s) * 10 >= bytes * 9 }

    public static func isOver(_ s: String) -> Bool { count(s) > bytes }

    /// "(N / 2048)" or "Too long (N / 2048)".
    public static func label(_ s: String) -> String {
        let n = count(s)
        return n > bytes ? "Too long (\(n) / \(bytes))" : "(\(n) / \(bytes))"
    }

    /// The first 2048 bytes, cut on a UTF-8 boundary.
    public static func truncated(_ s: String) -> String {
        var out = ""
        var n = 0
        for ch in s.unicodeScalars {
            let l = String(ch).utf8.count
            if n + l > bytes { break }
            out.unicodeScalars.append(ch)
            n += l
        }
        return out
    }
}
