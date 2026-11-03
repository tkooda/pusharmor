import SwiftUI
import PushArmorCore

struct MainView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = 0

    var body: some View {
        // The tabs show even with no paired device; Devices then holds the first-pair steps.
        tabs
        // the first pairing done: Send opens
        .onChange(of: model.needsFirstPair) { _, v in
            if !v { select(0) }
        }
    }

    /// A tab switch shows the new tab at once, with no animation.
    private func select(_ t: Int) {
        instantly { tab = t }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            HomeView { select(1) } // its banner sits under the Send bar, in ComposeView
                .tabBarMaterial()
                .tabItem { Label("Send", systemImage: "paperplane") }
                .tag(0)
            HistoryTab(onSend: { select(0) }, onPair: { select(1) })
                .tabBarMaterial()
                .tabItem { Label("History", systemImage: "clock") }
                .tag(3)
            PeersView()
                .tabBarMaterial()
                .tabItem { Label("Devices", systemImage: "person.2") }
                .tag(1)
            SettingsView()
                .tabBarMaterial()
                .tabItem { Label("Settings", systemImage: "gear") }
                .tag(2)
        }
        .onAppear {
            // no pairing complete on both sides yet: open on Devices
            if model.highlightPeer != nil || !model.launchesOnSend { tab = 1 }
            if model.showHistory { tab = 3; model.showHistory = false }
        }
        .onChange(of: model.highlightPeer) { _, v in
            if v != nil { select(1) }
        }
        .onChange(of: model.showHistory) { _, v in
            if v { select(3); model.showHistory = false }
        }
    }
}

/// The Devices tab with no paired device: three steps and the devices waiting
/// to pair (the Devices pairing card and its actions).
struct FirstPairView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(S.firstPairStep1, systemImage: "1.circle.fill")
                    Label(S.firstPairStep2, systemImage: "2.circle.fill")
                    Label(S.firstPairStep3, systemImage: "3.circle.fill")
                }
                Section("Waiting to pair") {
                    let waiting = model.waitingToPair
                    if waiting.isEmpty {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(S.firstPairWaiting)
                                .foregroundColor(.secondaryText)
                        }
                        .accessibilityElement(children: .combine)
                    } else {
                        ForEach(waiting, id: \.id.text) { p in
                            PairingCardView(p: p)
                                .listRowInsets(EdgeInsets(top: 18, leading: 16, bottom: 4, trailing: 16))
                        }
                    }
                }
            }
            .contentMargins(.bottom, 12, for: .scrollContent)
            .refreshable { await model.refresh() }
            .navigationTitle("Pair your first device")
            .navigationBarTitleDisplayMode(.inline)
            // A tap meant for a device row: this screen already shows the waiting devices.
            .onAppear { model.highlightPeer = nil }
            .onChange(of: model.highlightPeer) { _, v in if v != nil { model.highlightPeer = nil } }
        }
    }
}

/// Send and History with no paired device: the line and a button to the Devices tab.
struct PairFirstPrompt: View {
    let onPair: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text("Pair your first device to start sending.")
                .font(.subheadline)
                .foregroundColor(.secondaryText)
                .multilineTextAlignment(.center)
            Button("Pair a device", action: onPair)
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
    }
}

/// The Send tab: standard large title and compose (ComposeView); no history (F24).
struct HomeView: View {
    @EnvironmentObject var model: AppModel
    let onPair: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if model.needsFirstPair {
                    List {
                        HomeBanners()
                        Section {
                            VStack(spacing: 12) {
                                DevicesIllustration()
                                PairFirstPrompt(onPair: onPair)
                            }
                            .padding(.top, 24)
                            .listRowBackground(Color.clear)
                        }
                    }
                    .safeAreaInset(edge: .bottom, spacing: 0) { ToastBanner() }
                } else {
                    ComposeView(draft: model.draft)
                }
            }
            .navigationTitle("Send")
        }
    }
}

/// The History tab (F24): standard large title, filter and rows (HistoryView).
struct HistoryTab: View {
    let onSend: () -> Void
    let onPair: () -> Void
    @EnvironmentObject var model: AppModel
    /// Multi-select: long-press a row to start; leaving the tab ends it.
    @State private var selection = HistorySelection()
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            List {
                HistoryView(selection: $selection, confirmDelete: $confirmDelete, onSend: onSend, onPair: onPair)
            }
            .onChange(of: model.history.map(\.rowid)) { _, ids in selection.keep(only: Set(ids)) }
            .onDisappear { selection.exit() }
            .alert(selection.confirmTitle, isPresented: $confirmDelete) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    if let ids = selection.ids { model.deleteRows(ids) }
                    selection.exit()
                }
            } message: {
                Text("This deletes the selected messages from this device.")
            }
            .navigationTitle("History")
            .safeAreaInset(edge: .bottom, spacing: 0) { ToastBanner() }
        }
    }
}

/// Locked and push-failure notices at the top of the Send tab.
struct HomeBanners: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if model.lockedLine != nil || model.pushRegisterFailed {
            Section {
                if let line = model.lockedLine {
                    HStack {
                        Text(line)
                        Spacer()
                        Button {
                            model.lockedLine = nil
                        } label: {
                            Image(systemName: "xmark.circle")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Dismiss")
                    }
                }
                if model.pushRegisterFailed {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(S.pushRegistrationFailed).foregroundColor(.errorText)
                        Button("Retry") { model.retryPushRegistration() }
                            .buttonStyle(.borderless)
                    }
                }
            }
        }
    }
}

extension View {
    /// The tab bar always sits on the system bar material, at rest too.
    func tabBarMaterial() -> some View {
        toolbarBackground(.visible, for: .tabBar)
            .toolbarBackground(.bar, for: .tabBar)
    }
}
