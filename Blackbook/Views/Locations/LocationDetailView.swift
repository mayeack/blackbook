import SwiftUI
import SwiftData

struct LocationDetailView: View {
    @Environment(\.modelContext) private var modelContext
    @Bindable var location: Location
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Tag.name) private var allTags: [Tag]
    @Query(sort: \Group.name) private var allGroups: [Group]
    @State private var showEditLocation = false
    @State private var showAddContacts = false
    @State private var showDeleteConfirmation = false
    @State private var searchText = ""
    @State private var selectedTagFilter: Set<UUID> = []
    @State private var selectedGroupFilter: Set<UUID> = []

    private var sortedContacts: [Contact] {
        var contacts = location.contacts.filter { !$0.isHidden && !$0.isMergedAway }
        if !selectedTagFilter.isEmpty {
            contacts = contacts.filter { c in c.tags.contains { selectedTagFilter.contains($0.id) } }
        }
        if !selectedGroupFilter.isEmpty {
            contacts = contacts.filter { c in c.groups.contains { selectedGroupFilter.contains($0.id) } }
        }
        contacts = contacts.sorted {
            let cmp = $0.lastName.localizedCaseInsensitiveCompare($1.lastName)
            if cmp != .orderedSame { return cmp == .orderedAscending }
            return $0.firstName.localizedCaseInsensitiveCompare($1.firstName) == .orderedAscending
        }
        if searchText.isEmpty { return contacts }
        return contacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(searchText)
            || ($0.company?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    private var relevantTags: [Tag] {
        let memberTagIDs = Set(location.contacts.flatMap { $0.tags.map(\.id) })
        return allTags.filter { memberTagIDs.contains($0.id) }
    }

    private var relevantGroups: [Group] {
        let memberGroupIDs = Set(location.contacts.flatMap { $0.groups.map(\.id) })
        return allGroups.filter { memberGroupIDs.contains($0.id) }
    }

    var body: some View {
        List {
            headerSection
            membersSection
        }
        .navigationDestination(for: ContactNavigationID.self) { nav in
            if let contact = location.contacts.first(where: { $0.id == nav.id }) {
                ContactDetailView(contact: contact)
            }
        }
        .navigationTitle(location.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .searchable(text: $searchText, prompt: "Search members...")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { showEditLocation = true } label: {
                        Label("Edit Location", systemImage: "pencil")
                    }
                    Button { showAddContacts = true } label: {
                        Label("Add Contacts", systemImage: "person.badge.plus")
                    }
                    Divider()
                    Button(role: .destructive) { showDeleteConfirmation = true } label: {
                        Label("Delete Location", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .sheet(isPresented: $showEditLocation) { LocationFormView(location: location) }
        .sheet(isPresented: $showAddContacts) { AddContactsToLocationView(location: location) }
        .alert("Delete Location", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) {
                modelContext.delete(location)
                try? modelContext.save()
                dismiss()
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Are you sure you want to delete \"\(location.name)\"? This will not delete any contacts.")
        }
    }

    private var headerSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: location.icon)
                    .font(.body)
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(location.color.gradient, in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 4) {
                    Text(location.name)
                        .font(.title.weight(.bold))
                    Text("\(location.contacts.count) contact\(location.contacts.count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.vertical, 4)
        }
    }

    private var membersSection: some View {
        Section {
            Button { showAddContacts = true } label: {
                Label("Add Contacts", systemImage: "person.badge.plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppConstants.UI.accentGold)
            .listRowBackground(Color.clear)

            if !relevantTags.isEmpty || !relevantGroups.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(relevantTags) { tag in
                            TagChipView(tag: tag, isSelected: selectedTagFilter.contains(tag.id)) {
                                if selectedTagFilter.contains(tag.id) { selectedTagFilter.remove(tag.id) }
                                else { selectedTagFilter.insert(tag.id) }
                            }
                        }
                        ForEach(relevantGroups) { group in
                            GroupChipView(group: group, isSelected: selectedGroupFilter.contains(group.id)) {
                                if selectedGroupFilter.contains(group.id) { selectedGroupFilter.remove(group.id) }
                                else { selectedGroupFilter.insert(group.id) }
                            }
                        }
                    }
                }
                .listRowSeparator(.hidden)
            }

            if sortedContacts.isEmpty && !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if !sortedContacts.isEmpty {
                ForEach(sortedContacts) { contact in
                    NavigationLink(value: ContactNavigationID(id: contact.id)) {
                        ContactRowView(contact: contact, showScore: false)
                    }
                    .swipeActions(edge: .trailing) {
                        Button {
                            location.contacts.removeAll { $0.id == contact.id }
                            try? modelContext.save()
                        } label: {
                            Label("Remove", systemImage: "person.badge.minus")
                        }
                        .tint(.orange)
                    }
                }
            }
        } header: {
            Text("Contacts")
        }
    }
}

// MARK: - Add Contacts to Location

struct AddContactsToLocationView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Contact.lastName) private var allContacts: [Contact]
    let location: Location
    @State private var selectedIDs: Set<UUID> = []
    @State private var searchText = ""

    private var memberIDs: Set<UUID> {
        Set(location.contacts.map(\.id))
    }

    private var nonMembers: [Contact] {
        allContacts.filter { !$0.isHidden && !$0.isMergedAway && !memberIDs.contains($0.id) }.sorted {
            let lhs = $0.lastName.isEmpty
            let rhs = $1.lastName.isEmpty
            if lhs != rhs { return rhs }
            let lastCmp = $0.lastName.localizedCaseInsensitiveCompare($1.lastName)
            if lastCmp != .orderedSame { return lastCmp == .orderedAscending }
            return $0.firstName.localizedCaseInsensitiveCompare($1.firstName) == .orderedAscending
        }
    }

    private var suggestedContacts: [Contact] {
        guard !location.contacts.isEmpty else { return [] }

        let memberLocationIDs = Set(location.contacts.flatMap { $0.locations.map(\.id) })
        let memberGroupIDs = Set(location.contacts.flatMap { $0.groups.map(\.id) })

        let scored: [(Contact, Int)] = nonMembers.compactMap { contact in
            let locationOverlap = contact.locations.filter { memberLocationIDs.contains($0.id) }.count
            let groupOverlap = contact.groups.filter { memberGroupIDs.contains($0.id) }.count
            let score = locationOverlap + groupOverlap
            return score > 0 ? (contact, score) : nil
        }

        return scored
            .sorted { $0.1 > $1.1 }
            .prefix(5)
            .map(\.0)
    }

    private var filteredNonMembers: [Contact] {
        if searchText.isEmpty { return nonMembers }
        return nonMembers.filter {
            $0.displayName.localizedCaseInsensitiveContains(searchText)
            || ($0.company?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search contacts…", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                        #if os(macOS)
                        .padding(.vertical, 4)
                        #endif
                }

                if !suggestedContacts.isEmpty && searchText.isEmpty {
                    Section("Suggested") {
                        ForEach(suggestedContacts) { contact in
                            contactRow(contact)
                        }
                    }
                }

                Section(searchText.isEmpty ? "All Contacts" : "Results") {
                    if filteredNonMembers.isEmpty {
                        ContentUnavailableView {
                            Label("No Contacts", systemImage: "person.slash")
                        } description: {
                            Text(searchText.isEmpty
                                 ? "All contacts are already at this location."
                                 : "No matching contacts found.")
                        }
                    } else {
                        ForEach(filteredNonMembers) { contact in
                            contactRow(contact)
                        }
                    }
                }
            }
            .navigationTitle("Add to \(location.name)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add (\(selectedIDs.count))") {
                        for contact in allContacts where selectedIDs.contains(contact.id) {
                            if !location.contacts.contains(where: { $0.id == contact.id }) {
                                location.contacts.append(contact)
                            }
                        }
                        try? modelContext.save()
                        dismiss()
                    }
                    .disabled(selectedIDs.isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 450, idealWidth: 500, minHeight: 500, idealHeight: 600)
        #endif
    }

    private func contactRow(_ contact: Contact) -> some View {
        Button {
            if selectedIDs.contains(contact.id) {
                selectedIDs.remove(contact.id)
            } else {
                selectedIDs.insert(contact.id)
            }
        } label: {
            HStack(spacing: 12) {
                ContactAvatarView(contact: contact, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.displayName)
                        .font(.body.weight(.medium))
                    if let company = contact.company {
                        Text(company)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Image(systemName: selectedIDs.contains(contact.id) ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selectedIDs.contains(contact.id) ? AppConstants.UI.accentGold : .secondary)
            }
        }
        .buttonStyle(.plain)
    }
}
