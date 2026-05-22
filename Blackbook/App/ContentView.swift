import SwiftUI
import SwiftData

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab: AppTab = .dashboard
    @State private var syncService = ContactSyncService()
    @State private var dedupeService = ContactDeduplicationService()
    @State private var mergeService = ContactMergeService()
    @State private var bonjourBrowser = BonjourBrowser()
    @State private var serverSyncService = LocalServerSyncService()

    var body: some View {
        #if os(iOS)
        TabView(selection: $selectedTab) {
            NavigationStack { DashboardView() }.tabItem { Label("Overview", systemImage: "square.grid.2x2") }.tag(AppTab.dashboard)
            NavigationStack { ContactListView() }.tabItem { Label("Contacts", systemImage: "person.crop.rectangle.stack") }.tag(AppTab.contacts)
            NavigationStack { ActivityListView() }.tabItem { Label("Activities", systemImage: "figure.run") }.tag(AppTab.activities)
            NavigationStack { TagListView() }.tabItem { Label("Tags", systemImage: "tag") }.tag(AppTab.tags)
            NavigationStack { MoreView() }.tabItem { Label("More", systemImage: "ellipsis") }.tag(AppTab.more)
        }
        .tint(AppConstants.UI.accentGold)
        .onAppear { configureAndStartSync() }
        .onDisappear { serverSyncService.stopPeriodicSync() }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task { await serverSyncService.performFullSync() }
            }
        }
        #else
        NavigationSplitView {
            List(selection: $selectedTab) {
                ForEach(AppTab.allCases) { tab in
                    Label(tab.title, systemImage: tab.icon)
                        .tag(tab)
                }
            }
            .navigationTitle(AppConstants.appName)
            .listStyle(.sidebar)
        } detail: {
            detailView(for: selectedTab)
        }
        .frame(minWidth: 800, minHeight: 500)
        .onAppear { configureAndStartSync() }
        .onDisappear { serverSyncService.stopPeriodicSync() }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task { await serverSyncService.performFullSync() }
            }
        }
        #endif
    }

    private func configureAndStartSync() {
        syncService.startAutoSync(with: modelContext)
        bonjourBrowser.configure()
        serverSyncService.configure(with: modelContext)
        runDedupAfterRestoreIfNeeded()
        Task {
            try? await Task.sleep(for: .seconds(1))
            await serverSyncService.performFullSync()
            await UserActionLogger.shared.uploadPending()
            serverSyncService.startPeriodicSync(intervalSeconds: 300)
        }
    }

    private func runDedupAfterRestoreIfNeeded() {
        let key = "dedup.runAfterNextLaunch"
        guard UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(false, forKey: key)
        let context = modelContext
        let dedup = dedupeService
        let merger = mergeService
        Task { @MainActor in
            do {
                let merged = try dedup.mergeAll(using: merger, in: context)
                Log.action("contacts.dedupe.afterRestore", metadata: ["mergedCount": "\(merged)"], success: true)
            } catch {
                Log.action("contacts.dedupe.afterRestore", success: false, error: error.localizedDescription)
            }
        }
    }

    @ViewBuilder
    private func detailView(for tab: AppTab) -> some View {
        NavigationStack {
            switch tab {
            case .dashboard: DashboardView()
            case .contacts: ContactListView()
            case .activities: ActivityListView()
            case .tags: TagListView()
            case .groups: GroupListView()
            case .locations: LocationListView()
            case .network: NetworkGraphView()
            case .reminders: RemindersView()
            case .settings: SettingsView()
            case .more: EmptyView() // iOS-only tab; macOS sidebar lists each item directly
            }
        }
    }
}

enum AppTab: String, CaseIterable, Identifiable {
    case dashboard, contacts, activities, tags, groups, locations, network, reminders, settings, more

    /// `more` is iOS-only; the macOS sidebar shows every case directly.
    static var allCases: [AppTab] {
        [.dashboard, .contacts, .activities, .tags, .groups, .locations, .network, .reminders, .settings]
    }

    var id: String { rawValue }
    var title: String {
        switch self {
        case .dashboard: return "Overview"
        default: return rawValue.capitalized
        }
    }
    var icon: String {
        switch self {
        case .dashboard: return "square.grid.2x2"
        case .contacts: return "person.crop.rectangle.stack"
        case .activities: return "figure.run"
        case .tags: return "tag"
        case .groups: return "folder.fill"
        case .locations: return "mappin.and.ellipse"
        case .network: return "point.3.connected.trianglepath.dotted"
        case .reminders: return "bell"
        case .settings: return "gear"
        case .more: return "ellipsis"
        }
    }
}
