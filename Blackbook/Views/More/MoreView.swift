import SwiftUI

struct MoreView: View {
    var body: some View {
        List {
            NavigationLink {
                GroupListView()
            } label: {
                Label("Groups", systemImage: "folder.fill")
            }
            NavigationLink {
                LocationListView()
            } label: {
                Label("Locations", systemImage: "mappin.and.ellipse")
            }
            NavigationLink {
                NetworkGraphView()
            } label: {
                Label("Network", systemImage: "point.3.connected.trianglepath.dotted")
            }
            NavigationLink {
                RemindersView()
            } label: {
                Label("Reminders", systemImage: "bell")
            }
            NavigationLink {
                SettingsView()
            } label: {
                Label("Settings", systemImage: "gear")
            }
        }
        .navigationTitle("More")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
