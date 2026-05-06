import SwiftUI

/// iOS-only "More" tab. Replaces the system-provided overflow tab so we own the
/// `NavigationStack` (provided by ContentView) and overflow screens become
/// pushed views — preventing the double-back-button bug that the system More
/// tab causes when its inner views also wrap themselves in a `NavigationStack`.
struct MoreView: View {
    var body: some View {
        List {
            NavigationLink {
                GroupListView()
            } label: {
                EntityListRow(icon: "folder.fill", iconColor: .orange, title: "Groups")
            }

            NavigationLink {
                LocationListView()
            } label: {
                EntityListRow(icon: "mappin.and.ellipse", iconColor: .red, title: "Locations")
            }

            NavigationLink {
                NetworkGraphView()
            } label: {
                EntityListRow(icon: "point.3.connected.trianglepath.dotted", iconColor: .purple, title: "Network")
            }

            NavigationLink {
                RemindersView()
            } label: {
                EntityListRow(icon: "bell", iconColor: .pink, title: "Reminders")
            }

            NavigationLink {
                SettingsView()
            } label: {
                EntityListRow(icon: "gear", iconColor: .gray, title: "Settings")
            }
        }
        .navigationTitle("More")
    }
}
