import SwiftUI
import PushArmorCore

struct PeersView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulseId: String?
    @State private var pulseOn = false
    @State private var showPairHowTo = false

    /// Removed peers show only while History still holds rows from them.
    private var visible: [Peer] {
        let withHistory = Set(model.history.compactMap { $0.peerId })
        return model.peers.filter { $0.state != .removed || withHistory.contains($0.id.text) }
    }

    /// Peers in a pairing state: an open pairing, or a new peer to pair or deny.
    private func inPairing(_ p: Peer) -> Bool {
        model.pairings[p.id.text] != nil || (!p.pinned && p.state != .removed)
    }

    var body: some View {
        if model.needsFirstPair {
            FirstPairView()
        } else {
            devices
        }
    }

    @ViewBuilder private var devices: some View {
        let pairing = PeerLabel.sorted(visible.filter { inPairing($0) })
        // A pinned peer that pairs again keeps its row (switches, Remove) under its card.
        let listed = PeerLabel.sorted(visible.filter { $0.pinned || !inPairing($0) })
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    if !pairing.isEmpty {
                        Section("Pairing") {
                            ForEach(pairing, id: \.id.text) { p in
                                PairingCardView(p: p)
                                    .id(p.id.text)
                                    .listRowInsets(EdgeInsets(top: 18, leading: 16, bottom: 4, trailing: 16))
                                    .listRowBackground(pulseBackground(p))
                            }
                        }
                    }
                    if listed.isEmpty && pairing.isEmpty {
                        Section {
                            emptyState
                                .listRowBackground(Color.clear)
                        }
                    } else if !listed.isEmpty {
                        // No sub-header: the large title already says Devices (F31).
                        Section {
                            ForEach(listed, id: \.id.text) { p in
                                PeerRowView(p: p)
                                .id(inPairing(p) ? "row-" + p.id.text : p.id.text)
                                .listRowBackground(pulseBackground(p))
                            }
                        }
                    }
                    Section {
                        Button {
                            showPairHowTo = true
                        } label: {
                            Label("Pair a new device", systemImage: "plus.circle")
                        }
                    }
                }
                .sheet(isPresented: $showPairHowTo) { PairHowToView() }
                .contentMargins(.bottom, 12, for: .scrollContent)
                .navigationTitle("Devices")
                .safeAreaInset(edge: .bottom, spacing: 0) { ToastBanner() }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Button { Task { await model.refresh() } } label: {
                                Image(systemName: "arrow.clockwise")
                            }
                            .accessibilityLabel("Refresh")
                            .disabled(ctx.date < model.refreshGreyUntil)
                        }
                    }
                }
                .onAppear { highlight(proxy) }
                .onChange(of: model.highlightPeer) { _, _ in highlight(proxy) }
            }
        }
    }

    private func pulseBackground(_ p: Peer) -> Color? {
        pulseId == p.id.text && pulseOn ? Color.accentColor.opacity(0.25) : nil
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            DevicesIllustration()
            Text("No devices yet")
                .font(.title2.weight(.semibold))
            Text(S.noPeersBody)
                .font(.subheadline)
                .foregroundColor(.secondaryText)
                .multilineTextAlignment(.center)
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Button { Task { await model.refresh() } } label: {
                    Text("Refresh")
                        .foregroundStyle(Color.iconTileFg)
                        .frame(minWidth: 120)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.iconTileBg)
                .controlSize(.large)
                .frame(minHeight: 44)
                .disabled(ctx.date < model.refreshGreyUntil)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
    }

    private func highlight(_ proxy: ScrollViewProxy) {
        guard let id = model.highlightPeer else { return }
        model.highlightPeer = nil
        pulseId = id
        withAnimation { proxy.scrollTo(id, anchor: .center) }
        Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if reduceMotion {
                pulseOn = true
                try? await Task.sleep(nanoseconds: 1_100_000_000)
                pulseOn = false
            } else {
                withAnimation(.easeInOut(duration: 0.35)) { pulseOn = true }
                try? await Task.sleep(nanoseconds: 450_000_000)
                withAnimation(.easeInOut(duration: 0.35)) { pulseOn = false }
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
            pulseId = nil
        }
    }
}

