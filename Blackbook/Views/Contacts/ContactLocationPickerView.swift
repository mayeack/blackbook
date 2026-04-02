import SwiftUI
import SwiftData

struct ContactLocationPickerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Bindable var contact: Contact
    let allLocations: [Location]
    @State private var selectedIDs: Set<UUID> = []
    @State private var searchText = ""

    private var suggestedLocations: [Location] {
        let currentIDs = selectedIDs
        let candidates = allLocations.filter { !currentIDs.contains($0.id) && !$0.contacts.isEmpty }
        let contactTagIDs = Set(contact.tags.map(\.id))
        let contactGroupIDs = Set(contact.groups.map(\.id))
        let contactLocationIDs = Set(contact.locations.map(\.id))
        let contactInterests = Set(contact.interests.map { $0.lowercased() })
        let contactCompany = contact.company?.lowercased()

        let scored: [(Location, Int)] = candidates.compactMap { location in
            var score = 0
            for member in location.contacts where member.id != contact.id {
                if let mc = member.company?.lowercased(), let cc = contactCompany, mc == cc { score += 3 }
                score += member.tags.filter { contactTagIDs.contains($0.id) }.count * 2
                score += member.groups.filter { contactGroupIDs.contains($0.id) }.count * 2
                score += member.locations.filter { contactLocationIDs.contains($0.id) }.count
                score += member.interests.filter { contactInterests.contains($0.lowercased()) }.count
            }
            return score > 0 ? (location, score) : nil
        }
        return scored.sorted { $0.1 > $1.1 }.prefix(5).map(\.0)
    }

    private var filteredLocations: [Location] {
        let suggestedIDs = searchText.isEmpty ? Set(suggestedLocations.map(\.id)) : []
        let base = allLocations.filter { !selectedIDs.contains($0.id) && !suggestedIDs.contains($0.id) }
        if searchText.isEmpty { return base }
        return base.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var selectedLocations: [Location] {
        allLocations.filter { selectedIDs.contains($0.id) }.sorted { $0.name < $1.name }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search locations…", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                        #if os(macOS)
                        .padding(.vertical, 4)
                        #endif
                }

                if !selectedLocations.isEmpty {
                    Section("Selected") {
                        ForEach(selectedLocations) { location in
                            locationRow(location, isSelected: true)
                        }
                    }
                }

                if !suggestedLocations.isEmpty && searchText.isEmpty {
                    Section("Suggested") {
                        ForEach(suggestedLocations) { location in
                            locationRow(location, isSelected: false)
                        }
                    }
                }

                Section(searchText.isEmpty ? "All Locations" : "Results") {
                    if filteredLocations.isEmpty {
                        ContentUnavailableView {
                            Label("No Locations", systemImage: "mappin.slash")
                        } description: {
                            Text(searchText.isEmpty
                                 ? "All locations are already assigned."
                                 : "No matching locations found.")
                        }
                    } else {
                        ForEach(filteredLocations) { location in
                            locationRow(location, isSelected: false)
                        }
                    }
                }
            }
            .navigationTitle("Manage Locations")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        contact.locations = allLocations.filter { selectedIDs.contains($0.id) }
                        contact.updatedAt = Date()
                        try? modelContext.save()
                        dismiss()
                    }.fontWeight(.semibold)
                }
            }
            .onAppear {
                selectedIDs = Set(contact.locations.map(\.id))
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 450, idealHeight: 550)
        #endif
    }

    private func locationRow(_ location: Location, isSelected: Bool) -> some View {
        Button {
            if selectedIDs.contains(location.id) {
                selectedIDs.remove(location.id)
            } else {
                selectedIDs.insert(location.id)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: location.icon).foregroundStyle(location.color).frame(width: 20)
                Text(location.name).font(.body.weight(.medium))
                Spacer()
                Image(systemName: selectedIDs.contains(location.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedIDs.contains(location.id) ? location.color : .secondary)
                    .font(.title3)
            }
        }
        .buttonStyle(.plain)
    }
}
