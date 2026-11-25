import Foundation

/// File transfer rules: the auto-download decision, the upload and download status table, the
/// free-storage check and the count of automatic download attempts. Pure functions only.
public enum FileRules {
    /// The largest plaintext file in bytes; the upload limit is maxFile + FileCrypto.overhead.
    public static let maxFile: Int64 = 100_000_000
    /// Auto-download picker limits in bytes: Off, Up to 10 MB, 25 MB, 50 MB, 100 MB.
    public static let pickerSizes: [Int64] = [0, 10_000_000, 25_000_000, 50_000_000, 100_000_000]
    public static let defaultPicker: Int64 = 50_000_000
    /// Bytes kept free beyond 2 x the file size before a download or a send starts.
    public static let freeMargin: Int64 = 10_000_000
    /// Automatic download attempts per file.
    public static let downloadTries = 5
    /// An upload and at most 2 automatic retries of the same send.
    public static let uploadTries = 3
    /// Memory one streaming seal or open needs; the free-memory check before a decrypt asks for this much.
    public static let workingMemory: Int64 = 16 * 1024 * 1024
    /// One file transfer may take this long (timeoutIntervalForResource), so a stuck task ends with a result.
    public static let resourceTimeout: Double = 30 * 60

    public static let filePaused = "File sending is paused. Try again later"
    public static let fileDamaged = "Unable to open this file. It is not valid or was damaged."
    public static let downloadFailed = "Download failed"

    /// The network a phone is on: wifi is any network that is not expensive, mobile any expensive one.
    public enum Network: Equatable, Sendable { case wifi, mobile }

    /// The picker that applies on `network`; Low Data Mode turns the mobile picker Off.
    public static func pickerFor(_ network: Network, wifi: Int64, mobile: Int64, lowData: Bool) -> Int64 {
        network == .wifi ? wifi : (lowData ? 0 : mobile)
    }

    /// True when the picker (bytes, 0 = Off) lets a file of this size download by itself.
    public static func autoDownload(picker: Int64, size: Int64) -> Bool { picker > 0 && size <= picker && size <= maxFile }

    /// Catch-up (app open, open from a notification, network change): a pending file starts by
    /// itself only before it expires by the local clock.
    public static func catchUpDue(size: Int64, expires: Int64, picker: Int64, localNowSec: Int64) -> Bool {
        localNowSec < expires && autoDownload(picker: picker, size: size)
    }

    /// `free`: bytes free on the device; nil = unknown (no check).
    public static func enoughStorage(free: Int64?, size: Int64) -> Bool { free.map { $0 >= 2 * size + freeMargin } ?? true }

    public static func storageFullText(upload: Bool, name: String) -> String {
        "Not enough storage to " + (upload ? "send" : "download") + " \"" + name + "\""
    }

    public enum FinalCode: String, Equatable, Sendable {
        case quota        // 429 file quota
        case paused       // 503 files paused
        case expired
        case deleted
        case update       // 404 update required, or 426
        case tooLarge     // 413
        case storage      // not enough storage on this device
        case damaged      // sha256, size or tag failed twice, or a bad file URL
        case failed       // any other refusal, or the automatic tries are used up
    }

    public enum Outcome: Equatable, Sendable {
        /// Try again; `wait` is the reply's retry_after in seconds, else nil.
        case retry(Int64?)
        /// No automatic retry; `text` is the row or toast text, nil where the caller words it.
        case final(FinalCode, String?)
    }

    /// Seconds, rounded up: "N minutes" under 1 hour, "N hours" under 2 days, else "N days".
    public static func fileWait(_ s: Int64) -> String {
        func plural(_ n: Int64, _ unit: String) -> String { "\(n) \(unit)" + (n == 1 ? "" : "s") }
        let m = max(1, (s + 59) / 60)
        if m < 60 { return plural(m, "minute") }
        let h = (s + 3599) / 3600
        return h < 48 ? plural(h, "hour") : plural((s + 86399) / 86400, "day")
    }

    /// The status table for POST /v1/file and the file GET. status 0 = no reply; error and
    /// retryAfter (seconds, nil when absent or not positive) come from the JSON reply.
    /// Download only: nowSec is the corrected clock and expires the file's expires, so a 404
    /// reads "Deleted" before expires and "Expired" at or after it.
    public static func fileStatus(upload: Bool, status: Int, error: String?, retryAfter: Int64?,
                                  nowSec: Int64 = 0, expires: Int64 = 0) -> Outcome {
        let ra = retryAfter.flatMap { $0 > 0 ? $0 : nil }
        if status == 429 && error == "file quota" {
            return .final(.quota, "You reached your file limit. Try again " + (ra.map { "in " + fileWait($0) } ?? "later"))
        }
        if status == 503 && error == "files paused" {
            return .final(.paused, ra.map { "File sending is over quota and paused for " + fileWait($0) } ?? filePaused)
        }
        if status == 0 || status == 429 || (500 ... 599).contains(status) { return .retry(ra) }
        if status == 426 { return .final(.update, nil) }
        if upload { return status == 413 ? .final(.tooLarge, nil) : .final(.failed, nil) }
        if status == 410 { return .final(.expired, "Expired") }
        if status == 404 && error == "update required" { return .final(.update, "Update the app") }
        if status == 404 { return nowSec < expires ? .final(.deleted, "Deleted") : .final(.expired, "Expired") }
        return .final(.failed, downloadFailed)
    }

