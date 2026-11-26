import Foundation

/// What the file screens show and decide: pure functions only, so the tables are unit tested.
/// The words match the Android app and the browser extensions.
public enum FileUi {
    public static let helper = "Each received file is available to download for 1 to 24 hours after it is sent, depending on its size"
    /// The line directly above the two auto-download pickers.
    public static let autoDownloadHelper = "Download received files automatically up to these sizes"
    public static let filesHeader = "Files"
    public static let onWifi = "On Wi-Fi"
    public static let onMobile = "On mobile data"
    public static let storageTitle = "Storage for sent and received files"
    public static let storageHelper = "When full, the oldest files are removed from this device"
    public static let removed = "Removed from this device"
    public static let previewNA = "Preview not available"
    public static let chooseFile = "Or choose a file..."
    public static let removeFile = "Remove file"
    public static let willSendFile = "Will be sent as file"
    public static let expired = "Expired"
    /// The longest file name in a toast or error, in characters; a longer one is cut in the middle.
    public static let toastNameMax = 24

    /// A file name in a toast or error: at most toastNameMax characters, cut in the middle with
    /// "...", so its start and its extension show.
    public static func cutName(_ name: String) -> String {
        guard name.count > toastNameMax else { return name }
        return String(name.prefix(toastNameMax - 10)) + "..." + String(name.suffix(7))
    }

    /// A decrypt that could not run (not a damaged file and not short of memory).
    public static func openFailed(_ name: String) -> String { "Unable to decrypt \"" + cutName(name) + "\"\nTry again" }

    public static func noMemoryToast(_ name: String) -> String { "Not enough memory to decrypt \"" + cutName(name) + "\"" }
    public static func tooLarge(_ name: String) -> String { "\"" + cutName(name) + "\" is too large to send" }
    public static func unreadable(_ name: String) -> String { "Unable to read \"" + cutName(name) + "\"" }
    public static func noApp(_ name: String) -> String { "No app can open \"" + cutName(name) + "\"" }
    public static func saved(_ name: String) -> String { "Saved \"" + cutName(name) + "\"" }
    public static func copyFailed(_ name: String) -> String { "Unable to copy \"" + cutName(name) + "\"" }

    /// The toast after Save, nil when the user cancelled: a full disk says so on a second line.
    public static func saveFailed(_ name: String, _ e: Error) -> String? {
        let code = (e as? CocoaError)?.code
        if code == .userCancelled { return nil }
        let head = "Unable to save \"" + cutName(name) + "\""
        return code == .fileWriteOutOfSpace ? head + "\nStorage is full. Free some space and try again" : head
    }

    /// The send popup caption: one device named, else a header over the list.
    public static func sending(_ name: String, to names: [String]) -> String {
        let head = "Sending \"" + name + "\" to"
        return names.count > 1 ? head + ":" : head + " " + (names.first.map { S.quoted($0) } ?? "") + "..."
    }

    // MARK: auto-download

    public static func pickerLabel(_ bytes: Int64) -> String { bytes <= 0 ? "Off" : "Up to \(bytes / 1_000_000) MB" }

    /// A saved picker value that is not one of the choices reads as the default.
    public static func picker(_ saved: String?) -> Int64 {
        guard let s = saved, let v = Int64(s), FileRules.pickerSizes.contains(v) else { return FileRules.defaultPicker }
        return v
    }

    /// The name of a pasted image: image-YYYYMMDD-HHMMSS with the extension from its first bytes.
    public static func pastedImageName(_ head: Data, timeSec: Int64) -> String {
        "image-" + FileName.stamp(timeSec) + "." + (sniffImage(head) ?? "png")
    }

    /// The raster image type of the first bytes, or nil.
    public static func sniffImage(_ d: Data) -> String? {
        let b = [UInt8](d.prefix(16))
        func at(_ i: Int, _ s: String) -> Bool {
            let u = Array(s.utf8)
            return b.count >= i + u.count && Array(b[i ..< i + u.count]) == u
        }
        if b.count >= 8 && b[0] == 0x89 && at(1, "PNG\r\n\u{1a}\n") { return "png" }
        if b.count >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff { return "jpg" }
        if at(0, "GIF87a") || at(0, "GIF89a") { return "gif" }
        if at(0, "RIFF") && at(8, "WEBP") { return "webp" }
        if at(4, "ftypheic") || at(4, "ftypheix") || at(4, "ftypmif1") { return "heic" }
        return nil
    }

    // MARK: storage limit

    public static let storageSizes: [Int64] = [100_000_000, 500_000_000, 1_000_000_000, 5_000_000_000, 10_000_000_000]
    public static let defaultStorage: Int64 = 1_000_000_000

