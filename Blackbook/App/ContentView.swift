import SwiftUI
import SwiftData

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var selectedTab: AppTab = .dashboard
    @State private var syncService = ContactSyncService()

    var body: some View {
        #if os(iOS)
        TabView(selection: $selectedTab) {
            DashboardView().tabItem { Label("Overview", systemImage: "square.grid.2x2") }.tag(AppTab.dashboard)
            ContactListView().tabItem { Label("Contacts", systemImage: "person.crop.rectangle.stack") }.tag(AppTab.contacts)
            ActivityListView().tabItem { Label("Activities", systemImage: "figure.run") }.tag(AppTab.activities)
            TagListView().tabItem { Label("Tags", systemImage: "tag") }.tag(AppTab.tags)
            GroupListView().tabItem { Label("Groups", systemImage: "folder.fill") }.tag(AppTab.groups)
            LocationListView().tabItem { Label("Locations", systemImage: "mappin.and.ellipse") }.tag(AppTab.locations)
            NetworkGraphView().tabItem { Label("Network", systemImage: "point.3.connected.trianglepath.dotted") }.tag(AppTab.network)
            RemindersView().tabItem { Label("Reminders", systemImage: "bell") }.tag(AppTab.reminders)
            SettingsView().tabItem { Label("Settings", systemImage: "gear") }.tag(AppTab.settings)
        }
        .tint(AppConstants.UI.accentGold)
        .onAppear {
            syncService.startAutoSync(with: modelContext)
        }
        .task {
            let backupService = BackupService()
            if backupService.checkAutoBackupNeeded() {
                await backupService.createBackup(modelContext: modelContext, type: .automatic)
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
        .onAppear {
            syncService.startAutoSync(with: modelContext)
        }
        .task {
            let backupService = BackupService()
            if backupService.checkAutoBackupNeeded() {
                await backupService.createBackup(modelContext: modelContext, type: .automatic)
            }
        }
        #endif
    }

    @ViewBuilder
    private func detailView(for tab: AppTab) -> some View {
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
        }
    }
}

enum AppTab: String, CaseIterable, Identifiable {
    case dashboard, contacts, activities, tags, groups, locations, network, reminders, settings
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
        }
    }
}