    /// Automatic download attempts of one file, kept across runs. used: attempts counted;
    /// openAt: bytes stored when the current run started, -1 when no run is open. A run is
    /// counted when it starts, so a killed process cannot lose the count; a run the system
    /// stopped after it gained bytes is not counted.
    public struct Attempts: Equatable, Sendable {
        public var used: Int
        public var openAt: Int64
        public init(used: Int = 0, openAt: Int64 = -1) {
            self.used = used
            self.openAt = openAt
        }

        /// A run starts with `have` bytes stored. nil: the automatic attempts are used up.
        public func start(have: Int64) -> Attempts? {
            let u = settled(have)
            return u >= FileRules.downloadTries ? nil : Attempts(used: u + 1, openAt: have)
        }

        /// The run ended by itself (done, a final error, or an error to retry): it counts.
        public func end() -> Attempts { Attempts(used: used, openAt: -1) }

        /// The system stopped the run with `have` bytes stored: it counts only when it gained no bytes.
        public func stopped(have: Int64) -> Attempts { Attempts(used: settled(have), openAt: -1) }

        private func settled(_ have: Int64) -> Int { openAt >= 0 && have > openAt ? used - 1 : used }
    }

    /// A file URL: https on a pusharmor.com host, port 443, no user name or password.
    public static func fileURLOK(_ s: String) -> Bool {
        guard s.lowercased().hasPrefix("https://"), let c = URLComponents(string: s), c.scheme?.lowercased() == "https",
              let host = c.host?.lowercased(), host.hasSuffix(".pusharmor.com"), c.port == nil || c.port == 443,
              c.user == nil, c.password == nil else { return false }
        return true
    }
}

/// File names, applied by sender and receiver alike: an ASCII allow-list, a fallback name,
/// reserved device names, and "base (N).ext" on a collision.
public enum FileName {
    static let reserved: Set<String> = Set(["CON", "PRN", "AUX", "NUL"] + (1 ... 9).flatMap { ["COM\($0)", "LPT\($0)"] })

    static func allowed(_ v: UInt32) -> Bool {
        (v >= 0x41 && v <= 0x5a) || (v >= 0x61 && v <= 0x7a) || (v >= 0x30 && v <= 0x39)
            || v == 0x20 || v == 0x2e || v == 0x5f || v == 0x28 || v == 0x29 || v == 0x2d
    }

    static func isAlnum(_ c: Character) -> Bool {
        guard let a = c.asciiValue else { return false }
        return (a >= 0x41 && a <= 0x5a) || (a >= 0x61 && a <= 0x7a) || (a >= 0x30 && a <= 0x39)
    }

    /// base and ".ext" when the text after the last dot is 1-10 ASCII letters or digits, else (name, "").
    public static func splitExt(_ name: String) -> (base: String, ext: String) {
        guard let i = name.lastIndex(of: ".") else { return (name, "") }
        let e = name[name.index(after: i)...]
        if (1 ... 10).contains(e.count), e.allSatisfy(isAlnum) { return (String(name[..<i]), String(name[i...])) }
        return (name, "")
    }

    /// "yyyyMMdd-HHmmss" in UTC.
    static func stamp(_ timeSec: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(timeSec)))
    }

    /// Collapses each run of `c` to one.
    static func collapse(_ s: String, _ c: Character) -> String {
        var out = ""
        var last: Character? = nil
        for ch in s {
            if ch == c && last == c { continue }
            out.append(ch)
            last = ch
        }
        return out
    }

    /// The file name rule. timeSec: Unix seconds for a fallback name (send time, or receive time on a receiver).
    public static func sanitize(_ input: String, timeSec: Int64, image: Bool) -> String {
        let last = input.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        let base0 = last.split(separator: "\\", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        var mapped = ""
        for u in base0.unicodeScalars { mapped.append(allowed(u.value) ? Character(u) : "_") }
        var name = collapse(collapse(mapped, "_"), " ")
        while let f = name.first, f == " " || f == "." { name.removeFirst() }
        while let l = name.last, l == " " || l == "." { name.removeLast() }
        let parts = splitExt(name)
        var base = parts.base
        let ext = parts.ext
        if !base.contains(where: isAlnum) || base.count > 64 {
            base = (image ? "image-" : "file-") + stamp(timeSec)
        }
        name = String((base + ext).prefix(100))
        var head = name.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        while head.last == " " { head.removeLast() }
        if reserved.contains(head.uppercased()) { name = "_" + name }
        return name
    }

    /// name, or "base (N).ext" with the smallest free N >= 1. Names match ignoring ASCII case.
    public static func collide(_ name: String, existing: [String]) -> String {
        let taken = Set(existing.map { $0.lowercased() })
        if !taken.contains(name.lowercased()) { return name }
        let (base, ext) = splitExt(name)
        var n = 1
        while true {
            let c = "\(base) (\(n))\(ext)"
            if !taken.contains(c.lowercased()) { return c }
            n += 1
        }
    }
}

