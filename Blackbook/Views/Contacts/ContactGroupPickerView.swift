import SwiftUI
import SwiftData

struct ContactGroupPickerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Bindable var contact: Contact
    let allGroups: [Group]
    @State private var selectedIDs: Set<UUID> = []
    @State private var searchText = ""

    private var suggestedGroups: [Group] {
        let currentIDs = selectedIDs
        let candidates = allGroups.filter { !currentIDs.contains($0.id) && !$0.contacts.isEmpty }
        let contactTagIDs = Set(contact.tags.map(\.id))
        let contactGroupIDs = Set(contact.groups.map(\.id))
        let contactLocationIDs = Set(contact.locations.map(\.id))
        let contactInterests = Set(contact.interests.map { $0.lowercased() })
        let contactCompany = contact.company?.lowercased()

        let scored: [(Group, Int)] = candidates.compactMap { group in
            var score = 0
            for member in group.contacts where member.id != contact.id {
                if let mc = member.company?.lowercased(), let cc = contactCompany, mc == cc { score += 3 }
                score += member.tags.filter { contactTagIDs.contains($0.id) }.count * 2
                score += member.groups.filter { contactGroupIDs.contains($0.id) }.count
                score += member.interests.filter { contactInterests.contains($0.lowercased()) }.count
                score += member.locations.filter { contactLocationIDs.contains($0.id) }.count
            }
            return score > 0 ? (group, score) : nil
        }
        return scored.sorted { $0.1 > $1.1 }.prefix(5).map(\.0)
    }

    private var filteredGroups: [Group] {
        let suggestedIDs = searchText.isEmpty ? Set(suggestedGroups.map(\.id)) : []
        let base = allGroups.filter { !selectedIDs.contains($0.id) && !suggestedIDs.contains($0.id) }
        if searchText.isEmpty { return base }
        return base.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var selectedGroups: [Group] {
        allGroups.filter { selectedIDs.contains($0.id) }.sorted { $0.name < $1.name }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search groups…", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                        #if os(macOS)
                        .padding(.vertical, 4)
                        #endif
                }

                if !selectedGroups.isEmpty {
                    Section("Selected") {
                        ForEach(selectedGroups) { group in
                            groupRow(group, isSelected: true)
                        }
                    }
                }

                if !suggestedGroups.isEmpty && searchText.isEmpty {
                    Section("Suggested") {
                        ForEach(suggestedGroups) { group in
                            groupRow(group, isSelected: false)
                        }
                    }
                }

                Section(searchText.isEmpty ? "All Groups" : "Results") {
                    if filteredGroups.isEmpty {
                        ContentUnavailableView {
                            Label("No Groups", systemImage: "folder.slash")
                        } description: {
                            Text(searchText.isEmpty
                                 ? "All groups are already assigned."
                                 : "No matching groups found.")
                        }
                    } else {
                        ForEach(filteredGroups) { group in
                            groupRow(group, isSelected: false)
                        }
                    }
                }
            }
            .navigationTitle("Manage Groups")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        contact.groups = allGroups.filter { selectedIDs.contains($0.id) }
                        contact.updatedAt = Date()
                        try? modelContext.save()
                        dismiss()
                    }.fontWeight(.semibold)
                }
            }
            .onAppear {
                selectedIDs = Set(contact.groups.map(\.id))
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 450, idealHeight: 550)
        #endif
    }

    private func groupRow(_ group: Group, isSelected: Bool) -> some View {
        Button {
            if selectedIDs.contains(group.id) {
                selectedIDs.remove(group.id)
            } else {
                selectedIDs.insert(group.id)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: group.icon).foregroundStyle(group.color).frame(width: 20)
                Text(group.name).font(.body.weight(.medium))
                Spacer()
                Image(systemName: selectedIDs.contains(group.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedIDs.contains(group.id) ? group.color : .secondary)
                    .font(.title3)
            }
        }
        .buttonStyle(.plain)
    }
}
