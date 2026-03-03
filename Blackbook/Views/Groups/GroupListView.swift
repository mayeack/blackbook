import SwiftUI
import SwiftData

struct GroupListView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Group.name) private var groups: [Group]
    @State private var searchText = ""
    @State private var showAddGroup = false

    private var filteredGroups: [Group] {
        if searchText.isEmpty { return groups }
        return groups.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        NavigationStack {
            SwiftUI.Group {
                if filteredGroups.isEmpty {
                    ContentUnavailableView {
                        Label("No Groups", systemImage: "folder")
                    } description: {
                        Text("Create groups to organize your contacts.")
                    } actions: {
                        Button("New Group") { showAddGroup = true }
                            .buttonStyle(.borderedProminent)
                            .tint(AppConstants.UI.accentGold)
                    }
                } else {
                    List {
                        ForEach(filteredGroups) { group in
                            NavigationLink(value: group.id) {
                                GroupRowView(group: group)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    modelContext.delete(group)
                                    try? modelContext.save()
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                    .navigationDestination(for: UUID.self) { id in
                        if let group = groups.first(where: { $0.id == id }) {
                            GroupDetailView(group: group)
                        }
                    }
                }
            }
            .navigationTitle("Groups")
            .searchable(text: $searchText, prompt: "Search groups...")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAddGroup = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showAddGroup) { GroupFormView(group: nil) }
        }
    }
}

struct GroupRowView: View {
    let group: Group

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: group.icon)
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(group.color.gradient, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(group.name)
                    .font(.body.weight(.medium))
                Text("\(group.contacts.count) contact\(group.contacts.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}
