import SwiftUI
import SwiftData

struct ContactTagPickerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Bindable var contact: Contact
    let allTags: [Tag]
    @State private var selectedIDs: Set<UUID> = []
    @State private var searchText = ""

    private var candidateTags: [Tag] {
        allTags.filter { !selectedIDs.contains($0.id) }
    }

    private var suggestedTags: [Tag] {
        let currentIDs = selectedIDs
        let candidates = allTags.filter { !currentIDs.contains($0.id) && !$0.contacts.isEmpty }
        let contactTagIDs = Set(contact.tags.map(\.id))
        let contactGroupIDs = Set(contact.groups.map(\.id))
        let contactLocationIDs = Set(contact.locations.map(\.id))
        let contactInterests = Set(contact.interests.map { $0.lowercased() })
        let contactCompany = contact.company?.lowercased()

        let scored: [(Tag, Int)] = candidates.compactMap { tag in
            var score = 0
            for member in tag.contacts where member.id != contact.id {
                if let mc = member.company?.lowercased(), let cc = contactCompany, mc == cc { score += 3 }
                score += member.groups.filter { contactGroupIDs.contains($0.id) }.count * 2
                score += member.tags.filter { contactTagIDs.contains($0.id) }.count
                score += member.interests.filter { contactInterests.contains($0.lowercased()) }.count
                score += member.locations.filter { contactLocationIDs.contains($0.id) }.count
            }
            return score > 0 ? (tag, score) : nil
        }
        return scored.sorted { $0.1 > $1.1 }.prefix(5).map(\.0)
    }

    private var filteredTags: [Tag] {
        let suggestedIDs = searchText.isEmpty ? Set(suggestedTags.map(\.id)) : []
        let base = allTags.filter { !selectedIDs.contains($0.id) && !suggestedIDs.contains($0.id) }
        if searchText.isEmpty { return base }
        return base.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var selectedTags: [Tag] {
        allTags.filter { selectedIDs.contains($0.id) }.sorted { $0.name < $1.name }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search tags…", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                        #if os(macOS)
                        .padding(.vertical, 4)
                        #endif
                }

                if !selectedTags.isEmpty {
                    Section("Selected") {
                        ForEach(selectedTags) { tag in
                            tagRow(tag, isSelected: true)
                        }
                    }
                }

                if !suggestedTags.isEmpty && searchText.isEmpty {
                    Section("Suggested") {
                        ForEach(suggestedTags) { tag in
                            tagRow(tag, isSelected: false)
                        }
                    }
                }

                Section(searchText.isEmpty ? "All Tags" : "Results") {
                    if filteredTags.isEmpty {
                        ContentUnavailableView {
                            Label("No Tags", systemImage: "tag.slash")
                        } description: {
                            Text(searchText.isEmpty
                                 ? "All tags are already assigned."
                                 : "No matching tags found.")
                        }
                    } else {
                        ForEach(filteredTags) { tag in
                            tagRow(tag, isSelected: false)
                        }
                    }
                }
            }
            .navigationTitle("Manage Tags")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        contact.tags = allTags.filter { selectedIDs.contains($0.id) }
                        contact.updatedAt = Date()
                        try? modelContext.save()
                        dismiss()
                    }.fontWeight(.semibold)
                }
            }
            .onAppear {
                selectedIDs = Set(contact.tags.map(\.id))
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 450, idealHeight: 550)
        #endif
    }

    private func tagRow(_ tag: Tag, isSelected: Bool) -> some View {
        Button {
            if selectedIDs.contains(tag.id) {
                selectedIDs.remove(tag.id)
            } else {
                selectedIDs.insert(tag.id)
            }
        } label: {
            HStack(spacing: 12) {
                Circle().fill(tag.color).frame(width: 14, height: 14)
                Text(tag.name).font(.body.weight(.medium))
                Spacer()
                Image(systemName: selectedIDs.contains(tag.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedIDs.contains(tag.id) ? tag.color : .secondary)
                    .font(.title3)
            }
        }
        .buttonStyle(.plain)
    }
}
