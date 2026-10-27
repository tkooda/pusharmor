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
    public static func parse(_ s: String) -> ParsedURL? {
        guard let colon = s.firstIndex(of: ":") else { return nil }
        let scheme = s[..<colon].lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        var rest = s[s.index(after: colon)...]
        guard rest.hasPrefix("//") else { return nil }
        rest = rest.dropFirst(2)
        let authEnd = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" || $0 == "\\" }) ?? rest.endIndex
        let authority = rest[..<authEnd]
        var tail = String(rest[authEnd...])
        if authority.contains("@") { return nil }
        var hostPart = Substring(authority)
        var port: Substring? = nil
        if hostPart.hasPrefix("[") {
            guard let close = hostPart.firstIndex(of: "]") else { return nil }
            let after = hostPart[hostPart.index(after: close)...]
            if !after.isEmpty {
                guard after.hasPrefix(":") else { return nil }
                port = after.dropFirst()
            }
            hostPart = hostPart[...close]
            let inner = hostPart.dropFirst().dropLast()
            guard !inner.isEmpty, inner.allSatisfy({ $0.isHexDigit || $0 == ":" || $0 == "." }) else { return nil }
        } else if let c = hostPart.lastIndex(of: ":") {
            port = hostPart[hostPart.index(after: c)...]
            hostPart = hostPart[..<c]
        }
        guard !hostPart.isEmpty else { return nil }
        var portText = ""
        if let p = port, !p.isEmpty {
            guard p.allSatisfy({ $0.isASCII && $0.isNumber }), let v = Int(p), v <= 65535 else { return nil }
            if !((scheme == "https" && v == 443) || (scheme == "http" && v == 80)) { portText = ":" + String(v) }
        }
        guard let host = asciiHost(String(hostPart)) else { return nil }
        tail = tail.replacingOccurrences(of: "\\", with: "/")
        if tail.isEmpty || tail.first != "/" { tail = "/" + tail }
        let href = scheme + "://" + host + portText + percentEncode(tail)
        return ParsedURL(href: href, host: host)
    }

    /// Lowercase ASCII labels; IDN labels to punycode ("xn--"). nil on forbidden chars.
    static func asciiHost(_ h: String) -> String? {
        if h.hasPrefix("[") { return h.lowercased() }
        var labels: [String] = []
        for label in h.split(separator: ".", omittingEmptySubsequences: false) {
            let l = String(label).lowercased()
            if l.unicodeScalars.allSatisfy({ $0.isASCII }) {
                let bad: Set<Character> = [" ", "#", "%", "/", ":", "<", ">", "?", "@", "[", "\\", "]", "^", "|"]
                guard !l.contains(where: { bad.contains($0) || $0.asciiValue.map { $0 < 0x21 || $0 == 0x7f } == true }) else { return nil }
                labels.append(l)
            } else {
                guard let p = Punycode.encode(l) else { return nil }
                labels.append("xn--" + p)
            }
        }
        let out = labels.joined(separator: ".")
        return out.isEmpty || out == "." ? nil : out
    }

    /// Percent-encode controls, space, non-ASCII and the few chars WHATWG encodes in paths.
    static func percentEncode(_ s: String) -> String {
        var out = ""
        for b in s.utf8 {
            if b <= 0x20 || b >= 0x7f || b == 0x22 || b == 0x3c || b == 0x3e || b == 0x60 {
                out += String(format: "%%%02X", b)
            } else {
                out.unicodeScalars.append(Unicode.Scalar(b))
            }
        }
        return out
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
