import Foundation

/// File transfer steps between the platform transfer tasks and the store: what to do after a
/// download or an upload try, the catch-up list, the send preparation, the file message and
/// the decrypt with its mark. The platform code runs the tasks; these decide.
public enum FileFlow {
    /// What follows one download task.
    public enum DownloadNext: Equatable, Sendable {
        /// Size and sha256 match: the blob waits for its decrypt.
        case ready
        /// The blob failed its check for the first time: download it once more.
        case again
        /// An error to retry later (retry_after seconds when given).
        case retry(Int64?)
        case final(FileRules.FinalCode, String)
    }

    /// The decision after a download. blobSize and blobSHA describe the file that arrived (nil
    /// when none). The HTTP status is checked before any hash: 404 and 410 are never "damaged".
    public static func afterDownload(status: Int, error: String?, retryAfter: Int64?, blobSize: Int64?, blobSHA: String?,
                                     ref: FileRef, again: Bool, nowSec: Int64) -> DownloadNext {
        if status == 200 || status == 206 {
            if let size = blobSize, size == ref.size + Int64(FileCrypto.overhead), blobSHA == ref.sha256 { return .ready }
            return again ? .final(.damaged, FileRules.fileDamaged) : .again
        }
        switch FileRules.fileStatus(upload: false, status: status, error: error, retryAfter: retryAfter, nowSec: nowSec,
                                    expires: ref.expires) {
        case .retry(let w): return .retry(w)
        case .final(let c, let t): return .final(c, t ?? FileRules.downloadFailed)
        }
    }

    /// What follows one upload try.
    public enum UploadNext: Equatable, Sendable {
        case uploaded(UploadReply)
        /// Sign again with the same PA-Send-ID and send the same blob file (after `wait` seconds when given).
        case resubmit(Int64?)
        /// No automatic retry; text nil = the caller words it.
        case final(FileRules.FinalCode, String?)
    }

    /// The decision after upload try number `tries` (1-based): a 401 time error, a transport
    /// error, a 429 rate limit or a 5xx is sent again while tries < 3; anything else is final.
    public static func afterUpload(status: Int, json: JSONValue?, tries: Int) -> UploadNext {
        if (200 ... 299).contains(status) {
            guard let r = UploadReply.parse(json) else { return .final(.failed, nil) }
            return .uploaded(r)
        }
        let error = json?["error"]?.stringValue
        var ra: Int64? = nil
        if case .number(let t)? = json?["retry_after"] { ra = FileRef.uint(t) }
        if status == 401 && error == "clock skew" {
            return tries < FileRules.uploadTries ? .resubmit(nil) : .final(.failed, nil)
        }
        switch FileRules.fileStatus(upload: true, status: status, error: error, retryAfter: ra) {
        case .retry(let w): return tries < FileRules.uploadTries ? .resubmit(w) : .final(.failed, nil)
        case .final(let c, let t): return .final(c, t)
        }
    }

    /// Image extensions: a fallback name starts "image-".
    static let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "bmp"]

    /// The name rule with the image fallback chosen from the extension.
    public static func name(_ raw: String, timeSec: Int64) -> String {
        let plain = FileName.sanitize(raw, timeSec: timeSec, image: false)
        let ext = FileName.splitExt(plain).ext.dropFirst().lowercased()
        return imageExts.contains(ext) ? FileName.sanitize(raw, timeSec: timeSec, image: true) : plain
    }
}

/// The settings of the two auto-download pickers (bytes; 0 = Off).
public enum FileSettingKey {
    public static let wifi = "file_wifi"
    public static let mobile = "file_mobile"
}

extension Core {
    public enum FileSendError: Error, Equatable {
        case noRecipients
        case tooLarge
        /// Not enough storage: the text names the file.
        case storage(String)
        case unreadable
    }

    /// The files record of a received file message; the receiver applies the name rule itself.
    static func receivedFile(_ f: FileRef, historyRowid: Int64, now: Int64) -> FileRecord {
        var r = FileRecord(dir: .incoming, key: f.key, name: FileFlow.name(f.name, timeSec: now), size: f.size,
                           state: "pending", created: now)
        r.historyRowid = historyRowid
        r.url = f.url
        r.expires = f.expires
        r.sha256 = f.sha256
        return r
    }

    /// The two pickers, default Up to 50 MB.
    public func filePickers() -> (wifi: Int64, mobile: Int64) {
        func v(_ k: String) -> Int64 {
            guard let s = try? store.setting(k), let x = Int64(s), FileRules.pickerSizes.contains(x) else { return FileRules.defaultPicker }
            return x
        }
        return (v(FileSettingKey.wifi), v(FileSettingKey.mobile))
    }

