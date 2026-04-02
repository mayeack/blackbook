import SwiftUI
import SwiftData

private enum ColumnWidth {
    static let groups: CGFloat = 100
    static let locations: CGFloat = 100
    static let tags: CGFloat = 90
    static let metVia: CGFloat = 100
    static let introducedTo: CGFloat = 110
    static let score: CGFloat = 70
}

enum ContactEditableColumn: String, Identifiable {
    case groups = "Groups"
    case locations = "Locations"
    case tags = "Tags"
    case metVia = "Met via"
    case introducedTo = "Introduced to"
    var id: String { rawValue }
}

private struct ColumnEditTarget: Identifiable {
    let id = UUID()
    let contact: Contact
    let column: ContactEditableColumn
}

struct ContactListView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Contact.lastName) private var contacts: [Contact]
    @Query(sort: \Tag.name) private var tags: [Tag]
    @Query(sort: \Group.name) private var groups: [Group]
    @Query(sort: \Location.name) private var locations: [Location]
    @State private var viewModel = ContactListViewModel()
    @State private var showAddContact = false
    @State private var columnEditTarget: ColumnEditTarget?
    @State private var contactToDelete: Contact?
    @State private var contactToHide: Contact?
    @State private var expandedFilters: Set<String> = []

    private var contactsByID: [UUID: Contact] {
        Dictionary(uniqueKeysWithValues: contacts.map { ($0.id, $0) })
    }

    var body: some View {
        NavigationStack {
            let filtered = viewModel.filteredContacts(contacts, tags: tags, groups: groups, locations: locations)
            SwiftUI.Group {
                if filtered.isEmpty {
                    ContentUnavailableView {
                        Label("No Contacts", systemImage: "person.crop.rectangle.stack")
                    } description: {
                        Text("Add contacts manually or import from your address book.")
                    } actions: {
                        Button("Add Contact") { showAddContact = true }
                            .buttonStyle(.borderedProminent)
                            .tint(AppConstants.UI.accentGold)
                    }
                } else {
                    List {
                        if !tags.isEmpty || !groups.isEmpty || !locations.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                if !tags.isEmpty {
                                    CollapsibleFilterSection(
                                        title: "Tags",
                                        isExpanded: expandedFilters.contains("Tags"),
                                        activeCount: viewModel.selectedTags.count,
                                        onToggle: { toggleFilter("Tags") }
                                    ) {
                                        FlowLayout(spacing: 8) {
                                            ForEach(tags) { tag in
                                                TagChipView(tag: tag, isSelected: viewModel.selectedTags.contains(tag.id)) {
                                                    if viewModel.selectedTags.contains(tag.id) { viewModel.selectedTags.remove(tag.id) }
                                                    else { viewModel.selectedTags.insert(tag.id) }
                                                }
                                            }
                                        }
                                    }
                                }
                                if !groups.isEmpty {
                                    CollapsibleFilterSection(
                                        title: "Groups",
                                        isExpanded: expandedFilters.contains("Groups"),
                                        activeCount: viewModel.selectedGroups.count,
                                        onToggle: { toggleFilter("Groups") }
                                    ) {
                                        FlowLayout(spacing: 8) {
                                            ForEach(groups) { group in
                                                GroupChipView(group: group, isSelected: viewModel.selectedGroups.contains(group.id)) {
                                                    if viewModel.selectedGroups.contains(group.id) { viewModel.selectedGroups.remove(group.id) }
                                                    else { viewModel.selectedGroups.insert(group.id) }
                                                }
                                            }
                                        }
                                    }
                                }
                                if !locations.isEmpty {
                                    CollapsibleFilterSection(
                                        title: "Locations",
                                        isExpanded: expandedFilters.contains("Locations"),
                                        activeCount: viewModel.selectedLocations.count,
                                        onToggle: { toggleFilter("Locations") }
                                    ) {
                                        FlowLayout(spacing: 8) {
                                            ForEach(locations) { location in
                                                LocationChipView(location: location, isSelected: viewModel.selectedLocations.contains(location.id)) {
                                                    if viewModel.selectedLocations.contains(location.id) { viewModel.selectedLocations.remove(location.id) }
                                                    else { viewModel.selectedLocations.insert(location.id) }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                            .listRowSeparator(.hidden)
                        }

                        Section {
                            ForEach(filtered) { contact in
                                NavigationLink(value: contact.id) {
                                    ContactRowView(contact: contact) { column in
                                        columnEditTarget = ColumnEditTarget(contact: contact, column: column)
                                    }
                                }
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) { contactToDelete = contact }
                                    label: { Label("Delete", systemImage: "trash") }
                                }
                                .swipeActions(edge: .leading) {
                                    Button { contactToHide = contact } label: {
                                        Label("Hide", systemImage: "eye.slash")
                                    }
                                    .tint(.gray)
                                }
                            }
                        } header: {
                            ContactTableHeaderView()
                                .textCase(nil)
                        }
                    }
                    .navigationDestination(for: UUID.self) { id in
                        if let c = contactsByID[id] { ContactDetailView(contact: c) }
                    }
                }
            }
            .navigationTitle("Contacts")
            #if os(iOS)
            .searchable(text: $viewModel.searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search contacts...")
            #else
            .searchable(text: $viewModel.searchText, prompt: "Search contacts...")
            #endif
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button { showAddContact = true } label: { Image(systemName: "plus") } }
                ToolbarItem(placement: .automatic) {
                    Menu {
                        Picker("Sort", selection: $viewModel.sortOrder) {
                            ForEach(ContactListViewModel.ContactSortOrder.allCases) { Text($0.rawValue).tag($0) }
                        }
                        Divider()
                        NavigationLink { SmartGroupsView() } label: { Label("Smart Groups", systemImage: "folder.badge.gearshape") }
                    } label: { Image(systemName: "arrow.up.arrow.down.circle") }
                }
            }
            .sheet(isPresented: $showAddContact) { ContactFormView(contact: nil) }
            .sheet(item: $columnEditTarget) { target in
                if target.column == .metVia {
                    MetViaPickerView(contact: target.contact, allContacts: contacts)
                } else if target.column == .introducedTo {
                    IntroducedToPickerView(contact: target.contact, allContacts: contacts)
                } else {
                    ContactFieldToggleSheet(contact: target.contact, column: target.column)
                }
            }
            .alert(
                "Delete Contact?",
                isPresented: Binding(
                    get: { contactToDelete != nil },
                    set: { if !$0 { contactToDelete = nil } }
                ),
                presenting: contactToDelete
            ) { contact in
                Button("Cancel", role: .cancel) { contactToDelete = nil }
                Button("Delete", role: .destructive) {
                    modelContext.delete(contact)
                    try? modelContext.save()
                    contactToDelete = nil
                }
            } message: { contact in
                Text("Are you sure you want to delete \(contact.displayName)? This action cannot be undone.")
            }
            .alert(
                "Hide Contact?",
                isPresented: Binding(
                    get: { contactToHide != nil },
                    set: { if !$0 { contactToHide = nil } }
                ),
                presenting: contactToHide
            ) { contact in
                Button("Cancel", role: .cancel) { contactToHide = nil }
                Button("Hide", role: .destructive) {
                    contact.isHidden = true
                    contact.updatedAt = Date()
                    try? modelContext.save()
                    contactToHide = nil
                }
            } message: { contact in
                Text("\(contact.displayName) will be hidden from all lists. You can unhide them from Settings > Hidden Contacts.")
            }
        }
    }

    private func toggleFilter(_ key: String) {
        withAnimation(.easeInOut(duration: 0.25)) {
            if expandedFilters.contains(key) {
                expandedFilters.remove(key)
            } else {
                expandedFilters.insert(key)
            }
        }
    }
}

