import SwiftUI
import PushArmorCore

struct PeersView: View {
    @EnvironmentObject var model: AppModel
    @State private var renaming = false
    @State private var newName = ""
    @State private var pulseId: String?
    @State private var pulseOn = false

    /// Removed peers show only while History still holds rows from them.
    private var visible: [Peer] {
        let withHistory = Set(model.history.compactMap { $0.peerId })
        return model.peers.filter { $0.state != .removed || withHistory.contains($0.id.text) }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    Section {
                        thisDeviceRow
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Button("Refresh") { Task { await model.refresh() } }
                                .disabled(ctx.date < model.refreshGreyUntil)
                        }
                    }
                    Section("Peers") {
                        if visible.isEmpty {
                            Text("No peers yet").foregroundColor(.secondary)
                        }
                        ForEach(visible, id: \.id.text) { p in
                            PeerRowView(p: p)
                                .id(p.id.text)
                                .listRowBackground(pulseId == p.id.text && pulseOn ? Color.accentColor.opacity(0.25) : nil)
                        }
                    }
                }
                .navigationTitle("Peers")
                .onAppear { highlight(proxy) }
                .onChange(of: model.highlightPeer) { _, _ in highlight(proxy) }
            }
        }
    }

    private var thisDeviceRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            if renaming {
                TextField("Name this device", text: $newName)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                HStack {
                    Button("Save") {
                        let n = newName
                        Task {
                            await model.rename(n)
                            renaming = false
                        }
                    }
                    .disabled(!NameEntry.isValidName(newName))
                    Button("Cancel") { renaming = false }
                }
                .buttonStyle(.borderless)
            } else {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.me?.name ?? "This device").font(.headline)
                        Text("this device").font(.caption).foregroundColor(.secondary)
                    }
                    Spacer()
                    Button("Rename") {
                        newName = model.me?.name ?? ""
                        renaming = true
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func highlight(_ proxy: ScrollViewProxy) {
        guard let id = model.highlightPeer else { return }
        model.highlightPeer = nil
        pulseId = id
        withAnimation { proxy.scrollTo(id, anchor: .center) }
        Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            withAnimation(.easeInOut(duration: 0.35)) { pulseOn = true }
            try? await Task.sleep(nanoseconds: 450_000_000)
            withAnimation(.easeInOut(duration: 0.35)) { pulseOn = false }
            try? await Task.sleep(nanoseconds: 400_000_000)
            pulseId = nil
        }
    }
}

struct PeerRowView: View {
    let p: Peer
    @EnvironmentObject var model: AppModel
    @State private var confirmRemove = false

    private var label: String { model.label(p) }
    private var removed: Bool { p.state == .removed }
    private var greyed: Bool { removed || p.missing || !p.reachable }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
                .contentShape(Rectangle())
                .onTapGesture { if greyed { Task { await model.tapGreyed() } } }

            if let e = model.pairings[p.id.text] {
                pairingBlock(e)
            } else if !p.pinned && !removed {
                HStack {
                    Button("Pair") { Task { await model.pair(p) } }
                    Button("Deny") { Task { await model.deny(p) } }
                }
                .buttonStyle(.bordered)
            }

            if p.state == .approved && !p.approveVerified {
                waitingBlock
            }

            if model.offersCancel(p) {
                Button("Cancel pairing") { Task { await model.cancelPairing(p) } }
                    .buttonStyle(.bordered)
            }

            if p.notPairedOnPeer {
                Text(p.declinedByPeer ? S.declinedBy(label) : S.notPairedOn(label))
                    .font(.caption).foregroundColor(.orange)
            }
            if p.note == "failed" {
                Text(S.pairingFailed).font(.caption).foregroundColor(.red)
            } else if p.note == "timedOut" {
                Text(S.pairingTimedOut).font(.caption).foregroundColor(.red)
            }

            if !removed {
                actions
                Toggle(S.lockScreenSwitch, isOn: Binding(
                    get: { p.lockShow },
                    set: { model.setPeerSwitches(p, lockShow: $0) }
                ))
                .disabled(!model.boolSetting(SettingKey.lockShow, true))
                Toggle(S.alwaysHide, isOn: Binding(
                    get: { p.alwaysHide },
                    set: { model.setPeerSwitches(p, alwaysHide: $0) }
                ))
            }
        }
        .padding(.vertical, 4)
        .opacity(removed ? 0.5 : 1)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(removed ? label + " (removed)" : label)
                .font(.headline)
                .foregroundColor(greyed ? .secondary : .primary)
            HStack(spacing: 8) {
                Text(PeerLabel.platformName(p.platform))
                if !p.reachable { Text("unreachable") }
                if p.paused { Text("signed out") }
                if p.missing { Text("(missing)") }
            }
            .font(.caption)
            .foregroundColor(.secondary)
            Text(p.approvesMe ? "Approves this device" : "Has not approved this device")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    @ViewBuilder
    private func pairingBlock(_ e: PairingEntry) -> some View {
        switch e.state {
        case .committed:
            Text("Pairing with \(label)").font(.subheadline)
            Button("Send again") { Task { await model.sendAgain(p) } }
                .buttonStyle(.bordered)
                .disabled(!model.canSendAgain(e))
            if let hint = model.hintLine(e, p) {
                Text(hint).font(.caption).foregroundColor(.secondary)
            }
        case .prompted where !e.authorized:
            Text("\(label) wants to pair").font(.subheadline)
            Button("Reply") { Task { await model.reply(p) } }
                .buttonStyle(.bordered)
        case .prompted, .replied:
            Text("Pairing...").font(.subheadline)
        case .shown:
            Text(S.pairingFingerprint(p.fingerprint ?? ""))
                .font(.subheadline.monospaced())
                .onAppear { model.fingerprintShown(p) }
            HStack {
                Button("Approve") { Task { _ = await model.approve(p) } }
                Button("Deny", role: .destructive) { Task { await model.deny(p) } }
            }
            .buttonStyle(.bordered)
        }
        if let c = model.countdown(e) {
            Text(c).font(.caption).foregroundColor(.secondary)
        }
    }

    @ViewBuilder
    private var waitingBlock: some View {
        Text(S.waiting(label)).font(.subheadline)
        if let r = p.approveResult, r != "sent", r != "stored", r != "denied" {
            TimelineView(.periodic(from: .now, by: 5)) { ctx in
                let ready = ctx.date.timeIntervalSince1970 >= Double((p.approveSentAt ?? 0) + 60)
                Button("Send again") { Task { await model.approveSendAgain(p) } }
                    .buttonStyle(.bordered)
                    .disabled(!ready)
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        if confirmRemove {
            VStack(alignment: .leading, spacing: 8) {
                Text(S.removeConfirm(label)).font(.callout)
                HStack {
                    Button("Remove", role: .destructive) {
                        confirmRemove = false
                        Task { await model.remove(p) }
                    }
                    Button("Cancel") { confirmRemove = false }
                }
                .buttonStyle(.bordered)
            }
        } else {
            HStack {
                Button("Remove", role: .destructive) { confirmRemove = true }
                if p.missing {
                    Button("Delete") { Task { await model.localDelete(p) } }
                }
                Button(p.hidden ? "Unhide" : "Hide") { model.setHidden(p, !p.hidden) }
            }
            .buttonStyle(.bordered)
        }
    }
}
