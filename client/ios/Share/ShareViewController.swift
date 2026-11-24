import UIKit
import SwiftUI
import UniformTypeIdentifiers
import PushArmorCore

/// Share extension (ios 8.2): send a shared URL, text, phone number, or file.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load() }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Step: Equatable { case loading, pick, tooLong, done(String), failed(String), update }

    @Published var step: Step = .loading
    @Published var text = ""
    @Published var all: [Peer] = []
    @Published var showAll = true
    private(set) var type: SendType = .text
    private weak var context: NSExtensionContext?
    private var core: Core?
    private var sending = false
    /// The send popup: shown while the send is on its way, with its caption, device names, progress
    /// (25, 50, 75, 100), and try number (2 or 3 when trying again), as on the Send screen.
    @Published var popup = false
    @Published var sendCaption = ""
    @Published var sendNames: [String] = []
    @Published var sendStep = 0
    @Published var sendRetry = 0
    /// A shared file (a temporary copy) and its name; nil for text.
    private var file: (url: URL, name: String)?
    /// A file upload runs: closing the sheet now leaves it to finish in the background.
    @Published var uploading = false
    /// The sheet is still open: a send result shows here, else as a notification.
    private let shown = ShownFlag()

    init(context: NSExtensionContext?) { self.context = context }

    func load() async {
        let env = AppEnvironment.shared
        // This version got HTTP 426: the update message, never a send that fails.
        if env.updateRequired { step = .update; return }
        // Data that does not open is not a log out: it says why the data failed.
        let store: Store, me: Me
        do {
            store = try env.openStore()
            me = try store.me()
        } catch {
            step = .failed(S.shareDataFailed(error))
            return
        }
        // Logged out keeps the id and keys: it must not offer a send that cannot go through.
        guard me.id != nil, !me.loggedOut, !me.removed else {
            step = .failed(S.shareLoggedOut)
            return
        }
        // Keys that do not load (for example before the first unlock) are not a log out either.
        guard let keys = try? env.keychain.load() else {
            step = .failed(S.shareKeysUnusable)
            return
        }
        core = env.makeCore(store: store, keys: keys)
        all = (try? core!.allSet()) ?? []
        showAll = (try? store.boolSetting(SettingKey.showAll, default: true)) ?? true
        if let f = await sharedFile() {
            switch f {
            case .success(let v): file = v
            case .failure(let e):
                step = .failed(e.text)
                return
            }
            await route()
            return
        }
        guard let shared = await sharedContent() else { step = .failed(S.shareNothing); return }
        text = shared.0
        type = shared.1
        if SizeCap.isOver(text) {
            // text, URL, or phone number over cap: an editable box with the counter, and Send greyed until it fits
            step = .tooLong
            return
        }
        await route()
    }

    /// Send on the too-long step, once the edited text fits: how it goes is found again from the new text.
    func sendEdited() async {
        guard !SizeCap.isOver(text) else { return }
        type = SendDetection.detect(text)
        await route()
    }

    /// One other approved peer in the All set: send at once; else a picker (All + peers).
    func route() async {
        if all.count == 1 {
            await send(to: all.map { $0.id })
        } else if all.isEmpty {
            step = .failed(S.shareNoPeers)
        } else {
            step = .pick
        }
    }

    func send(to ids: [PeerId]) async {
        if let f = file { return await sendFile(f, to: ids) }
        // One send per share: a second tap while the first is on its way does nothing.
        guard let core = core, !sending else { return }
        sending = true
        let text = self.text, type = self.type, allCount = all.count
        let chosen = all.filter { ids.contains($0.id) }
        sendNames = PeerLabel.sorted(chosen).map { PeerLabel.label($0) }
        sendCaption = sendNames.count > 1 ? S.sendingHeader(type) : S.sending(type, to: sendNames)
        sendStep = 0
        sendRetry = 0
        popup = true
        do {
            let rep = try await SendProgress.$step.withValue({ s in
                _ = Task { @MainActor in if s > self.sendStep { self.sendStep = s } }
            }) {
                try await SendProgress.$retry.withValue({ a in
                    _ = Task { @MainActor in self.sendRetry = a }
                }) {
                    try await core.send(text, as: type, to: ids, allCount: allCount)
                }
            }
            popup = false
            // A device that did not get the message keeps the result on screen too.
            guard rep.allSent else { step = .failed(rep.toast); return }
            step = .done(rep.toast)
        } catch {
            popup = false
            if AppEnvironment.shared.updateRequired { step = .update; return }
            // A failure stays on screen until the user taps Done.
            step = .failed(ErrorCopy.sendFailText(error))
            return
        }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        close()
    }

    /// A file: encrypted into the App Group container and uploaded on a background session, with
    /// the popup's bar on the upload. The sheet stays open until the file message is sent; closed
    /// early, the upload goes on and a notification gives the result (History shows the send
    /// until then).
    private func sendFile(_ f: (url: URL, name: String), to ids: [PeerId]) async {
        guard let core = core, !sending else { return }
        sending = true
        let allCount = all.count
        let chosen = all.filter { ids.contains($0.id) }
        sendNames = PeerLabel.sorted(chosen).map { PeerLabel.label($0) }
        sendCaption = FileUi.sending(to: sendNames)
        sendStep = 0
        sendRetry = 0
        popup = true
        let t = FileTransfers.shared
        let shown = self.shown
        t.onProgress = { [weak self] _, done, total in
            Task { @MainActor in
                guard let self = self, total > 0 else { return }
                self.sendStep = max(self.sendStep, SendProgress.encrypted + Int(min(done * 70 / total, 70)))
            }
        }
        t.onSendResult = { [weak self] _, o in
            guard shown.on else { return false }
            Task { @MainActor in self?.fileResult(o) }
            return true
        }
        let r: Result<Int64, Error> = await Task.detached {
            do { return .success(try t.send(input: f.url, name: f.name, to: ids, allCount: allCount, core: core)) } catch {
                return .failure(error)
            }
        }.value
        // the blob is in the App Group container now: the shared copy goes
        try? FileManager.default.removeItem(at: f.url.deletingLastPathComponent())
        switch r {
        case .success:
            sendStep = SendProgress.encrypted
            uploading = true
        case .failure(let e):
            popup = false
            switch e as? Core.FileSendError {
            case .tooLarge?: step = .failed(FileUi.tooLarge(f.name))
            case .storage(let text)?: step = .failed(text)
            default: step = .failed(FileUi.unreadable(f.name))
            }
        }
    }

    private func fileResult(_ o: FileTransfers.SendOutcome) {
        popup = false
        uploading = false
        switch o {
        case .sent(let rep):
            guard rep.allSent else { step = .failed(rep.toast); return }
            step = .done(rep.toast)
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                close()
            }
        case .failed(let text):
            step = .failed(text)
        }
    }

    func close() {
        // a running upload goes on; its result is a notification from now on
        shown.on = false
        context?.completeRequest(returningItems: nil)
    }

    /// The result (sent or failed) is on screen.
    var finished: Bool {
        switch step {
        case .done, .failed: return true
        default: return false
        }
    }

    enum FileLoadError: Error {
        case tooLarge(String)
        case unreadable(String)
        var text: String {
            switch self {
            case .tooLarge(let n): return FileUi.tooLarge(n)
            case .unreadable(let n): return FileUi.unreadable(n)
            }
        }
    }

    /// The first shared file (a photo, a video, or any file; activation rule: one of them), copied
    /// to a temporary file; nil when the share is a web URL or text. Its name gets an extension
    /// from its type when it has none; a file over the size limit is refused here.
    func sharedFile() async -> Result<(url: URL, name: String), FileLoadError>? {
        let items = (context?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        // a web URL (a shared page) is sent as its URL
        if providers.contains(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) && !$0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
        }) { return nil }
        for p in providers {
            let file = p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            guard let type = p.registeredTypeIdentifiers.compactMap({ UTType($0) })
                .first(where: { $0.conforms(to: .data) && (file || !$0.conforms(to: .text)) }) else { continue }
            var raw = p.suggestedName ?? ""
            let copied: URL? = await withCheckedContinuation { c in
                _ = p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                    // the file at `url` is gone when this returns: copy it now
                    guard let u = url else { return c.resume(returning: nil) }
                    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share-" + UUID().uuidString, isDirectory: true)
                    let out = dir.appendingPathComponent(u.lastPathComponent)
                    do {
                        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                        try FileManager.default.copyItem(at: u, to: out)
                        c.resume(returning: out)
                    } catch {
                        c.resume(returning: nil)
                    }
                }
            }
            if raw.isEmpty { raw = copied?.lastPathComponent ?? "" }
            if FileUi.ext(raw).isEmpty, let e = type.preferredFilenameExtension { raw += "." + e }
            let name = FileFlow.name(raw, timeSec: Int64(Date().timeIntervalSince1970))
            guard let u = copied, let size = (try? u.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else {
                return .failure(.unreadable(name))
            }
            guard Int64(size) <= FileRules.maxFile else {
                try? FileManager.default.removeItem(at: u.deletingLastPathComponent())
                return .failure(.tooLarge(name))
            }
            return .success((url: u, name: name))
        }
        return nil
    }

    /// The first web URL, else the first text item (activation rule: one web URL or text).
    func sharedContent() async -> (String, SendType)? {
        let items = (context?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                let s = u.absoluteString
                if u.scheme?.lowercased() == "tel" { return (s, PhoneDetection.isPhone(s) ? .tel : .text) }
                return (s, URLRule.parse(s) != nil ? .url : .text)
            }
        }
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let s = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                return (s, SendDetection.detect(s))
            }
        }
        return nil
    }
}