// MARK: - Collapsible Filter Section

struct CollapsibleFilterSection<Content: View>: View {
    let title: String
    let isExpanded: Bool
    let activeCount: Int
    let onToggle: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    if activeCount > 0 {
                        Text("\(activeCount)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(AppConstants.UI.accentGold, in: Capsule())
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                content
                    .padding(.leading, 4)
            }
        }
    }
}

// MARK: - Table Header

struct ContactTableHeaderView: View {
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    private var isCompact: Bool {
        #if os(iOS)
        return sizeClass == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        if !isCompact {
            HStack(spacing: 0) {
                Text("Name")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Groups")
                    .frame(width: ColumnWidth.groups, alignment: .leading)
                Text("Locations")
                    .frame(width: ColumnWidth.locations, alignment: .leading)
                Text("Tags")
                    .frame(width: ColumnWidth.tags, alignment: .leading)
                Text("Met via")
                    .frame(width: ColumnWidth.metVia, alignment: .leading)
                Text("Introduced to")
                    .frame(width: ColumnWidth.introducedTo, alignment: .leading)
                Text("Score")
                    .frame(width: ColumnWidth.score, alignment: .trailing)
            }
            .font(.title3.weight(.bold))
            .foregroundStyle(.primary)
        }
    }
}

// MARK: - Contact Row

struct ContactRowView: View {
    let contact: Contact
    var showScore: Bool = true
    var onColumnTap: ((ContactEditableColumn) -> Void)? = nil
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    private var isCompact: Bool {
        #if os(iOS)
        return sizeClass == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        if isCompact {
            compactLayout
        } else {
            expandedLayout
        }
    }