/// PA-FILE1 request signing (POST /v1/file and DELETE /v1/file/<id>).
public enum FileSig {
    public static func postBytes(paTime: String, contentLength: Int64, sha256: String, sendId: String) -> Data {
        Bytes.ascii("PA-FILE1\nPOST\n/v1/file\n" + paTime + "\n" + String(contentLength) + "\n" + sha256 + "\n" + sendId)
    }

    public static func deleteBytes(id: String, paTime: String) -> Data {
        Bytes.ascii("PA-FILE1\nDELETE\n/v1/file/" + id + "\n" + paTime)
    }

    /// A new PA-Send-ID: 22-char b64url of 16 random bytes, one per send, the same on each retry.
    public static func newSendId() -> String { InnerJSON.newId() }

    /// The headers of one POST /v1/file try, signed now; every try is signed again with the same send id.
    public static func uploadHeaders(signer: PASigner, peerId: PeerId, timeMs: Int64, contentLength: Int64,
                                     sha256: String, sendId: String, client: String) throws -> [String: String] {
        let t = RequestSigning.paTime(ms: timeMs)
        let sig = try signer.sign(postBytes(paTime: t, contentLength: contentLength, sha256: sha256, sendId: sendId))
        return ["PA-Client": client, "PA-ID": peerId.text, "PA-Time": t, "Content-Length": String(contentLength),
                "PA-File-SHA256": sha256, "PA-Send-ID": sendId, "PA-Sig": B64URL.encode(sig),
                "Content-Type": "application/octet-stream"]
    }

    /// PA-DL1: a file host GET. `path` is the URL pathname with its leading "/"; Range is not signed.
    public static func downloadBytes(path: String, paTime: String) -> Data {
        Bytes.ascii("PA-DL1\nGET\n" + path + "\n" + paTime)
    }

    /// The headers of one file host GET, signed now; every request is signed again. The public
    /// keys are b64url of the raw points, as at registration.
    public static func downloadHeaders(signer: PASigner, encPub: Data, peerId: PeerId, timeMs: Int64,
                                       path: String) throws -> [String: String] {
        let t = RequestSigning.paTime(ms: timeMs)
        let sig = try signer.sign(downloadBytes(path: path, paTime: t))
        return ["PA-ID": peerId.text, "PA-Time": t, "PA-Sign-Pub": B64URL.encode(signer.publicKey),
                "PA-Enc-Pub": B64URL.encode(encPub), "PA-Sig": B64URL.encode(sig)]
    }
}

/// SHA-256 as 43-char b64url, of bytes or of a whole file (streamed).
public enum FileHash {
    public static func of(_ d: Data) -> String { B64URL.encode(Data(SHA256.hash(data: d))) }

    /// nil when the file cannot be read.
    public static func of(file url: URL) -> String? {
        guard let h = FileHandle(forReadingAtPath: url.path) else { return nil }
        defer { try? h.close() }
        var hasher = SHA256()
        while true {
            let chunk: Data?
            do { chunk = try h.read(upToCount: 64 * 1024) } catch { return nil }
            guard let c = chunk, !c.isEmpty else { break }   // nil or empty: end of file
            hasher.update(data: c)
        }
        return B64URL.encode(Data(hasher.finalize()))
    }
}

/// The 201 reply of POST /v1/file.
public struct UploadReply: Equatable, Sendable {
    public let id: String
    public let expires: Int64
    public let url: String

    /// nil when a field is missing or wrong, or the url is not a file URL.
    public static func parse(_ j: JSONValue?) -> UploadReply? {
        guard let id = j?["id"]?.stringValue, let url = j?["url"]?.stringValue, FileRules.fileURLOK(url),
              case .number(let t)? = j?["expires"], let e = FileRef.uint(t) else { return nil }
        return UploadReply(id: id, expires: e, url: url)
    }
}