    /// Worker time in Unix seconds (local clock + PA-Epoch offset).
    var fileNowSec: Int64 { api.workerNowMs / 1000 }

    /// The picker allows this file on the current network now and it has not expired by the local clock.
    public func fileDue(_ f: FileRecord, network: FileRules.Network, lowData: Bool) -> Bool {
        let p = filePickers()
        let picker = FileRules.pickerFor(network, wifi: p.wifi, mobile: p.mobile, lowData: lowData)
        return FileRules.catchUpDue(size: f.size, expires: f.expires ?? 0, picker: picker, localNowSec: clock())
    }

    /// Catch-up (app open, open from a notification, network change): the pending received files to
    /// download now. A file without room gets the storage error (final, Retry stays).
    public func fileCatchUp(network: FileRules.Network, lowData: Bool, free: Int64?) throws -> [FileRecord] {
        var out: [FileRecord] = []
        for var f in try store.files(dir: .incoming, states: ["pending"]) where fileDue(f, network: network, lowData: lowData) {
            if !FileRules.enoughStorage(free: free, size: f.size) {
                f.state = "failed"
                f.code = FileRules.FinalCode.storage.rawValue
                f.error = FileRules.storageFullText(upload: false, name: f.name)
                try store.saveFile(f)
                continue
            }
            out.append(f)
        }
        return out
    }

    /// A download task starts for `id` (`have`: bytes kept from an earlier try). false: the
    /// automatic attempts are used up (the row then shows "Download failed"), or the file is
    /// not waiting for a download. `manual`: the Download button, which always starts.
    public func fileDownloadStarts(_ id: Int64, task: String, have: Int64, manual: Bool = false) throws -> Bool {
        try store.db.write {
            guard var f = try store.file(id), f.dir == .incoming, ["pending", "loading", "failed"].contains(f.state) else { return false }
            if manual {
                f.attemptsState = FileRules.Attempts(used: 0, openAt: -1).start(have: have)!
            } else if let a = f.attemptsState.start(have: have) {
                f.attemptsState = a
            } else {
                f.state = "failed"
                f.code = FileRules.FinalCode.failed.rawValue
                f.error = FileRules.downloadFailed
                f.task = nil
                try store.saveFile(f)
                return false
            }
            f.state = "loading"
            f.task = task
            f.code = nil
            f.error = nil
            try store.saveFile(f)
            return true
        }
    }

    /// The task of `id` ended (any process): its reply, before any check. blobArrived: the
    /// downloaded body is now at the record's blob name.
    public func fileTaskEnded(_ id: Int64, status: Int, body: Data?, blobArrived: Bool) throws {
        try store.db.write {
            guard var f = try store.file(id) else { return }
            let j = body.flatMap { $0.count <= 4096 ? try? StrictJSON.parse($0) : nil }
            f.status = status
            f.replyError = j?["error"]?.stringValue
            if case .number(let t)? = j?["retry_after"] { f.retryAfter = FileRef.uint(t) } else { f.retryAfter = nil }
            f.task = nil
            if f.dir == .incoming {
                f.attemptsState = f.attemptsState.end()
                f.state = blobArrived ? "blob" : "pending"
            }
            try store.saveFile(f)
        }
    }

    /// App only: checks an arrived blob (HTTP status first, then size and sha256) and moves
    /// the record on. `dir`: the files directory.
    @discardableResult
    public func fileCheck(_ id: Int64, dir: URL) throws -> FileFlow.DownloadNext? {
        guard var f = try store.file(id), f.dir == .incoming, let ref = f.ref, ["blob", "pending"].contains(f.state),
              f.status != 0 || f.state == "blob" else { return nil }
        let blob = dir.appendingPathComponent(f.blobName)
        var size: Int64? = nil
        var sha: String? = nil
        if f.state == "blob" {
            if let a = try? FileManager.default.attributesOfItem(atPath: blob.path), let n = a[.size] as? NSNumber {
                size = n.int64Value
            }
            sha = FileHash.of(file: blob)
        }
        let next = FileFlow.afterDownload(status: f.status, error: f.replyError, retryAfter: f.retryAfter, blobSize: size,
                                          blobSHA: sha, ref: ref, again: f.again, nowSec: fileNowSec)
        switch next {
        case .ready:
            f.state = "ready"
        case .again:
            try? FileManager.default.removeItem(at: blob)
            f.again = true
            f.state = "pending"
        case .retry:
            if f.state == "blob" { try? FileManager.default.removeItem(at: blob) }
            f.state = "pending"
        case .final(let c, let t):
            try? FileManager.default.removeItem(at: blob)
            f.state = "failed"
            f.code = c.rawValue
            f.error = t
        }
        f.status = 0
        try store.saveFile(f)
        return next
    }