    public static func storageLabel(_ bytes: Int64) -> String {
        bytes >= 1_000_000_000 ? "\(bytes / 1_000_000_000) GB" : "\(bytes / 1_000_000) MB"
    }

    /// Choices that fit the device's storage (`total` bytes, nil = unknown: all); the smallest always shows.
    public static func storageOptions(total: Int64?) -> [Int64] {
        let o = storageSizes.filter { total == nil || $0 <= total! }
        return o.isEmpty ? [storageSizes[0]] : o
    }

    /// The limit in force: the saved choice (default 1 GB), else the largest choice that fits.
    public static func storageLimit(saved: String?, total: Int64?) -> Int64 {
        let o = storageOptions(total: total)
        let s = saved.flatMap { Int64($0) } ?? defaultStorage
        if o.contains(s) { return s }
        return o.last { $0 <= s } ?? o[0]
    }

    /// One stored file: its record id, its time, and the bytes it holds on this device.
    public struct Stored: Equatable, Sendable {
        public let id: Int64
        public let at: Int64
        public let bytes: Int64
        public init(id: Int64, at: Int64, bytes: Int64) {
            self.id = id
            self.at = at
            self.bytes = bytes
        }
    }

    /// Ids to remove, oldest first, until the rest fit `limit`; the newest file always stays.
    public static func toRemove(_ files: [Stored], limit: Int64) -> [Int64] {
        let byAge = files.filter { $0.bytes > 0 }.sorted { ($0.at, $0.id) < ($1.at, $1.id) }
        var total = byAge.reduce(0) { $0 + $1.bytes }
        var out: [Int64] = []
        for f in byAge.dropLast() {
            if total <= limit { break }
            out.append(f.id)
            total -= f.bytes
        }
        return out
    }

    // MARK: row text

    /// "512 bytes", "840 KB", "2.1 MB" (decimal units).
    public static func sizeText(_ bytes: Int64) -> String {
        if bytes < 1000 { return "\(bytes) bytes" }
        if bytes < 1_000_000 {
            let k = (bytes + 500) / 1000
            return k == 1000 ? "1.0 MB" : "\(k) KB"
        }
        let t = (bytes + 50_000) / 100_000
        return "\(t / 10).\(t % 10) MB"
    }

    /// "expires in 23 h", "expires in 40 min"; "Expired" at or after expires (local clock).
    public static func expiresText(_ expires: Int64, nowSec: Int64) -> String {
        let left = expires - nowSec
        if left <= 0 { return expired }
        return left < 3600 ? "expires in \((left + 59) / 60) min" : "expires in \((left + 1799) / 3600) h"
    }

    public enum Kind: Equatable, Sendable { case image, pdf, text, code, audio, video, archive, other }

