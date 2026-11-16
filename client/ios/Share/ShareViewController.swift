import UIKit
import SwiftUI
import UniformTypeIdentifiers
import PushArmorCore

/// Share extension (ios 8.2): send a shared URL, text or phone number.
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

    func close() { context?.completeRequest(returningItems: nil) }

    /// The result (sent or failed) is on screen.
    var finished: Bool {
        switch step {
        case .done, .failed: return true
        default: return false
        }
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
                ToolbarItem(placement: .cancellationAction) { Button(model.finished ? "Done" : "Cancel") { model.close() } }
            }
        }
    }
}
