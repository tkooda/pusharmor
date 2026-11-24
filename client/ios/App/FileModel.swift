import SwiftUI
import UIKit
import PushArmorCore

/// Whether the app is in front, read from the transfer queues (a send result there is a toast,
/// else a local notification).
final class AppFront: @unchecked Sendable {
    static let shared = AppFront()
    private let lock = NSLock()
    private var value = false

    var on: Bool {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

/// A flag read and set from any thread.
final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool

    init(_ v: Bool) { value = v }

    var on: Bool {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

/// File ids read and changed from any thread.
final class LockedIds: @unchecked Sendable {
    private let lock = NSLock()
    private var ids = Set<Int64>()

    func insert(_ id: Int64) { lock.lock(); ids.insert(id); lock.unlock() }
    func contains(_ id: Int64) -> Bool { lock.lock(); defer { lock.unlock() }; return ids.contains(id) }
}

/// The file rows, the Download and Decrypt buttons, the decrypt while History shows, the
/// storage limit, and a file send from the Send screen.
extension AppModel {
    var filesDir: URL { FileTransfers.shared.dir }

    /// History shows: a running decrypt stops when it goes.
    static let historyShown = LockedFlag(false)
    /// File sends whose popup was closed: their result is a notification.
    static let leftSends = LockedIds()

    /// Once per process: transfer progress, state changes, and send results reach the screens.
    func wireFiles() {
        let t = FileTransfers.shared
        t.onChange = { [weak self] in Task { @MainActor in self?.reload(); self?.decryptDue() } }
        t.onProgress = { [weak self] id, done, _ in
            Task { @MainActor in
                guard let self = self else { return }
                // whole percents only, so the rows do not redraw for every packet
                let size = (self.files.values.first { $0.id == id } ?? self.pendingSends.first { $0.id == id })?.size ?? 0
                let total = size + Int64(FileCrypto.overhead)
                let old = self.fileBytes[id] ?? -1
                if total <= 0 || old < 0 || done * 100 / total != old * 100 / total { self.fileBytes[id] = done }
            }
        }
        t.onSendResult = { [weak self] id, o in
            guard AppFront.shared.on, !AppModel.leftSends.contains(id) else { return false }
            Task { @MainActor in
                guard let self = self else { return }
                switch o {
                case .sent(let rep):
                    self.toast = rep.toast
                    self.toastIsSuccess = rep.allSent
                case .failed(let text):
                    self.toast = text
                }
                self.fileBytes[id] = nil
                self.reload()
            }
            return true
        }
    }

    /// Reloads the file records (part of reload()).
    func loadFiles() {
        // a row gone by a synced delete or by the History age limit takes its file off this device
        let orphan = "SELECT 1 AS x FROM files WHERE history_rowid IS NOT NULL AND history_rowid NOT IN (SELECT rowid FROM history) LIMIT 1"
        if let core = core, (try? store?.db.one(orphan)) != nil { try? core.pruneFiles(dir: filesDir) }
        let all = (try? store?.allFiles()) ?? []
        var byRow: [Int64: FileRecord] = [:]
        for f in all { if let r = f.historyRowid { byRow[r] = f } }
        files = byRow
        pendingSends = all.filter(FileUi.pendingSend).sorted { $0.id > $1.id }
    }

    func plainURL(_ f: FileRecord) -> URL {
        filesDir.appendingPathComponent(f.plainDirName, isDirectory: true).appendingPathComponent(f.name)
    }

    func fileStatus(_ f: FileRecord) -> FileUi.Status {
        let plain = f.state == "done" && FileManager.default.fileExists(atPath: plainURL(f).path)
        return FileUi.status(f, plainThere: plain, received: fileBytes[f.id], nowSec: Int64(Date().timeIntervalSince1970))
    }

    /// The Download button: always starts (the storage check still applies).
    func downloadFile(_ f: FileRecord) {
        guard let core = core else { return }
        let id = f.id
        Task.detached {
            if var g = try? core.store.file(id), g.state == "done" {
                // the decrypted file is gone from this device: a new download
                g.state = "failed"
                g.code = FileRules.FinalCode.failed.rawValue
                try? core.store.saveFile(g)
            }
            let err = FileTransfers.shared.download(id, core: core)
            await MainActor.run {
                if let e = err { self.toast = e }
                self.reload()
            }
        }
    }

    /// The History tab shows or goes: decrypts run only while it shows.
    func setHistoryVisible(_ on: Bool) {
        historyVisible = on
        AppModel.historyShown.on = on
        if on { decryptDue() }
    }

    /// Decrypts every checked file, one at a time, while History shows with the app in front
    /// (never during a share or on the Send tab). A short free memory skips with the row error and a toast.
    func decryptDue() {
        guard historyVisible, UIApplication.shared.applicationState == .active, !decryptRunning, let next = files.values.sorted(by: { $0.id < $1.id })
            .first(where: { $0.dir == .incoming && $0.state == "ready" && $0.code == nil && $0.decryptMark == nil && !decryptSkip.contains($0.id) })
        else { return }
        decrypt(next, manual: false)
    }

    /// The Decrypt button: no memory check; it still marks and catches.
    func decryptNow(_ f: FileRecord) {
        decryptSkip.remove(f.id)
        decrypt(f, manual: true)
    }

    private func decrypt(_ f: FileRecord, manual: Bool) {
        guard let core = core, !decryptRunning else { return }
        decryptRunning = true
        // the download's byte count goes; the decrypt reports its own
        fileBytes[f.id] = nil
        let dir = filesDir, id = f.id, name = f.name, size = f.size
        let progress = FileTransfers.shared.onProgress
        // the decrypt finishes even if the app goes to the background now, so the mark is cleared
        let bg = UIApplication.shared.beginBackgroundTask(withName: "decrypt")
        Task.detached {
            let r: Core.DecryptResult?
            // asked before each 64 KiB chunk: the row's bar moves per whole percent, and leaving
            // History stops the decrypt
            var done: Int64 = 0
            var shown: Int64 = -1
            do {
                r = try core.fileDecrypt(id, dir: dir, freeMemory: FileTransfers.freeMemory(), manual: manual) {
                    let p = done * 100 / max(size, 1)
                    if p != shown { shown = p; progress?(id, done, size) }
                    done += 65_536
                    return !AppModel.historyShown.on
                }
            } catch {
                r = nil
            }
            switch r {
            case .again?: FileTransfers.shared.startDownload(id, core: core, manual: false)
            case .done?:
                let total = (try? dir.resourceValues(forKeys: [.volumeTotalCapacityKey]))?.volumeTotalCapacity.map { Int64($0) }
                try? core.fileEnforceLimit(dir: dir, limit: core.fileStorageLimit(total: total))
            default: break
            }
            await MainActor.run {
                self.decryptRunning = false
                self.fileBytes[id] = nil
                switch r {
                case .noMemory?: self.toast = FileUi.noMemoryToast(name)
                case nil:
                    // the store could not record the failure: no automatic try again
                    self.decryptSkip.insert(id)
                    self.toast = FileUi.openFailed
                default: break
                }
                self.reload()
                UIApplication.shared.endBackgroundTask(bg)
                if r != .noMemory { self.decryptDue() }
            }
        }
    }

    /// Bytes of the device's storage, nil when unknown.
    var deviceTotalBytes: Int64? {
        (try? filesDir.deletingLastPathComponent().resourceValues(forKeys: [.volumeTotalCapacityKey]))?.volumeTotalCapacity.map { Int64($0) }
    }

    // MARK: settings

    func filePicker(_ key: String) -> Int64 { FileUi.picker((try? store?.setting(key)) ?? nil) }

    func setFilePicker(_ key: String, _ v: Int64) {
        do { try store?.setSetting(key, String(v)) } catch { toast = ErrorCopy.text(.changeSetting, ErrorCopy.reason(local: error)) }
        objectWillChange.send()
        // a larger picker may let a waiting file start now
        if let core = core { Task.detached { FileTransfers.shared.catchUp(core: core) } }
    }

    var fileStorage: Int64 { FileUi.storageLimit(saved: (try? store?.setting(FileSettingKey.storage)) ?? nil, total: deviceTotalBytes) }

    /// A smaller limit removes the oldest files at once.
    func setFileStorage(_ v: Int64) {
        do { try store?.setSetting(FileSettingKey.storage, String(v)) } catch { toast = ErrorCopy.text(.changeSetting, ErrorCopy.reason(local: error)) }
        try? core?.fileEnforceLimit(dir: filesDir, limit: v)
        reload()
    }

    // MARK: send

    /// A file send from the Send screen: encrypts and uploads with the send popup over the screen;
    /// the result comes back as the toast (or, with the app closed, a notification). True when
    /// the upload started, so the chosen file clears.
    func sendFile(_ url: URL, name: String, scoped: Bool, toAll: Bool, peerIds: [String]) async -> Bool {
        guard let core = core, !busy.contains("send") else { return false }
        busy.insert("send")
        let all = allSet
        let ids = toAll ? all.map { $0.id } : peerIds.compactMap { PeerId(text: $0) }
        sendStep = 10
        sendRetry = 0
        let r: Result<Int64, Error> = await Task.detached {
            let open = scoped && url.startAccessingSecurityScopedResource()
            defer { if open { url.stopAccessingSecurityScopedResource() } }
            do { return .success(try FileTransfers.shared.send(input: url, name: name, to: ids, allCount: all.count, core: core)) } catch {
                return .failure(error)
            }
        }.value
        switch r {
        case .success(let id):
            sendingFile = id
            sendStep = SendProgress.encrypted
            reload()
            return true
        case .failure(let e):
            busy.remove("send")
            switch e as? Core.FileSendError {
            case .tooLarge?: toast = FileUi.tooLarge(name)
            case .storage(let t)?: toast = t
            default: toast = FileUi.unreadable(name)
            }
            return false
        }
    }

    /// Close on the send popup of a file send: the upload goes on in the background, its row
    /// stays in History until sent, and its result comes as a notification.
    func leaveFileSend() {
        guard let id = sendingFile else { return }
        AppModel.leftSends.insert(id)
        sendingFile = nil
        busy.remove("send")
    }

    /// The send popup of a file send: upload progress, then gone with the result.
    func fileSendProgress() {
        guard let id = sendingFile else { return }
        if let f = pendingSends.first(where: { $0.id == id }) {
            let total = f.size + Int64(FileCrypto.overhead)
            if f.state == "uploading", let b = fileBytes[id], total > 0 { sendStep = SendProgress.encrypted + Int(min(b * 70 / total, 70)) }
            if f.state == "uploaded" || f.state == "sending" { sendStep = 95 }
            if f.state != "failed" { return }
        }
        // sent (in History now) or failed: the result toast says which
        sendingFile = nil
        busy.remove("send")
    }

    /// A failed send not in History: the user removes its row.
    func removePendingSend(_ f: FileRecord) {
        try? store?.db.exec("DELETE FROM files WHERE id = ?", [.int(f.id)])
        try? FileManager.default.removeItem(at: filesDir.appendingPathComponent(f.blobName))
        reload()
    }
}
