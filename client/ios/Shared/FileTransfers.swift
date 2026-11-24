import Foundation
import Network
import os
import UserNotifications
import PushArmorCore

/// File transfers on background URLSessions, shared by the app, the NSE and the share extension.
/// Every process uses its own session identifiers: the NSE one per file, the share extension one
/// per send, the app one for downloads and one for uploads. The app attaches to another
/// identifier only when the system launches it for that session's events, or to cancel an NSE
/// download it takes over. Blobs live in the App Group container (files/); the app alone checks
/// them and decrypts. FileFlow and the files table decide every step.
final class FileTransfers: NSObject, URLSessionDownloadDelegate, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = FileTransfers()

    enum Role { case app, nse, share }

    /// Which process this is, from the extension point in Info.plist.
    let role: Role = {
        let point = (Bundle.main.object(forInfoDictionaryKey: "NSExtension") as? [String: Any])?["NSExtensionPointIdentifier"] as? String
        switch point {
        case "com.apple.usernotifications.service"?: return .nse
        case "com.apple.share-services"?: return .share
        default: return .app
        }
    }()

    enum SendOutcome {
        case sent(SendReport)
        case failed(String)
    }

    /// A screen that shows a send (the share sheet while open): gets the result and returns true;
    /// with no screen the result is a local notification.
    var onSendResult: ((Int64, SendOutcome) -> Bool)?
    /// Bytes sent or received of a file transfer (file id, done, total).
    var onProgress: ((Int64, Int64, Int64) -> Void)?
    /// App: a received file changed state (the History rows reload).
    var onChange: (() -> Void)?

    private let env = AppEnvironment.shared
    private let lock = NSLock()
    private var sessions: [String: URLSession] = [:]
    private var completions: [String: () -> Void] = [:]
    private var replies: [String: Data] = [:]
    private var ended = Set<String>()
    private var pathMonitor: NWPathMonitor?

    var dir: URL { env.containerURL.appendingPathComponent("files", isDirectory: true) }

    // MARK: session identifiers

    func nseSessionId(_ id: Int64) -> String { env.appGroup + ".nse." + String(id) }
    func shareSessionId(_ id: Int64) -> String { env.appGroup + ".share." + String(id) }
    var appDownloadId: String { env.appGroup + ".app.dl" }
    var appUploadId: String { env.appGroup + ".app.ul" }

    func session(_ id: String) -> URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let s = sessions[id] { return s }
        let c = URLSessionConfiguration.background(withIdentifier: id)
        c.sharedContainerIdentifier = env.appGroup
        c.timeoutIntervalForResource = FileRules.resourceTimeout
        c.sessionSendsLaunchEvents = true
        c.isDiscretionary = false
        let s = URLSession(configuration: c, delegate: self, delegateQueue: nil)
        sessions[id] = s
        return s
    }

    /// App: the system launched the app for the events of this session.
    func attach(_ identifier: String, completion: @escaping () -> Void) {
        lock.lock()
        completions[identifier] = completion
        lock.unlock()
        _ = session(identifier)
    }

    @discardableResult
    private func withCore<T>(_ body: (Core) throws -> T) -> T? {
        guard let store = try? env.openStore(), let keys = try? env.keychain.load() else { return nil }
        return try? body(env.makeCore(store: store, keys: keys))
    }

    private static func taskKey(_ s: URLSession, _ t: URLSessionTask) -> String {
        (s.configuration.identifier ?? "") + " " + String(t.taskIdentifier)
    }

    private func fileId(_ t: URLSessionTask) -> Int64? { t.taskDescription.flatMap { Int64($0) } }

    // MARK: device state

    /// The current network: wifi when not expensive, and whether Low Data Mode is on; nil when offline.
    static func currentNetwork() -> (network: FileRules.Network, lowData: Bool)? {
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var value: (FileRules.Network, Bool)?
            var done = false
        }
        let box = Box()
        let sem = DispatchSemaphore(value: 0)
        let m = NWPathMonitor()
        m.pathUpdateHandler = { p in
            box.lock.lock()
            defer { box.lock.unlock() }
            guard !box.done else { return }
            box.done = true
            if p.status == .satisfied {
                box.value = (p.isExpensive ? FileRules.Network.mobile : FileRules.Network.wifi, p.isConstrained)
            }
            sem.signal()
        }
        m.start(queue: DispatchQueue(label: "pusharmor.path"))
        _ = sem.wait(timeout: .now() + 0.5)
        m.cancel()
        box.lock.lock()
        defer { box.lock.unlock() }
        return box.value.map { (network: $0.0, lowData: $0.1) }
    }

    /// Bytes free for files the user asked for; nil when unknown.
    func freeBytes() -> Int64? {
        (try? env.containerURL.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage
    }

    /// Memory this process may still use; nil when unknown.
    static func freeMemory() -> Int64? {
        let m = os_proc_available_memory()
        return m > 0 ? Int64(m) : nil
    }

    // MARK: app-active stamp

    static let activeKey = "file_app_active_ms"
    /// A stamp older than this is stale (the app was killed while in front).
    static let activeFreshMs: Int64 = 10 * 60 * 1000

    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// App: in front now (set on activation and on each notification shown in front).
    func stampActive() { env.defaults.set(NSNumber(value: Self.nowMs()), forKey: Self.activeKey) }
    func clearActive() { env.defaults.removeObject(forKey: Self.activeKey) }

    var appActiveFresh: Bool {
        guard let n = env.defaults.object(forKey: Self.activeKey) as? NSNumber else { return false }
        let age = Self.nowMs() - n.int64Value
        return age >= 0 && age < Self.activeFreshMs
    }

    // MARK: downloads

    /// NSE: start the download of a file that just arrived, only when the app is not in front and
    /// the picker for the current network allows its size (else catch-up starts it later). Task
    /// creation takes milliseconds; the caller hands over the notification right after.
    func nseStart(_ id: Int64, core: Core) {
        guard !appActiveFresh, let net = Self.currentNetwork() else { return }
        guard let due = try? core.fileCatchUp(network: net.network, lowData: net.lowData, free: freeBytes()),
              due.contains(where: { $0.id == id }) else { return }
        startDownload(id, core: core, manual: false, inApp: false)
    }

    /// Starts (or resumes, with saved resume data) the download of file `id`. `wait`: seconds
    /// before the system begins it.
    func startDownload(_ id: Int64, core: Core, manual: Bool, inApp: Bool = true, wait: Int64? = nil) {
        guard let f = try? core.store.file(id), let ref = f.ref else { return }
        guard FileRules.fileURLOK(ref.url), let url = URL(string: ref.url) else {
            var g = f
            g.state = "failed"
            g.code = FileRules.FinalCode.damaged.rawValue
            g.error = FileRules.fileDamaged
            try? core.store.saveFile(g)
            return
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let sid = inApp ? appDownloadId : nseSessionId(id)
        let s = session(sid)
        let resume = dir.appendingPathComponent(f.resumeName)
        let task: URLSessionDownloadTask
        if let d = try? Data(contentsOf: resume) {
            try? FileManager.default.removeItem(at: resume)
            task = s.downloadTask(withResumeData: d)
        } else {
            var req = URLRequest(url: url)
            let p = core.filePickers()
            req.allowsCellularAccess = manual || FileRules.autoDownload(picker: p.mobile, size: f.size)
            // the NSE cannot see Low Data Mode later on: its task waits for an unconstrained network
            req.allowsConstrainedNetworkAccess = inApp
            task = s.downloadTask(with: req)
        }
        task.taskDescription = String(id)
        if let w = wait, w > 0 { task.earliestBeginDate = Date(timeIntervalSinceNow: Double(min(w, 3600))) }
        guard (try? core.fileDownloadStarts(id, task: Self.taskKey(s, task), have: 0, manual: manual)) == true else {
            task.cancel()
            return
        }
        task.resume()
    }

    /// App open, open from a notification, or a change to an unmetered network: NSE downloads still
    /// running are taken over (cancelled with resume data, then run here with progress), arrived
    /// blobs are checked, and every pending file the picker allows starts.
    func catchUp(core: Core) {
        takeOverNSE(core: core)
        for f in (try? core.store.files(dir: .incoming, states: ["blob"])) ?? [] { settle(f.id, core: core) }
        guard let net = Self.currentNetwork(),
              let due = try? core.fileCatchUp(network: net.network, lowData: net.lowData, free: freeBytes()) else { return }
        for f in due { startDownload(f.id, core: core, manual: false) }
    }

    /// The Download button: always starts (the storage check still applies).
    func download(_ id: Int64, core: Core) -> String? {
        guard let f = try? core.store.file(id) else { return nil }
        guard FileRules.enoughStorage(free: freeBytes(), size: f.size) else {
            var g = f
            g.state = "failed"
            g.code = FileRules.FinalCode.storage.rawValue
            g.error = FileRules.storageFullText(upload: false, name: f.name)
            try? core.store.saveFile(g)
            return g.error
        }
        startDownload(id, core: core, manual: true)
        return nil
    }

    private func takeOverNSE(core: Core) {
        for f in (try? core.store.files(dir: .incoming, states: ["loading"])) ?? [] {
            guard let t = f.task else { continue }
            let sp = t.split(separator: " ").map(String.init)
            guard sp.count == 2, sp[0] != appDownloadId, let tid = Int(sp[1]) else { continue }
            session(sp[0]).getAllTasks { tasks in
                var found = false
                for task in tasks where task.taskIdentifier == tid {
                    found = true
                    // the completion (any process) saves the resume data; this one starts it in the app
                    (task as? URLSessionDownloadTask)?.cancel(byProducingResumeData: { _ in })
                }
                if !found {
                    // the task is gone (its process ended before it reported): run it here
                    try? core.fileTaskEnded(f.id, status: 0, body: nil, blobArrived: false)
                    self.startDownload(f.id, core: core, manual: false)
                }
            }
        }
    }

    /// App: an ended download is checked; a damaged first blob or an error to retry starts again.
    private func settle(_ id: Int64, core: Core) {
        let next = try? core.fileCheck(id, dir: dir)
        switch next {
        case .again?: startDownload(id, core: core, manual: false)
        case .retry(let w)?:
            let used = (try? core.store.file(id))?.attempts ?? 1
            startDownload(id, core: core, manual: false, wait: w ?? Int64(30 * max(used, 1)))
        case nil:
            // a transport error or a take-over (no reply): try again here
            if let f = try? core.store.file(id), f.state == "pending" { startDownload(id, core: core, manual: false) }
        default: break
        }
        onChange?()
    }

    /// App launch: decrypts the app did not finish show the memory error; records whose History row
    /// is gone lose their files; an app-wide watch starts catch-up on a change to an unmetered network.
    func launch(core: Core) {
        try? core.settleDecryptMarks()
        try? core.pruneFiles(dir: dir)
        guard pathMonitor == nil else { return }
        final class Last: @unchecked Sendable { var metered = false }
        let last = Last()
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] p in
            // the handler runs on its own serial queue
            let unmetered = p.status == .satisfied && !p.isExpensive
            if unmetered && last.metered { self?.withCore { self?.catchUp(core: $0) } }
            last.metered = !unmetered
        }
        m.start(queue: DispatchQueue(label: "pusharmor.files"))
        pathMonitor = m
    }

    /// App open: sends whose upload finished get their file message; sends past the resource
    /// timeout with no result have failed.
    func finishSends(core: Core) {
        for f in (try? core.store.files(dir: .outgoing, states: ["uploaded"])) ?? [] { finishSend(f.id, core: core) }
        let cutoff = core.clock() - Int64(FileRules.resourceTimeout) - 5 * 60
        for f in (try? core.store.files(dir: .outgoing, states: ["uploading"])) ?? [] where f.created < cutoff {
            try? core.fileSendFailed(f.id, dir: dir, code: .failed, text: nil)
            report(f.id, .failed(Self.sendFailedText(f.name)))
        }
    }

    // MARK: uploads

    /// Share sheet: encrypts the file into the App Group container and starts its upload. Throws
    /// Core.FileSendError (too large, no room) before anything is sent.
    func send(input: URL, name: String, to recipients: [PeerId], allCount: Int, core: Core) throws -> Int64 {
        let f = try core.fileSendPrepare(input: input, rawName: name, to: recipients, allCount: allCount, dir: dir,
                                         free: freeBytes())
        startUpload(f.id, core: core)
        return f.id
    }

    /// One upload try, signed now, from the blob file.
    func startUpload(_ id: Int64, core: Core, wait: Int64? = nil) {
        guard let req = try? core.fileUploadTry(id), let f = try? core.store.file(id) else {
            try? core.fileSendFailed(id, dir: dir, code: .failed, text: nil)
            if let f = try? core.store.file(id) { report(id, .failed(Self.sendFailedText(f.name))) }
            return
        }
        var r = URLRequest(url: req.url)
        r.httpMethod = "POST"
        for (k, v) in req.headers { r.setValue(v, forHTTPHeaderField: k) }
        let sid = role == .share ? shareSessionId(id) : appUploadId
        let s = session(sid)
        let task = s.uploadTask(with: r, fromFile: dir.appendingPathComponent(f.blobName))
        task.taskDescription = String(id)
        if let w = wait, w > 0 { task.earliestBeginDate = Date(timeIntervalSinceNow: Double(min(w, 60))) }
        var g = f
        g.task = Self.taskKey(s, task)
        try? core.store.saveFile(g)
        task.resume()
    }

    private func finishSend(_ id: Int64, core: Core) {
        let dir = self.dir
        Task {
            do {
                let rep = try await core.fileSendMessage(id, dir: dir)
                self.report(id, .sent(rep))
            } catch {
                // an expired upload fails; anything else stays uploaded for the next app open
                if let f = try? core.store.file(id), f.state == "failed" { self.report(id, .failed(f.error ?? Self.sendFailedText(f.name))) }
            }
        }
    }

    static func sendFailedText(_ name: String) -> String { "Unable to send \"" + name + "\"" }

    private func report(_ id: Int64, _ o: SendOutcome) {
        if onSendResult?(id, o) == true { return }
        let c = UNMutableNotificationContent()
        c.title = S.title
        switch o {
        case .sent(let rep): c.body = rep.toast
        case .failed(let t): c.body = t
        }
        c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "file-send-" + String(id), content: c, trigger: nil))
    }

    // MARK: URLSession delegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = fileId(downloadTask) else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        let blob = dir.appendingPathComponent("in-" + String(id) + ".blob")
        var body: Data? = nil
        var arrived = false
        if (200 ... 299).contains(status) {
            // the file at `location` is gone when this returns: move it now
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: blob)
            arrived = (try? FileManager.default.moveItem(at: location, to: blob)) != nil
        } else if let a = try? FileManager.default.attributesOfItem(atPath: location.path), let n = a[.size] as? NSNumber,
                  n.int64Value <= 4096 {
            body = try? Data(contentsOf: location)
        }
        lock.lock()
        ended.insert(Self.taskKey(session, downloadTask))
        lock.unlock()
        withCore { core in
            try core.fileTaskEnded(id, status: arrived || !(200 ... 299).contains(status) ? status : 0, body: body,
                                   blobArrived: arrived)
            if role == .app { settle(id, core: core) }
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = fileId(downloadTask) else { return }
        onProgress?(id, totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        guard let id = fileId(task) else { return }
        onProgress?(id, totalBytesSent, totalBytesExpectedToSend)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let k = Self.taskKey(session, dataTask)
        lock.lock()
        var d = replies[k] ?? Data()
        if d.count < 4096 { d.append(data.prefix(4096 - d.count)) }
        replies[k] = d
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = fileId(task) else { return }
        let k = Self.taskKey(session, task)
        lock.lock()
        let reply = replies.removeValue(forKey: k)
        let done = ended.remove(k) != nil
        lock.unlock()
        let http = task.response as? HTTPURLResponse
        if task is URLSessionDownloadTask {
            if done { return }
            if let d = (error as NSError?)?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try? d.write(to: dir.appendingPathComponent("in-" + String(id) + ".resume"))
            }
            withCore { core in
                try core.fileTaskEnded(id, status: 0, body: nil, blobArrived: false)
                if role == .app { settle(id, core: core) }
            }
            return
        }
        let status = error == nil ? (http?.statusCode ?? 0) : 0
        let epoch = http?.value(forHTTPHeaderField: "PA-Epoch")
        withCore { core in
            switch try core.fileUploadEnded(id, status: status, body: reply, epoch: epoch) {
            case .uploaded?: finishSend(id, core: core)
            case .resubmit(let w)?: startUpload(id, core: core, wait: w ?? 1)
            case .final(let c, let t)?:
                let name = (try? core.store.file(id))?.name ?? ""
                try? core.fileSendFailed(id, dir: dir, code: c, text: t)
                report(id, .failed(t ?? (c == .tooLarge ? "\"" + name + "\" is too large to send" : Self.sendFailedText(name))))
            case nil: break
            }
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let id = session.configuration.identifier else { return }
        lock.lock()
        let c = completions.removeValue(forKey: id)
        lock.unlock()
        if let c { DispatchQueue.main.async { c() } }
    }
}
