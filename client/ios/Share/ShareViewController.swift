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
    enum Step: Equatable { case loading, pick, offerTruncate, done(String), failed(String) }

    @Published var step: Step = .loading
    @Published var text = ""
    @Published var all: [Peer] = []
    @Published var showAll = true
    private(set) var type: SendType = .text
    private weak var context: NSExtensionContext?
    private var core: Core?
    private var sending = false

    init(context: NSExtensionContext?) { self.context = context }

    func load() async {
        let env = AppEnvironment.shared
        // Logged out keeps the id and keys: it must not offer a send that cannot go through (I470).
        guard let store = try? env.openStore(), let keys = try? env.keychain.load(), let me = try? store.me(),
              me.id != nil, !me.loggedOut, !me.removed else {
            step = .failed("Open PushArmor and log in first.")
            return
        }
        core = env.makeCore(store: store, keys: keys)
        all = (try? core!.allSet()) ?? []
        showAll = (try? store.boolSetting(SettingKey.showAll, default: true)) ?? true
        guard let shared = await sharedContent() else { step = .failed("Nothing to send."); return }
        text = shared.0
        type = shared.1
        if SizeCap.isOver(text) {
            // URL and tel over cap are refused; text offers the first 2048 bytes
            if type == .text { step = .offerTruncate } else { step = .failed(SizeCap.label(text)) }
            return
        }
        await route()
    }

    func truncate() async {
        text = SizeCap.truncated(text)
        await route()
    }

    /// One other approved peer in the All set: send at once; else a picker (All + peers).
    func route() async {
        if all.count == 1 {
            await send(to: all.map { $0.id })
        } else if all.isEmpty {
            step = .failed("No paired devices to send to.")
        } else {
            step = .pick
        }
    }

    func send(to ids: [PeerId]) async {
        // One send per share (I473): a second tap while the first is on its way does nothing.
        guard let core = core, !sending else { return }
        sending = true
        do {
            let rep = try await core.send(text, as: type, to: ids, allCount: all.count)
            step = .done(rep.toast)
        } catch Core.SendError.clockOff {
            step = .done(S.clockOff)
        } catch {
            step = .done("Not sent, try again")
        }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        close()
    }

    func close() { context?.completeRequest(returningItems: nil) }

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

    var body: some View {
        NavigationStack {
            Group {
                switch model.step {
                case .loading:
                    ProgressView()
                case .offerTruncate:
                    VStack(spacing: 12) {
                        Text(SizeCap.label(model.text))
                        Button(S.tooLongShare) { Task { await model.truncate() } }
                    }
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
                }
            }
            .navigationTitle(S.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.close() } }
            }
        }
    }
}