    /// Received files whose decrypt mark is still set at app start: the app closed during that
    /// decrypt. They show the memory error and are never retried by themselves.
    public func settleDecryptMarks() throws {
        try store.db.write {
            for var f in try store.allFiles() where f.decryptMark != nil {
                f.decryptMark = nil
                f.code = "memory"
                f.error = S.notEnoughMemory
                try store.saveFile(f)
            }
        }
    }

    public enum DecryptResult: Equatable, Sendable {
        /// The file is at the URL.
        case done(URL)
        case noMemory
        /// The tag failed: downloaded once more (`again`), or damaged.
        case again
        case damaged
    }

    /// Decrypts a ready file into `dir`/<in-id>/<name>. `freeMemory` nil = unknown. The mark is
    /// set before the decrypt and cleared after it, whatever the result; `manual` (the
    /// Decrypt button) skips the memory check.
    public func fileDecrypt(_ id: Int64, dir: URL, freeMemory: Int64?, manual: Bool) throws -> DecryptResult {
        guard var f = try store.file(id), f.dir == .incoming, f.state == "ready", let key = B64URL.decode(f.key) else { return .damaged }
        if !manual, let m = freeMemory, m < FileRules.workingMemory {
            f.code = "memory"
            f.error = S.notEnoughMemory
            try store.saveFile(f)
            return .noMemory
        }
        f.decryptMark = clock() * 1000
        f.code = nil
        f.error = nil
        try store.saveFile(f)
        let blob = dir.appendingPathComponent(f.blobName)
        let outDir = dir.appendingPathComponent(f.plainDirName, isDirectory: true)
        let out = outDir.appendingPathComponent(f.name)
        let result: DecryptResult
        do {
            try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
            try FileCrypto.decrypt(input: blob, output: out, key: key)
            try? FileManager.default.removeItem(at: blob)
            f.state = "done"
            result = .done(out)
        } catch FileCrypto.Failure.tagMismatch {
            try? FileManager.default.removeItem(at: blob)
            if f.again {
                f.state = "failed"
                f.code = FileRules.FinalCode.damaged.rawValue
                f.error = FileRules.fileDamaged
                result = .damaged
            } else {
                f.again = true
                f.state = "pending"
                result = .again
            }
        } catch FileCrypto.Failure.tooShort {
            try? FileManager.default.removeItem(at: blob)
            f.state = "failed"
            f.code = FileRules.FinalCode.damaged.rawValue
            f.error = FileRules.fileDamaged
            result = .damaged
        } catch {
            // not a verdict on the file (a file system error): it stays ready
            f.decryptMark = nil
            try? store.saveFile(f)
            throw error
        }
        f.decryptMark = nil
        try store.saveFile(f)
        return result
    }

    /// An orderly stop of a decrypt (cancelled, temp file deleted): the mark goes.
    public func clearDecryptMark(_ id: Int64) throws {
        guard var f = try store.file(id), f.decryptMark != nil else { return }
        f.decryptMark = nil
        try store.saveFile(f)
    }

    // MARK: send

