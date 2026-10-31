import SwiftUI
import PushArmorCore

struct MainView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = 0

    var body: some View {
        Group {
            if model.needsFirstPair {
                FirstPairView()
            } else {
                tabs
            }
        }
        // the first pairing done: the tabs open on Send (Q338)
        .onChange(of: model.needsFirstPair) { _, v in
            if !v { tab = 0 }
        }
        .sheet(isPresented: Binding(
            get: { model.detailRow != nil },
            set: { if !$0 { model.detailRow = nil } }
        )) {
            if let row = model.detailRow {
                MessageDetailView(row: row)
                    .presentationDetents([.medium, .large])
            }
        }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            HomeView() // its banner sits under the Send bar, in ComposeView
                .tabBarMaterial()
                .tabItem { Label("Send", systemImage: "paperplane") }
                .tag(0)
            HistoryTab()
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
            if model.highlightPeer != nil { tab = 1 }
            if model.showHistory { tab = 3; model.showHistory = false }
        }
        .onChange(of: model.highlightPeer) { _, v in
            if v != nil { tab = 1 }
        }
        .onChange(of: model.showHistory) { _, v in
            if v { tab = 3; model.showHistory = false }
        }
    }
}

/// Q338: logged in with no paired device. Three steps, the devices waiting to pair (the
/// Devices pairing card and its actions), and Settings behind the gear.
struct FirstPairView: View {
    @EnvironmentObject var model: AppModel
    @State private var showSettings = false

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
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            // Taps meant for the Devices or History tab: this screen already shows the
            // waiting devices, and the tabs must open on Send after the first pairing.
            .onAppear { model.highlightPeer = nil; model.showHistory = false }
            .onChange(of: model.highlightPeer) { _, v in if v != nil { model.highlightPeer = nil } }
            .onChange(of: model.showHistory) { _, v in if v { model.showHistory = false } }
        }
    }
}

/// The Send tab: standard large title and compose (ComposeView); no history (F24).
struct HomeView: View {
    var body: some View {
        NavigationStack {
            ComposeView()
                .navigationTitle("Send")
        }
    }
}

/// The History tab (F24): standard large title, filter and rows (HistoryView).
struct HistoryTab: View {
    var body: some View {
        NavigationStack {
            List {
                HistoryView()
            }
            .navigationTitle("History")
            .safeAreaInset(edge: .bottom, spacing: 0) { ToastBanner() }
        }
    }
}

/// Locked, notifications-off and push-failure notices at the top of the Send tab.
struct HomeBanners: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if model.lockedLine != nil || model.notificationsOff || model.pushRegisterFailed {
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
                if model.notificationsOff {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(S.notificationsOff).foregroundColor(.errorText)
                        Button("Open notification settings") { model.openNotificationSettings() }
                            .buttonStyle(.borderless)
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
