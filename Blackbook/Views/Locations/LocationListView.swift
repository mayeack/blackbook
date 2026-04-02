import SwiftUI
import SwiftData

struct LocationListView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Location.name) private var locations: [Location]
    @State private var searchText = ""
    @State private var showAddLocation = false

    private var filteredLocations: [Location] {
        if searchText.isEmpty { return locations }
        return locations.filter {
            $0.name.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        SwiftUI.Group {
            if filteredLocations.isEmpty {
                ContentUnavailableView {
                    Label("No Locations", systemImage: "mappin.and.ellipse")
                } description: {
                    Text("Create locations to organize your contacts by place.")
                } actions: {
                    Button("New Location") { showAddLocation = true }
                        .buttonStyle(.borderedProminent)
                        .tint(AppConstants.UI.accentGold)
                }
            } else {
                List {
                    ForEach(filteredLocations) { location in
                        NavigationLink(value: location.id) {
                            LocationRowView(location: location)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                modelContext.delete(location)
                                try? modelContext.save()
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
                .navigationDestination(for: UUID.self) { id in
                    if let location = locations.first(where: { $0.id == id }) {
                        LocationDetailView(location: location)
                    }
                }
            }
        }
        .navigationTitle("Locations")
        .searchable(text: $searchText, prompt: "Search locations...")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAddLocation = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showAddLocation) { LocationFormView(location: nil) }
    }
}

struct LocationRowView: View {
    let location: Location

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: location.icon)
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(location.color.gradient, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(location.name)
                    .font(.body.weight(.medium))
                Text("\(location.contacts.count) contact\(location.contacts.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}