    /// Share sheet step 1: checks size and room, applies the name rule, encrypts `input` into
    /// the files directory and keeps the send (state uploading). `free`: bytes free, nil = unknown.
    public func fileSendPrepare(input: URL, rawName: String, to recipients: [PeerId], allCount: Int, dir: URL,
                                free: Int64?) throws -> FileRecord {
        guard !recipients.isEmpty else { throw FileSendError.noRecipients }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: input.path), let sizeN = attrs[.size] as? NSNumber else {
            throw FileSendError.unreadable
        }
        let size = sizeN.int64Value
        guard size <= FileRules.maxFile else { throw FileSendError.tooLarge }
        let now = clock()
        let name = FileFlow.name(rawName, timeSec: now)
        guard FileRules.enoughStorage(free: free, size: size) else {
            throw FileSendError.storage(FileRules.storageFullText(upload: true, name: name))
        }
        var g = SystemRandomNumberGenerator()
        let key = Data((0 ..< FileCrypto.keySize).map { _ in UInt8.random(in: 0 ... 255, using: &g) })
        var f = FileRecord(dir: .outgoing, key: B64URL.encode(key), name: name, size: size, state: "uploading", created: now)
        f.sendId = FileSig.newSendId()
        f.recipients = recipients.map { $0.text }
        f.msgId = InnerJSON.newId()
        f.allCount = allCount
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        f.id = try store.addFile(f)
        let blob = dir.appendingPathComponent(f.blobName)
        do {
            try FileCrypto.encrypt(input: input, output: blob, key: key)
            guard let sha = FileHash.of(file: blob) else { throw FileSendError.unreadable }
            f.sha256 = sha
            try store.saveFile(f)
        } catch {
            try? FileManager.default.removeItem(at: blob)
            try? store.db.exec("DELETE FROM files WHERE id = ?", [.int(f.id)])
            if error is FileCrypto.Failure { throw FileSendError.unreadable }
            throw error
        }
        return f
    }

    /// One upload try of send `id`: counts the try and signs the request now (every try is signed
    /// again, with the same PA-Send-ID). Returns the URL and headers; nil when the send is not
    /// uploading or the request cannot be signed.
    public func fileUploadTry(_ id: Int64) throws -> (url: URL, headers: [String: String])? {
        guard var f = try store.file(id), f.dir == .outgoing, f.state == "uploading", let sha = f.sha256, let sid = f.sendId,
              let me = try store.me().id else { return nil }
        f.tries += 1
        try store.saveFile(f)
        guard let h = try? FileSig.uploadHeaders(signer: keys.signer, peerId: me, timeMs: api.workerNowMs,
                                                 contentLength: f.size + Int64(FileCrypto.overhead), sha256: sha, sendId: sid,
                                                 client: api.client) else { return nil }
        return (URL(string: "/v1/file", relativeTo: api.base)!.absoluteURL, h)
    }

    /// An upload try of send `id` ended with this reply (status 0 = transport error). PA-Epoch
    /// updates the clock offset before a resubmit is signed.
    @discardableResult
    public func fileUploadEnded(_ id: Int64, status: Int, body: Data?, epoch: String?) throws -> FileFlow.UploadNext? {
        if let e = epoch, let sec = Int64(e), (1 ... APIClient.maxEpochS).contains(sec) { api.setOffset(sec - api.clockMs() / 1000) }
        if status == 426 { NotificationCenter.default.post(name: APIClient.upgradeRequired, object: api) }
        let j = body.flatMap { $0.count <= 4096 ? try? StrictJSON.parse($0) : nil }
        if status == 401 && j?["error"]?.stringValue == "logged out" { try? store.setMe("logged_out", .int(1)) }
        return try store.db.write { () -> FileFlow.UploadNext? in
            guard var f = try store.file(id), f.dir == .outgoing, f.state == "uploading" else { return nil }
            let next = FileFlow.afterUpload(status: status, json: j, tries: f.tries)
            f.task = nil
            f.status = status
            switch next {
            case .uploaded(let r):
                f.url = r.url
                f.expires = r.expires
                f.state = "uploaded"
            case .resubmit:
                break
            case .final(let c, let t):
                f.state = "failed"
                f.code = c.rawValue
                f.error = t
            }
            try store.saveFile(f)
            return next
        }
    }

    /// Sends the file message of an uploaded send to its devices (the upload reply is used again
    /// on a later try of the same send). On success the outgoing row is written and the blob
    /// goes. A send whose file expired fails.
    public func fileSendMessage(_ id: Int64, dir: URL) async throws -> SendReport {
        guard var f = try store.file(id), f.dir == .outgoing, f.state == "uploaded", let ref = f.ref, let msgId = f.msgId else {
            throw FileSendError.unreadable
        }
        if fileNowSec >= ref.expires {
            f.state = "failed"
            f.code = FileRules.FinalCode.expired.rawValue
            f.error = "Expired"
            try store.saveFile(f)
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f.blobName))
            throw FileSendError.unreadable
        }
        let ids = f.recipients.compactMap { PeerId(text: $0) }
        let rep = try await sendContent(.file(ref), rowType: "unknown", rowContent: "file", msgId: msgId, to: ids,
                                        allCount: f.allCount)
        f.state = "sent"
        f.historyRowid = rep.rowid
        try store.saveFile(f)
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(f.blobName))
        return rep
    }

    /// A send that cannot finish (its upload failed or the app gave up): its blob goes.
    public func fileSendFailed(_ id: Int64, dir: URL, code: FileRules.FinalCode, text: String?) throws {
        guard var f = try store.file(id), f.dir == .outgoing, f.state != "sent" else { return }
        f.state = "failed"
        f.code = code.rawValue
        f.error = text
        f.task = nil
        try store.saveFile(f)
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(f.blobName))
    }

    /// Records whose History row is gone lose their local files; local files with no record go too.
    public func pruneFiles(dir: URL) throws {
        _ = try store.dropOrphanFiles()
        let keep = Set(try store.allFiles().flatMap { [$0.blobName, $0.resumeName, $0.plainDirName] })
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for n in names where !keep.contains(n) && !n.hasPrefix(".") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }
}