    private var compactLayout: some View {
        HStack(spacing: 12) {
            ContactAvatarView(contact: contact, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(contact.displayName).font(.body.weight(.medium))
                if let co = contact.company { Text(co).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                if showScore {
                    HStack(spacing: 4) {
                        ScoreTrendArrow(trend: contact.scoreTrend)
                        ScoreBadgeView(score: contact.relationshipScore)
                    }
                }
                if let d = contact.lastInteractionDate { Text(d.relativeDescription).font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .padding(.vertical, 2)
    }

    private var expandedLayout: some View {
        HStack(spacing: 0) {
            HStack(spacing: 10) {
                ContactAvatarView(contact: contact, size: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text(contact.displayName).font(.body.weight(.medium)).lineLimit(1)
                    if let co = contact.company { Text(co).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button { onColumnTap?(.groups) } label: {
                PillsColumnView(pills: contact.groups.map { PillData(id: $0.id, name: $0.name, color: $0.color) })
            }
            .buttonStyle(.borderless)
            .frame(width: ColumnWidth.groups, alignment: .leading)

            Button { onColumnTap?(.locations) } label: {
                PillsColumnView(pills: contact.locations.map { PillData(id: $0.id, name: $0.name, color: $0.color) })
            }
            .buttonStyle(.borderless)
            .frame(width: ColumnWidth.locations, alignment: .leading)

            Button { onColumnTap?(.tags) } label: {
                PillsColumnView(pills: contact.tags.map { PillData(id: $0.id, name: $0.name, color: $0.color) })
            }
            .buttonStyle(.borderless)
            .frame(width: ColumnWidth.tags, alignment: .leading)

            Button { onColumnTap?(.metVia) } label: {
                if let metVia = contact.metVia {
                    Text(metVia.displayName)
                        .font(.caption2.weight(.medium))
                        .lineLimit(1)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.12), in: Capsule())
                } else {
                    Text("—")
                        .font(.callout)
                        .foregroundStyle(.quaternary)
                        .frame(minWidth: 28, minHeight: 24)
                        .contentShape(Rectangle())
                }
            }
            .buttonStyle(.borderless)
            .frame(width: ColumnWidth.metVia, alignment: .leading)

            Button { onColumnTap?(.introducedTo) } label: {
                let backlinks = contact.metViaBacklinks
                if backlinks.isEmpty {
                    Text("—")
                        .font(.callout)
                        .foregroundStyle(.quaternary)
                        .frame(minWidth: 28, minHeight: 24)
                        .contentShape(Rectangle())
                } else {
                    PillsColumnView(pills: backlinks.map { PillData(id: $0.id, name: $0.displayName, color: .secondary) })
                }
            }
            .buttonStyle(.borderless)
            .frame(width: ColumnWidth.introducedTo, alignment: .leading)

            if showScore {
                HStack(spacing: 4) {
                    ScoreTrendArrow(trend: contact.scoreTrend)
                    ScoreBadgeView(score: contact.relationshipScore)
                }
                .frame(width: ColumnWidth.score, alignment: .trailing)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Pills Column

struct PillData: Identifiable {
    let id: UUID
    let name: String
    let color: Color
}

struct PillsColumnView: View {
    let pills: [PillData]
    private let maxVisible = 2

    var body: some View {
        if pills.isEmpty {
            Text("—")
                .font(.callout)
                .foregroundStyle(.quaternary)
                .frame(minWidth: 28, minHeight: 24)
                .contentShape(Rectangle())
        } else {
            HStack(spacing: 3) {
                ForEach(pills.prefix(maxVisible)) { pill in
                    Text(pill.name)
                        .font(.caption2.weight(.medium))
                        .lineLimit(1)
                        .foregroundStyle(pill.color)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(pill.color.opacity(0.12), in: Capsule())
                }
                if pills.count > maxVisible {
                    Text("+\(pills.count - maxVisible)")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Score Trend Arrow

struct ScoreTrendArrow: View {
    let trend: ScoreTrend

    var body: some View {
        switch trend {
        case .up:
            Image(systemName: "arrow.up")
                .font(.caption2.weight(.bold))
                .foregroundStyle(AppConstants.UI.strongGreen)
        case .down:
            Image(systemName: "arrow.down")
                .font(.caption2.weight(.bold))
                .foregroundStyle(AppConstants.UI.fadingRed)
        case .stable:
            EmptyView()
        }
    }
}

// MARK: - Avatar

struct ContactAvatarView: View {
    let contact: Contact; let size: CGFloat
    var body: some View {
        SwiftUI.Group {
            if let data = contact.photoData {
                #if os(iOS)
                if let img = UIImage(data: data) { Image(uiImage: img).resizable().scaledToFill() }
                #else
                if let img = NSImage(data: data) { Image(nsImage: img).resizable().scaledToFill() }
                #endif
            } else {
                Text(contact.initials).font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(AppConstants.UI.accentGold.gradient)
            }
        }
        .frame(width: size, height: size).clipShape(Circle())
    }
}

// MARK: - Score Badge

struct ScoreBadgeView: View {
    let score: Double
    var body: some View {
        Text("\(Int(score))").font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(.white)
            .padding(.horizontal, 8).padding(.vertical, 2).background(AppConstants.UI.scoreColor(for: score), in: Capsule())
    }
}

// MARK: - Filter Row

struct FilterRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Text(label)
                .font(.title3.weight(.bold))
                .foregroundStyle(.primary)
                .frame(width: 80, alignment: .leading)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) { content }
            }
        }
    }
}

// MARK: - Filter Chips

struct TagChipView: View {
    let tag: Tag; let isSelected: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(tag.name).font(.caption.weight(.medium)).foregroundStyle(isSelected ? .white : tag.color)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(isSelected ? AnyShapeStyle(tag.color) : AnyShapeStyle(tag.color.opacity(0.15)), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct GroupChipView: View {
    let group: Group; let isSelected: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: group.icon).font(.caption2)
                Text(group.name).font(.caption.weight(.medium))
            }
            .foregroundStyle(isSelected ? .white : group.color)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(isSelected ? AnyShapeStyle(group.color) : AnyShapeStyle(group.color.opacity(0.15)), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct LocationChipView: View {
    let location: Location; let isSelected: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: location.icon).font(.caption2)
                Text(location.name).font(.caption.weight(.medium))
            }
            .foregroundStyle(isSelected ? .white : location.color)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(isSelected ? AnyShapeStyle(location.color) : AnyShapeStyle(location.color.opacity(0.15)), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Field Toggle Sheet

struct ContactFieldToggleSheet: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Bindable var contact: Contact
    let column: ContactEditableColumn
    @Query(sort: \Group.name) private var allGroups: [Group]
    @Query(sort: \Tag.name) private var allTags: [Tag]
    @Query(sort: \Location.name) private var allLocations: [Location]

    var body: some View {
        NavigationStack {
            List {
                switch column {
                case .groups:
                    if allGroups.isEmpty {
                        ContentUnavailableView("No Groups", systemImage: "folder", description: Text("Create groups in the Groups tab."))
                    } else {
                        ForEach(allGroups) { group in
                            let isSelected = contact.groups.contains(where: { $0.id == group.id })
                            Button {
                                if isSelected { contact.groups.removeAll { $0.id == group.id } }
                                else { contact.groups.append(group) }
                                contact.updatedAt = Date()
                                try? modelContext.save()
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: group.icon).foregroundStyle(group.color).frame(width: 20)
                                    Text(group.name)
                                    Spacer()
                                    if isSelected { Image(systemName: "checkmark").foregroundStyle(AppConstants.UI.accentGold) }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                case .tags:
                    if allTags.isEmpty {
                        ContentUnavailableView("No Tags", systemImage: "tag", description: Text("Create tags in the Tags tab."))
                    } else {
                        ForEach(allTags) { tag in
                            let isSelected = contact.tags.contains(where: { $0.id == tag.id })
                            Button {
                                if isSelected { contact.tags.removeAll { $0.id == tag.id } }
                                else { contact.tags.append(tag) }
                                contact.updatedAt = Date()
                                try? modelContext.save()
                            } label: {
                                HStack(spacing: 10) {
                                    Circle().fill(tag.color).frame(width: 10, height: 10)
                                    Text(tag.name)
                                    Spacer()
                                    if isSelected { Image(systemName: "checkmark").foregroundStyle(AppConstants.UI.accentGold) }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                case .locations:
                    if allLocations.isEmpty {
                        ContentUnavailableView("No Locations", systemImage: "mappin", description: Text("Create locations in the Locations tab."))
                    } else {
                        ForEach(allLocations) { location in
                            let isSelected = contact.locations.contains(where: { $0.id == location.id })
                            Button {
                                if isSelected { contact.locations.removeAll { $0.id == location.id } }
                                else { contact.locations.append(location) }
                                contact.updatedAt = Date()
                                try? modelContext.save()
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: location.icon).foregroundStyle(location.color).frame(width: 20)
                                    Text(location.name)
                                    Spacer()
                                    if isSelected { Image(systemName: "checkmark").foregroundStyle(AppConstants.UI.accentGold) }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                default:
                    EmptyView()
                }
            }
            .navigationTitle(column.rawValue)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 350, idealWidth: 400, minHeight: 300, idealHeight: 400)
        #endif
    }
}
