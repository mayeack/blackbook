import SwiftUI
import SwiftData

struct ActivityDetailView: View {
    @Environment(\.modelContext) private var modelContext
    @Bindable var activity: Activity
    @State private var showEditActivity = false
    @State private var showAddContacts = false
    @State private var showAddGroups = false

    var body: some View {
        List {
            headerSection
            descriptionSection
            groupsSection
            contactsSection
        }
        .navigationDestination(for: ContactNavigationID.self) { nav in
            if let contact = activity.contacts.first(where: { $0.id == nav.id }) {
                ContactDetailView(contact: contact)
            }
        }
        .navigationTitle(activity.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { showEditActivity = true } label: {
                        Label("Edit Activity", systemImage: "pencil")
                    }
                    Button { showAddGroups = true } label: {
                        Label("Add Groups", systemImage: "folder.badge.plus")
                    }
                    Button { showAddContacts = true } label: {
                        Label("Add Contacts", systemImage: "person.badge.plus")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .sheet(isPresented: $showEditActivity) { ActivityFormView(activity: activity) }
        .sheet(isPresented: $showAddContacts) { AddContactsToActivityView(activity: activity) }
        .sheet(isPresented: $showAddGroups) { AddGroupsToActivityView(activity: activity) }
    }

    private var headerSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: activity.icon)
                    .font(.body)
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(activity.color.gradient, in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text(activity.name)
                        .font(.body.weight(.medium))
                    Text(activity.dateRange)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private var descriptionSection: some View {
        if !activity.activityDescription.isEmpty {
            Section("Description") {
                Text(activity.activityDescription)
                    .font(.body)
            }
        }
    }

    private var groupsSection: some View {
        Section {
            let sorted = activity.groups.sorted { $0.name < $1.name }
            if sorted.isEmpty {
                Button { showAddGroups = true } label: {
                    Label("Add Groups", systemImage: "folder.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppConstants.UI.accentGold)
                .listRowBackground(Color.clear)
            } else {
                ForEach(sorted) { group in
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
                    .swipeActions(edge: .trailing) {
                        Button {
                            activity.groups.removeAll { $0.id == group.id }
                            try? modelContext.save()
                        } label: {
                            Label("Remove", systemImage: "folder.badge.minus")
                        }
                        .tint(.orange)
                    }
                }
            }
        } header: {
            Text("Groups")
        }
    }

    private var contactsSection: some View {
        Section {
            Button { showAddContacts = true } label: {
                Label("Add Contacts", systemImage: "person.badge.plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppConstants.UI.accentGold)
            .listRowBackground(Color.clear)

            let sorted = activity.contacts.filter { !$0.isHidden && !$0.isMergedAway }.sorted { $0.lastName < $1.lastName }
            if !sorted.isEmpty {
                ForEach(sorted) { contact in
                    NavigationLink(value: ContactNavigationID(id: contact.id)) {
                        ContactRowView(contact: contact, showScore: false)
                    }
                    .swipeActions(edge: .trailing) {
                        Button {
                            activity.contacts.removeAll { $0.id == contact.id }
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

// MARK: - Add Contacts to Activity

struct AddContactsToActivityView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Contact.lastName) private var allContacts: [Contact]
    let activity: Activity
    @State private var selectedIDs: Set<UUID> = []
    @State private var searchText = ""

    private var memberIDs: Set<UUID> {
        Set(activity.contacts.map(\.id))
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
                    TextField("Search contacts\u{2026}", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                        #if os(macOS)
                        .padding(.vertical, 4)
                        #endif
                }

                Section(searchText.isEmpty ? "All Contacts" : "Results") {
                    if filteredNonMembers.isEmpty {
                        ContentUnavailableView {
                            Label("No Contacts", systemImage: "person.slash")
                        } description: {
                            Text(searchText.isEmpty
                                 ? "All contacts are already in this activity."
                                 : "No matching contacts found.")
                        }
                    } else {
                        ForEach(filteredNonMembers) { contact in
                            contactRow(contact)
                        }
                    }
                }
            }
            .navigationTitle("Add to \(activity.name)")
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
                            if !activity.contacts.contains(where: { $0.id == contact.id }) {
                                activity.contacts.append(contact)
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

// MARK: - Add Groups to Activity

struct AddGroupsToActivityView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Group.name) private var allGroups: [Group]
    let activity: Activity
    @State private var selectedIDs: Set<UUID> = []
    @State private var searchText = ""

    private var memberIDs: Set<UUID> {
        Set(activity.groups.map(\.id))
    }

    private var nonMembers: [Group] {
        allGroups.filter { !memberIDs.contains($0.id) }
    }

    private var filteredNonMembers: [Group] {
        if searchText.isEmpty { return nonMembers }
        return nonMembers.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Search groups\u{2026}", text: $searchText)
                        .textFieldStyle(.roundedBorder)
                        #if os(macOS)
                        .padding(.vertical, 4)
                        #endif
                }

                Section(searchText.isEmpty ? "All Groups" : "Results") {
                    if filteredNonMembers.isEmpty {
                        ContentUnavailableView {
                            Label("No Groups", systemImage: "folder")
                        } description: {
                            Text(searchText.isEmpty
                                 ? "All groups are already in this activity."
                                 : "No matching groups found.")
                        }
                    } else {
                        ForEach(filteredNonMembers) { group in
                            groupRow(group)
                        }
                    }
                }
            }
            .navigationTitle("Add Groups")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add (\(selectedIDs.count))") {
                        for group in allGroups where selectedIDs.contains(group.id) {
                            if !activity.groups.contains(where: { $0.id == group.id }) {
                                activity.groups.append(group)
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

    private func groupRow(_ group: Group) -> some View {
        Button {
            if selectedIDs.contains(group.id) {
                selectedIDs.remove(group.id)
            } else {
                selectedIDs.insert(group.id)
            }
        } label: {
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
                Image(systemName: selectedIDs.contains(group.id) ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selectedIDs.contains(group.id) ? AppConstants.UI.accentGold : .secondary)
            }
        }
        .buttonStyle(.plain)
    }
}