/// Read from the transfer queues: whether the sheet still shows.
final class ShownFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true

    var on: Bool {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel

    /// The shared text in an editable box with the Send screen's counter; Send stays greyed until it fits.
    private var tooLong: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $model.text)
                .scrollContentBackground(.hidden)
                .accessibilityLabel("Message")
                .padding(4)
                .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color(uiColor: .separator), lineWidth: 1)
                )
            if SizeCap.isWarning(model.text) {
                Text(SizeCap.label(model.text))
                    .font(.footnote)
                    .foregroundColor(.errorText)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            Button {
                Task { await model.sendEdited() }
            } label: {
                Label("Send", systemImage: "paperplane.fill")
            }
            .buttonStyle(GreenButtonStyle())
            .disabled(SizeCap.isOver(model.text) || model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .padding(.top, 6)
        }
        .padding()
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.step {
                case .loading:
                    ProgressView()
                case .tooLong:
                    tooLong
                case .pick:
                    List {
                        if model.showAll {
                            Button("All") { Task { await model.send(to: model.all.map { $0.id }) } }
                        }
                        ForEach(model.all, id: \.id.text) { p in
                            Button(PeerLabel.label(p)) { Task { await model.send(to: [p.id]) } }
                        }
                    }
                case .done(let msg), .failed(let msg):
                    Text(msg).padding()
                case .update:
                    VStack(spacing: 12) {
                        Text(S.updateTitle).font(.headline)
                        Text(S.updateBody).multilineTextAlignment(.center)
                    }
                    .padding()
                }
            }
            // Over the screen while the send is on its way, as on the Send screen.
            .overlay {
                if model.popup {
                    SendPopup(caption: model.sendCaption, names: model.sendNames, step: model.sendStep, retry: model.sendRetry)
                }
            }
            .navigationTitle(S.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Nothing is left to cancel once the result shows.
                // A file upload goes on after Close (its result is a notification).
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.finished ? "Done" : (model.uploading ? "Close" : "Cancel")) { model.close() }
                }
            }
        }
    }
}