    static let kinds: [(Kind, Set<String>)] = [
        (.image, ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp"]),
        (.pdf, ["pdf"]),
        (.text, ["txt", "md", "csv", "log"]),
        (.code, ["html", "htm", "json", "js", "xml", "css", "svg"]),
        (.audio, ["mp3", "m4a", "wav", "ogg", "opus", "flac", "aac"]),
        (.video, ["mp4", "mov", "webm", "mkv", "3gp", "m4v"]),
        (.archive, ["zip", "7z", "tar", "gz", "tgz", "rar", "bz2", "xz"]),
    ]

    /// Lowercase extension without the dot, or "".
    public static func ext(_ name: String) -> String { String(FileName.splitExt(name).ext.dropFirst()).lowercased() }

    /// The icon kind, from the extension only (never trusted for View).
    public static func kind(_ name: String) -> Kind {
        let e = ext(name)
        return kinds.first { $0.1.contains(e) }?.0 ?? .other
    }

    /// The SF Symbol of a kind.
    public static func symbol(_ k: Kind) -> String {
        switch k {
        case .image: return "photo"
        case .pdf: return "doc.richtext"
        case .text: return "doc.text"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .audio: return "music.note"
        case .video: return "film"
        case .archive: return "archivebox"
        case .other: return "doc"
        }
    }

    /// "JPEG image", "PDF", "Text", "M4A audio", "MP4 video", "ZIP archive", "DWG file", "File".
    public static func typeLabel(_ name: String) -> String {
        let e = ext(name)
        if e.isEmpty { return "File" }
        let up = e == "jpg" ? "JPEG" : e.uppercased()
        switch kind(name) {
        case .image: return up + " image"
        case .pdf: return "PDF"
        case .text: return "Text"
        case .audio: return up + " audio"
        case .video: return up + " video"
        case .archive: return up + " archive"
        default: return up + " file"
        }
    }

    /// The second line of a file row: "2.1 MB - PDF".
    public static func detail(_ name: String, size: Int64) -> String { sizeText(size) + " - " + typeLabel(name) }

    // MARK: row state

    /// What a received file row shows under its name.
    public enum Status: Equatable, Sendable {
        /// A Download button with the expires text right of it.
        case pending(expires: String)
        case downloading(percent: Int)
        /// Downloaded; the decrypt runs while History shows.
        case decrypting
        /// The text in red (grey for `removed`); download: a Download button with the expires text right of it.
        case failed(text: String, download: Bool, expires: String?)
        /// "Not enough memory to decrypt" and a Decrypt button.
        case noMemory
        /// The decrypt could not run: the text in red and a Decrypt button.
        case decryptFailed(text: String)
        case expired
        /// The decrypted file is on this device.
        case ready
    }

    /// `plainThere`: the decrypted file exists; `received`: bytes of the running download (nil = none reported).
    public static func status(_ f: FileRecord, plainThere: Bool, received: Int64?, nowSec: Int64) -> Status {
        let expires = f.expires ?? 0
        let exp = expiresText(expires, nowSec: nowSec)
        if f.state == "done" {
            if plainThere { return .ready }
            // the decrypted file is gone from this device: a new download while not expired
            return nowSec >= expires ? .failed(text: removed, download: false, expires: nil)
                : .failed(text: removed, download: true, expires: exp)
        }
        if f.code == "memory" { return .noMemory }
        if f.state == "ready", f.code != nil { return .decryptFailed(text: f.error ?? openFailed(f.name)) }
        // past expires by the local clock, a file not on this device has no Download button
        let gone = nowSec >= expires
        if f.state == "failed" {
            let text = f.error ?? FileRules.downloadFailed
            switch FileRules.FinalCode(rawValue: f.code ?? "") {
            case .expired?: return .expired
            case .deleted?, .update?, .damaged?: return .failed(text: text, download: false, expires: nil)
            default: return gone ? .failed(text: text, download: false, expires: nil) : .failed(text: text, download: true, expires: exp)
            }
        }
        if f.state == "loading" {
            let total = f.size + Int64(FileCrypto.overhead)
            let p = received.map { total > 0 ? Int(min(max($0 * 100 / total, 0), 99)) : 0 } ?? 0
            return .downloading(percent: p)
        }
        if f.state == "blob" || f.state == "ready" { return .decrypting }
        if gone { return .expired }
        return .pending(expires: exp)
    }

    /// The buttons of a ready received file: an image that decodes gets View, Copy, Share and Save;
    /// any other file (an image that does not decode too) Open, Share and Save.
    public enum Action: Equatable, Sendable { case view, copy, open, share, save }

    public static func actions(name: String, decodes: Bool) -> [Action] {
        kind(name) == .image && decodes ? [.view, .copy, .share, .save] : [.open, .share, .save]
    }

    /// "Preview not available" shows for a file named as an image that does not decode.
    public static func previewNotAvailable(name: String, decodes: Bool) -> Bool { kind(name) == .image && !decodes }

    /// A sent file that is not in History yet: on its way, or failed before its message went.
    public static func pendingSend(_ f: FileRecord) -> Bool {
        f.dir == .outgoing && f.historyRowid == nil && ["uploading", "uploaded", "sending", "failed"].contains(f.state)
    }
}

extension FileSettingKey {
    /// The storage limit for sent and received files (bytes).
    public static let storage = "file_storage"
}

extension Core {
    /// The storage limit in force; `total`: the device's storage in bytes, nil when unknown.
    public func fileStorageLimit(total: Int64?) -> Int64 {
        FileUi.storageLimit(saved: (try? store.setting(FileSettingKey.storage)) ?? nil, total: total)
    }

    /// Removes the oldest decrypted files until the rest fit `limit`; their rows say "Removed from
    /// this device" (a Download button while not expired). The newest file always stays.
    public func fileEnforceLimit(dir: URL, limit: Int64) throws {
        let done = try store.files(dir: .incoming, states: ["done"]) + store.files(dir: .outgoing, states: ["done"])
        let stored = done.map { FileUi.Stored(id: $0.id, at: $0.created, bytes: $0.size) }
        for id in FileUi.toRemove(stored, limit: limit) {
            guard var f = done.first(where: { $0.id == id }) else { continue }
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f.plainDirName, isDirectory: true))
            f.state = "failed"
            f.code = FileRules.FinalCode.failed.rawValue
            f.error = FileUi.removed
            f.attemptsState = FileRules.Attempts()
            try store.saveFile(f)
        }
    }
}
