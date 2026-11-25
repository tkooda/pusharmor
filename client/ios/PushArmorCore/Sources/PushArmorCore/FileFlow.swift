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
        /// The first 401 "clock skew" in a row: start again now, signed with a fresh PA-Time
        /// (not an attempt).
        case signAgain
        case final(FileRules.FinalCode, String)
    }

    /// The decision after a download. blobSize and blobSHA describe the file that arrived (nil
    /// when none). The HTTP status is checked before any hash: 404 and 410 are never "damaged".
    /// `skewFirst`: this 401 "clock skew" follows no other one (Store.fileTaskEnded); a second
    /// one in a row ends in the usual "Download failed".
    public static func afterDownload(status: Int, error: String?, retryAfter: Int64?, blobSize: Int64?, blobSHA: String?,
                                     ref: FileRef, again: Bool, nowSec: Int64, skewFirst: Bool = false) -> DownloadNext {
        if status == 200 || status == 206 {
            if let size = blobSize, size == ref.size + Int64(FileCrypto.overhead), blobSHA == ref.sha256 { return .ready }
            return again ? .final(.damaged, FileRules.fileDamaged) : .again
        }
        if status == 401 && error == "clock skew" && skewFirst { return .signAgain }
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
        /// The user cancelled during the encrypt: the record and the blob are gone.
        case cancelled
    }

    /// The files record of a received file message; the receiver applies the name rule itself.
    static func receivedFile(_ f: FileRef, historyRowid: Int64, now: Int64) -> FileRecord {
        var r = FileRecord(dir: .incoming, key: f.key, name: FileFlow.name(f.name, timeSec: now), size: f.size,
                           state: "pending", created: now)
        if f.expires <= now {
            // already past expires on arrival (local clock): only the row, never a download
            r.state = "failed"
            r.code = FileRules.FinalCode.expired.rawValue
            r.error = "Expired"
        }
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

    /// A download task starts for `id`: one task per file, so only a file waiting for a download
    /// (pending; failed only for the button) starts. false: not waiting, or the automatic attempts
    /// are used up (the row then shows "Download failed"). `manual`: the Download button, which
    /// always starts; the file keeps that mark for its later automatic tries.
    public func fileDownloadStarts(_ id: Int64, task: String, manual: Bool = false) throws -> Bool {
        try store.db.write {
            guard var f = try store.file(id), f.asReceived,
                  f.state == "pending" || (manual && f.state == "failed") else { return false }
            if manual {
                f.attemptsState = FileRules.Attempts(used: 0, openAt: -1).start(have: f.have)!
                f.manual = true
            } else if let a = f.attemptsState.start(have: f.have) {
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

    /// The headers of one GET of a received file's URL (PA-DL1), signed now with this device's
    /// keys; nil when the URL has no path or the device has no peer id (or cannot sign).
    public func fileDownloadHeaders(_ url: URL) -> [String: String]? {
        guard let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath, path.hasPrefix("/"),
              let me = (try? store.me())?.id else { return nil }
        return try? FileSig.downloadHeaders(signer: keys.signer, encPub: keys.decryptor.publicKey, peerId: me,
                                            timeMs: api.workerNowMs, path: path)
    }

    /// The download task of `id` ended (see Store.fileTaskEnded).
    public func fileTaskEnded(_ id: Int64, task: String, status: Int, body: Data?, blobArrived: Bool, received: Int64 = 0,
                              resumable: Bool = false) throws {
        try store.fileTaskEnded(id, task: task, status: status, body: body, blobArrived: blobArrived, received: received,
                                resumable: resumable)
    }

    /// App only: checks an arrived blob (HTTP status first, then size and sha256) and moves
    /// the record on. `dir`: the files directory.
    @discardableResult
    public func fileCheck(_ id: Int64, dir: URL) throws -> FileFlow.DownloadNext? {
        guard var f = try store.file(id), f.asReceived, let ref = f.ref, ["blob", "pending"].contains(f.state),
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
                                          blobSHA: sha, ref: ref, again: f.again, nowSec: fileNowSec,
                                          skewFirst: f.state == "pending" && f.tries == 1)
        switch next {
        case .ready:
            f.state = "ready"
        case .again:
            try? FileManager.default.removeItem(at: blob)
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f.resumeName))
            f.again = true
            f.have = 0
            f.state = "pending"
        case .retry, .signAgain:
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
        /// The decrypt could not run (not enough storage, or a file system error): the row
        /// shows the text with a Decrypt button; it is not tried again by itself.
        case failed(String)
        /// `cancelled` stopped it: the file stays ready and is decrypted later.
        case cancelled
    }

    /// Decrypts a ready file into `dir`/<in-id>/<name>. `freeMemory` nil = unknown. The mark is
    /// set before the decrypt and cleared after it, whatever the result; `manual` (the
    /// Decrypt button) skips the memory check. `cancelled` is asked before each chunk.
    public func fileDecrypt(_ id: Int64, dir: URL, freeMemory: Int64?, manual: Bool,
                            cancelled: () -> Bool = { false }) throws -> DecryptResult {
        guard var f = try store.file(id), f.asReceived, f.state == "ready", let key = B64URL.decode(f.key) else { return .damaged }
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
            try FileCrypto.decrypt(input: blob, output: out, key: key, cancelled: cancelled)
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
        } catch FileCrypto.Failure.cancelled {
            // an orderly stop: the file stays ready, with no error
            result = .cancelled
        } catch {
            // not a verdict on the file (a full disk or another file system error): the blob
            // stays, and the row shows the error with a Decrypt button
            let free = (try? FileManager.default.attributesOfFileSystem(forPath: dir.path))?[.systemFreeSize] as? NSNumber
            if let fr = free, fr.int64Value < f.size {
                f.code = FileRules.FinalCode.storage.rawValue
                f.error = FileRules.storageFullText(upload: false, name: f.name)
            } else {
                f.code = FileRules.FinalCode.failed.rawValue
                f.error = FileUi.openFailed(f.name)
            }
            result = .failed(f.error ?? FileUi.openFailed(f.name))
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
    /// `progress` gets the file bytes read so far and the file size after each encrypted chunk.
    public func fileSendPrepare(input: URL, rawName: String, to recipients: [PeerId], allCount: Int, dir: URL,
                                free: Int64?, cancelled: () -> Bool = { false },
                                progress: (_ read: Int64, _ total: Int64) -> Void = { _, _ in }) throws -> FileRecord {
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
            try FileCrypto.encrypt(input: input, output: blob, key: key, cancelled: cancelled, progress: { progress($0, size) })
            guard let sha = FileHash.of(file: blob) else { throw FileSendError.unreadable }
            f.sha256 = sha
            try store.saveFile(f)
        } catch {
            try? FileManager.default.removeItem(at: blob)
            try? store.db.exec("DELETE FROM files WHERE id = ?", [.int(f.id)])
            if error as? FileCrypto.Failure == .cancelled { throw FileSendError.cancelled }
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
    public func fileUploadEnded(_ id: Int64, status: Int, body: Data?, epoch: String?, task: String? = nil) throws -> FileFlow.UploadNext? {
        if let e = epoch, let sec = Int64(e), (1 ... APIClient.maxEpochS).contains(sec) { api.setOffset(sec - api.clockMs() / 1000) }
        if status == 426 { NotificationCenter.default.post(name: APIClient.upgradeRequired, object: api) }
        let j = body.flatMap { $0.count <= 4096 ? try? StrictJSON.parse($0) : nil }
        if status == 401 && j?["error"]?.stringValue == "logged out" {
            try? store.setMe("logged_out", .int(1))
            wipeFiles()
            return nil
        }
        return try store.db.write { () -> FileFlow.UploadNext? in
            // only the reply of the send's current try counts
            guard var f = try store.file(id), f.dir == .outgoing, f.state == "uploading", task == nil || f.task == task else { return nil }
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
    /// on a later try of the same send). On success the outgoing row is written; when a device got
    /// it, the blob waits for its decrypt into the row's local copy as a downloaded received file
    /// does (after the result is reported), else the blob goes. A send whose file expired fails.
    public func fileSendMessage(_ id: Int64, dir: URL) async throws -> SendReport {
        // one sender only: the send is claimed (uploaded -> sending) in one transaction, so a second
        // caller (app open, a session event) finds it taken and sends nothing
        let claimed = try store.db.write { () -> FileRecord? in
            guard var g = try store.file(id), g.dir == .outgoing, g.state == "uploaded" else { return nil }
            g.state = "sending"
            try store.saveFile(g)
            return g
        }
        guard var f = claimed, let ref = f.ref, let msgId = f.msgId else { throw FileSendError.unreadable }
        if fileNowSec >= ref.expires {
            f.state = "failed"
            f.code = FileRules.FinalCode.expired.rawValue
            f.error = "Expired"
            try store.saveFile(f)
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f.blobName))
            throw FileSendError.unreadable
        }
        let ids = f.recipients.compactMap { PeerId(text: $0) }
        let rep: SendReport
        do {
            rep = try await sendContent(.file(ref), rowType: "file", rowContent: f.name, msgId: msgId, to: ids,
                                        allCount: f.allCount)
        } catch {
            // nothing was relayed: the next try uses the same upload
            f.state = "uploaded"
            try? store.saveFile(f)
            throw error
        }
        f.historyRowid = rep.rowid
        f.state = rep.sent > 0 && rep.rowid != nil ? "ready" : "sent"
        try store.saveFile(f)
        if f.state == "sent" { try? FileManager.default.removeItem(at: dir.appendingPathComponent(f.blobName)) }
        return rep
    }

    /// App launch: a send left "sending" by a process that ended during it may have been relayed;
    /// it is never sent again, so it fails.
    public func settleSends(except busy: Set<Int64> = []) throws {
        try store.db.write {
            for var f in try store.files(dir: .outgoing, states: ["sending"]) where !busy.contains(f.id) {
                f.state = "failed"
                f.code = FileRules.FinalCode.failed.rawValue
                try store.saveFile(f)
            }
        }
    }

    /// The task keys of every running transfer.
    public func fileTaskKeys() -> [String] { ((try? store.allFiles()) ?? []).compactMap { $0.task } }

    /// Logout and removal: every received and sent file goes (records, blobs, decrypted files),
    /// and the platform cancels their transfers.
    public func wipeFiles() {
        let tasks = fileTaskKeys()
        try? store.db.exec("DELETE FROM files")
        hooks?.wipeFiles(tasks: tasks)
    }

    /// A send that cannot finish (its upload failed or the app gave up): its blob goes.
    public func fileSendFailed(_ id: Int64, dir: URL, code: FileRules.FinalCode, text: String?) throws {
        guard var f = try store.file(id), f.dir == .outgoing, f.historyRowid == nil, f.state != "sent", f.state != "sending" else { return }
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
        for n in names where !keep.contains(n) && !n.hasPrefix(".") && !n.hasPrefix(FileRecord.heldPrefix)
            && !n.hasPrefix(FileRecord.claimedPrefix) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }
}
