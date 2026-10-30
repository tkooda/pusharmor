import SwiftUI
import PushArmorCore

struct MainView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            HomeView()
                .tabBarMaterial()
                .tabItem { Label("Home", systemImage: "house") }
                .tag(0)
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
            if model.showHistory { tab = 0; model.showHistory = false }
        }
        .onChange(of: model.highlightPeer) { _, v in
            if v != nil { tab = 1 }
        }
        .onChange(of: model.showHistory) { _, v in
            if v { tab = 0; model.showHistory = false }
        }
        .sheet(isPresented: Binding(
            get: { model.detailRow != nil },
            set: { if !$0 { model.detailRow = nil } }
        )) {
            if let row = model.detailRow {
                MessageDetailView(row: row)
            }
        }
    }
}

/// Banners, compose and history in one list.
struct HomeView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
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
                                Text(S.notificationsOff).foregroundColor(.red)
                                Button("Open notification settings") { model.openNotificationSettings() }
                                    .buttonStyle(.borderless)
                            }
                        }
                        if model.pushRegisterFailed {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Push registration failed").foregroundColor(.red)
                                Button("Retry") { model.retryPushRegistration() }
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                }
                Section("Send") {
                    ComposeView()
                }
                HistoryView()
            }
            .contentMargins(.bottom, 12, for: .scrollContent)
            .navigationTitle("PushArmor")
            // A custom header, not a toolbar item: iOS 26 wraps bar items in a glass bubble.
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: 8) {
                    BrandTileView(size: 30)
                    Wordmark(size: 22)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20)
                .frame(minHeight: 44)
                .padding(.bottom, 4)
                .background(Color(uiColor: .systemGroupedBackground))
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
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
