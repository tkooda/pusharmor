import SwiftUI
import PushArmorCore

struct PeersView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var renaming = false
    @State private var newName = ""
    @State private var pulseId: String?
    @State private var pulseOn = false
    @State private var expanded: String?

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
        let pairing = visible.filter { inPairing($0) }
        // A pinned peer that pairs again keeps its row (switches, Hide, Remove) under its card.
        let listed = visible.filter { $0.pinned || !inPairing($0) }
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
                    Section("This device") {
                        thisDeviceRow(plain: !pairing.isEmpty)
                    }
                    if listed.isEmpty && pairing.isEmpty {
                        Section {
                            emptyState
                                .listRowBackground(Color.clear)
                        }
                    } else if !listed.isEmpty {
                        Section("Devices") {
                            ForEach(listed, id: \.id.text) { p in
                                PeerRowView(p: p, isExpanded: Binding(
                                    get: { expanded == p.id.text },
                                    set: { expanded = $0 ? p.id.text : nil }
                                ))
                                .id(inPairing(p) ? "row-" + p.id.text : p.id.text)
                                .listRowBackground(pulseBackground(p))
                            }
                        }
                    }
                }
                .contentMargins(.bottom, 12, for: .scrollContent)
                .navigationTitle("Devices")
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

    @ViewBuilder
    private func thisDeviceRow(plain: Bool) -> some View {
        if renaming {
            VStack(alignment: .leading, spacing: 8) {
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
            }
        } else {
            HeroCell(name: model.me?.name ?? "This device", plain: plain) {
                newName = model.me?.name ?? ""
                renaming = true
            }
            .listRowInsets(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 20))
            .listRowBackground(plain ? nil : HeroBackground())
        }
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
        if showCancel && model.offersCancel(p) {
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
            .foregroundColor(.red)
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
                    // A peer not yet paired has no row under Peers: its switches, Hide and Remove live here.
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

    @ViewBuilder
    private var peerActions: some View {
        Toggle(S.lockScreenSwitch, isOn: Binding(
            get: { p.lockShow },
            set: { model.setPeerSwitches(p, lockShow: $0) }
        ))
        .disabled(!model.boolSetting(SettingKey.lockShow, true))
        Toggle(S.alwaysHide, isOn: Binding(
            get: { p.alwaysHide },
            set: { model.setPeerSwitches(p, alwaysHide: $0) }
        ))
        Button(p.hidden ? "Unhide" : "Hide") { model.setHidden(p, !p.hidden) }
        Button("Remove", role: .destructive) { confirmRemove = true }
        if p.missing {
            Button("Delete") { Task { await model.localDelete(p) } }
        }
    }

    private func denyButton() -> some View {
        // Destructive role for VoiceOver; the tint and ink keep the design's neutral look.
        Button(role: .destructive) { Task { await model.deny(p) } } label: {
            Text("Deny")
                .foregroundStyle(Color.red)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(.red)
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .overlay(Capsule().stroke(Color.red, lineWidth: 1))
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
                    .buttonStyle(GreenButtonStyle())
            case .prompted, .replied:
                EmptyView()
            case .shown:
                FingerprintPlate(code: p.fingerprint ?? "", peer: label)
                    .onAppear { model.fingerprintShown(p) }
                HStack(spacing: 12) {
                    denyButton()
                    Button { Task { _ = await model.approve(p) } } label: {
                        Label("Approve", systemImage: "checkmark")
                    }
                    .buttonStyle(GreenButtonStyle())
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
                    .buttonStyle(GreenButtonStyle())
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
                if cancel {
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
    @Binding var isExpanded: Bool
    @EnvironmentObject var model: AppModel
    @State private var confirmRemove = false

    private var label: String { model.label(p) }
    private var removed: Bool { p.state == .removed }
    private var greyed: Bool { removed || p.missing || !p.reachable }

    private var status: (kind: StatusKind, text: String) {
        if p.missing { return (.off, "(missing)") }
        if p.paused { return (.off, "Signed out") }
        if !p.reachable { return (.off, "Unreachable") }
        if p.approvesMe { return (.approves, "Connected") }
        return (.notApproved, "Has not approved this device")
    }

    var body: some View {
        if removed {
            header
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .onTapGesture { Task { await model.tapGreyed() } }
                .opacity(0.5)
        } else {
            DisclosureGroup(isExpanded: Binding(
                get: { isExpanded },
                set: { v in
                    isExpanded = v
                    if v && greyed { Task { await model.tapGreyed() } }
                }
            )) {
                Group {
                    Toggle(S.lockScreenSwitch, isOn: Binding(
                        get: { p.lockShow },
                        set: { model.setPeerSwitches(p, lockShow: $0) }
                    ))
                    .disabled(!model.boolSetting(SettingKey.lockShow, true))
                    Toggle(S.alwaysHide, isOn: Binding(
                        get: { p.alwaysHide },
                        set: { model.setPeerSwitches(p, alwaysHide: $0) }
                    ))
                    actions
                }
                .tint(.brandGreen)
                .padding(.leading, 48)
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    header
                    PeerPendingLines(p: p)
                }
                .padding(.vertical, 4)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            IconTile(platformSymbol(p.platform))
                .opacity(greyed ? 0.6 : 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(removed ? label + " (removed)" : label)
                    .font(.body)
                    .foregroundColor(greyed ? .secondaryText : .primary)
                Text(PeerLabel.platformName(p.platform))
                    .font(.subheadline)
                    .foregroundColor(.secondaryText)
                StatusLine(kind: status.kind, text: status.text)
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
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
            HStack(spacing: 10) {
                Button(p.hidden ? "Unhide" : "Hide") { model.setHidden(p, !p.hidden) }
                Button("Remove", role: .destructive) { confirmRemove = true }
                if p.missing {
                    Button("Delete") { Task { await model.localDelete(p) } }
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
        }
    }
}