/// The "Pair a new device" how-to (F30): pairing starts from the new device's row here.
struct PairHowToView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(S.pairHowTo1, systemImage: "1.circle.fill")
                    Label(S.pairHowTo2, systemImage: "2.circle.fill")
                    Label(S.pairHowTo3, systemImage: "3.circle.fill")
                }
            }
            .navigationTitle("Pair a new device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Lines and buttons shared by the pairing card and the peer row: approve wait, cancel, notes.
struct PeerPendingLines: View {
    let p: Peer
    var showCancel = true
    @EnvironmentObject var model: AppModel

    private var label: String { model.label(p) }

    var body: some View {
        if p.state == .approved && !p.approveVerified {
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
        if showCancel && model.offersPairAgain(p) {
            Button("Pair again") { Task { await model.pairAgain(p) } }
                .buttonStyle(.bordered)
                .disabled(model.pairAgainBusy.contains(p.id.text))
        } else if showCancel && model.offersCancel(p) {
            Button("Cancel pairing") { Task { await model.cancelPairing(p) } }
                .buttonStyle(.bordered)
        }
        if p.notPairedOnPeer {
            Text(p.declinedByPeer ? S.declinedBy(label) : S.notPairedOn(label))
                .font(.footnote)
                .foregroundColor(.secondaryText)
        }
        if p.note == "failed" {
            failure(S.pairingFailed)
        } else if p.note == "timedOut" {
            failure(S.pairingTimedOut)
        }
    }

    private func failure(_ s: String) -> some View {
        Label(s, systemImage: "exclamationmark.circle")
            .font(.footnote)
            .foregroundColor(.errorText)
    }
}

/// One card per peer in a pairing state (Pairing section).
struct PairingCardView: View {
    let p: Peer
    @EnvironmentObject var model: AppModel
    @State private var confirmRemove = false

    private var label: String { model.label(p) }
    private var entry: PairingEntry? { model.pairings[p.id.text] }

    private var title: String {
        guard let e = entry else { return S.pairWith(label) }
        switch e.state {
        case .committed: return "Pairing with \(label)"
        case .prompted where !e.authorized: return S.pairWith(label)
        case .prompted, .replied: return "Pairing..."
        case .shown: return S.pairWith(label)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                HStack(spacing: 14) {
                    IconTile(platformSymbol(p.platform), size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.headline)
                        Text(PeerLabel.platformName(p.platform))
                            .font(.subheadline)
                            .foregroundColor(.secondaryText)
                    }
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 0)
                if !p.pinned {
                    // A peer not yet paired has no row under Peers: its switches and Remove live here.
                    Menu { peerActions } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.title3)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("More actions")
                    .padding(.top, -2)
                    .padding(.trailing, -10)
                }
            }

            VStack(alignment: .leading, spacing: 12) {
                stateBlock
                PeerPendingLines(p: p, showCancel: false)
            }
            .padding(.top, 16)

            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            // Long press: a shortcut to the same actions as the More actions button.
            if !p.pinned { peerActions }
        }
        .confirmationDialog(S.removeConfirm(label), isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await model.remove(p) } }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var peerActions: some View {
        PeerMenuItems(p: p, model: model, confirmRemove: $confirmRemove)
    }

    private func denyButton(_ title: String = "Reject") -> some View {
        // Destructive role for VoiceOver; the outline and ink keep the design's neutral look.
        Button(role: .destructive) { Task { await model.deny(p) } } label: {
            Text(title)
        }
        .disabled(model.busy.contains("deny:" + p.id.text))
        .buttonStyle(OutlinedDenyButtonStyle())
    }

    @ViewBuilder
    private var stateBlock: some View {
        if let e = entry {
            switch e.state {
            case .committed:
                Button("Send again") { Task { await model.sendAgain(p) } }
                    .buttonStyle(.bordered)
                    .disabled(!model.canSendAgain(e))
                if let hint = model.hintLine(e, p) {
                    Text(hint).font(.footnote).foregroundColor(.secondaryText)
                }
            case .prompted where !e.authorized:
                Text(S.newPeerWantsToPair).font(.subheadline).foregroundColor(.secondaryText)
                Button("Reply") { Task { await model.reply(p) } }
                    .buttonStyle(NeutralButtonStyle())
            case .prompted, .replied:
                EmptyView()
            case .shown:
                FingerprintPlate(code: p.fingerprint ?? "", peer: label)
                    .onAppear { model.fingerprintShown(p) }
                HStack(spacing: 12) {
                    denyButton("Codes differ")
                    Button("Codes match") { Task { _ = await model.approve(p) } }
                        .buttonStyle(TonalGreenButtonStyle())
                    .disabled(model.busy.contains("approve:" + p.id.text))
                }
                .padding(.top, 4)
                Label(S.codesMismatch, systemImage: "info.circle.fill")
                    .font(.footnote)
                    .foregroundColor(.secondaryText)
                    .frame(maxWidth: .infinity)
            }
        } else {
            HStack(spacing: 12) {
                denyButton()
                Button("Pair") { Task { await model.pair(p) } }
                    .buttonStyle(TonalGreenButtonStyle())
                    .disabled(model.busy.contains("pair:" + p.id.text))
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        let cancel = model.offersCancel(p)
        let countdown = entry.flatMap { model.countdown($0) }
        if cancel || countdown != nil {
            Divider()
                .padding(.top, 12)
                .padding(.horizontal, -16)
            HStack {
                if cancel && model.offersPairAgain(p) {
                    Button("Pair again") { Task { await model.pairAgain(p) } }
                        .buttonStyle(.bordered)
                        .disabled(model.pairAgainBusy.contains(p.id.text))
                        .font(.subheadline)
                } else if cancel {
                    Button("Cancel pairing") { Task { await model.cancelPairing(p) } }
                        .buttonStyle(.bordered)
                        .font(.subheadline)
                }
                Spacer()
                if let c = countdown {
                    Text(S.timesOutIn(c))
                        .font(.caption)
                        .foregroundColor(.secondaryText)
                }
            }
            .frame(minHeight: 44)
        } else {
            Color.clear.frame(height: 14)
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

    private var status: (kind: StatusKind, text: String) {
        if p.missing { return (.off, "(missing)") }
        if p.loggedOut { return (.off, "Logged out") }
        if !p.listening { return (.off, "Send only") }
        if !p.reachable { return (.off, "Unreachable") }
        if p.approvesMe { return (.approves, "Paired") }
        return (.notApproved, "Has not confirmed this device")
    }

    var body: some View {
        if removed {
            header(icons: false)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .onTapGesture { Task { await model.tapGreyed() } }
                .opacity(0.6)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
        } else {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 8) {
                    header(icons: true)
                        .contentShape(Rectangle())
                        .onTapGesture { if greyed { Task { await model.tapGreyed() } } }
                    PeerPendingLines(p: p)
                }
                // Full width so the status icons in the header sit just left of the menu button.
                .frame(maxWidth: .infinity, alignment: .leading)
                Menu { PeerMenuItems(p: p, model: model, confirmRemove: $confirmRemove) } label: {
                    Image(systemName: "ellipsis")
                        .font(.title3)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("More actions")
                .accessibilityIdentifier("peerMenu:" + label)
            }
            .padding(.vertical, 4)
            .confirmationDialog(S.removeConfirm(label), isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { await model.remove(p) } }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    /// Status icons for the device settings, in the device menu order (Q412): on when effectively on.
    private var statusIcons: some View {
        let content = model.boolSetting(SettingKey.showContent, true) && p.showContent
        let lock = content && model.boolSetting(SettingKey.lockShow, true) && p.lockShow
        let send = !p.hidden
        return HStack(spacing: 3) {
            statusIcon("paperplane", send)
            statusIcon("bell", content)
            statusIcon("lock", lock)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(S.peerStatusIcons(sendScreen: send, content: content, lockScreen: lock))
    }

    private func statusIcon(_ name: String, _ on: Bool) -> some View {
        Image(systemName: name)
            .font(.system(size: 14))
            .frame(width: 16, height: 16)
            .foregroundStyle(Color.primary)
            .opacity(on ? 1 : 0.3)
            .accessibilityHidden(true)
    }

    private func header(icons: Bool) -> some View {
        HStack(spacing: 14) {
            IconTile(platformSymbol(p.platform))
                .opacity(greyed ? 0.6 : 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(removed ? label + " (removed)" : label)
                    .font(.body)
                    .foregroundColor(greyed ? .secondaryText : .primary)
                // The status icons sit right of lines 2-3 only; the name keeps its full width (Q413).
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(PeerLabel.platformName(p.platform))
                            .font(.subheadline)
                            .foregroundColor(.secondaryText)
                        StatusLine(kind: status.kind, text: status.text)
                    }
                    if icons {
                        Spacer(minLength: 0)
                        statusIcons
                    }
                }
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        }
    }
}

/// The device menu items, shared by the device row and the pairing card (Q409).
struct PeerMenuItems: View {
    let p: Peer
    let model: AppModel
    @Binding var confirmRemove: Bool

    var body: some View {
        Toggle("Show device on Send screen", isOn: Binding(
            get: { !p.hidden },
            set: { model.setHidden(p, !$0) }
        ))
        // Per-device switches follow the global ones: disabled and shown off while a global one is off.
        Toggle(S.peerShowContentSwitch, isOn: Binding(
            get: { model.boolSetting(SettingKey.showContent, true) && p.showContent },
            set: { model.setPeerSwitches(p, showContent: $0) }
        ))
        .disabled(!model.boolSetting(SettingKey.showContent, true))
        Toggle(S.peerLockScreenSwitch, isOn: Binding(
            get: { model.boolSetting(SettingKey.showContent, true) && model.boolSetting(SettingKey.lockShow, true) && p.showContent && p.lockShow },
            set: { model.setPeerSwitches(p, lockShow: $0) }
        ))
        .disabled(!model.boolSetting(SettingKey.lockShow, true) || !model.boolSetting(SettingKey.showContent, true) || !p.showContent)
        Divider()
        if p.missing {
            Button("Delete") { Task { await model.localDelete(p) } }
        }
        Button("Remove device from account", role: .destructive) { confirmRemove = true }
    }
}
