import SwiftUI
import SwiftData

struct ContactDetailView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: [SortDescriptor(\Contact.firstName), SortDescriptor(\Contact.lastName)]) private var allContacts: [Contact]
    @Query(sort: \Tag.name) private var allTags: [Tag]
    @Query(sort: \Group.name) private var allGroups: [Group]
    @Query(sort: \Location.name) private var allLocations: [Location]
    @Bindable var contact: Contact
    @State private var viewModel = ContactDetailViewModel()
    @State private var selectedSection: DetailSection = .overview
    @State private var showMetViaPicker = false
    @State private var showIntroducedToPicker = false

    enum DetailSection: String, CaseIterable, Identifiable {
        case overview = "Overview", interactions = "Interactions", notes = "Notes", reminders = "Reminders", ai = "AI"
        var id: String { rawValue }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                headerSection
                Picker(selection: $selectedSection) {
                    ForEach(DetailSection.allCases) { Text($0.rawValue).tag($0) }
                } label: { EmptyView() }
                .pickerStyle(.segmented).padding(.horizontal).padding(.bottom, 8)
                switch selectedSection {
                case .overview: overviewSection
                case .interactions: interactionsSection
                case .notes: notesSection
                case .reminders: remindersSection
                case .ai: ContactAIView(contact: contact).padding()
                }
            }
        }
        .navigationTitle(contact.displayName)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { viewModel.showEditContact = true } label: { Label("Edit", systemImage: "pencil") }
                    Button { viewModel.showLogInteraction = true } label: { Label("Log Interaction", systemImage: "plus.bubble") }
                    Button { viewModel.showAddNote = true } label: { Label("Add Note", systemImage: "note.text.badge.plus") }
                    Button { viewModel.showAddReminder = true } label: { Label("Set Reminder", systemImage: "bell.badge.fill") }
                    Divider()
                    Button { viewModel.showTagPicker = true } label: { Label("Manage Tags", systemImage: "tag") }
                    Button { viewModel.showGroupPicker = true } label: { Label("Manage Groups", systemImage: "folder") }
                    Button { viewModel.showLocationPicker = true } label: { Label("Manage Locations", systemImage: "mappin") }
                    Divider()
                    Button { viewModel.showMergeContact = true } label: {
                        Label("Merge with\u{2026}", systemImage: "arrow.triangle.merge")
                    }
                    Button {
                        contact.isHidden.toggle()
                        contact.updatedAt = Date()
                        try? modelContext.save()
                        if contact.isHidden { dismiss() }
                    } label: {
                        Label(contact.isHidden ? "Unhide Contact" : "Hide Contact",
                              systemImage: contact.isHidden ? "eye" : "eye.slash")
                    }
                    Button(role: .destructive) { viewModel.deleteContact(contact, context: modelContext); dismiss() }
                    label: { Label("Delete Contact", systemImage: "trash") }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $viewModel.showEditContact) { ContactFormView(contact: contact) }
        .sheet(isPresented: $viewModel.showLogInteraction) { LogInteractionView(contact: contact) }
        .sheet(isPresented: $viewModel.showAddNote) { AddNoteView(contact: contact) }
        .sheet(isPresented: $viewModel.showAddReminder) { AddReminderView(contact: contact) }
        .navigationDestination(for: ContactNavigationID.self) { nav in
            if let target = allContacts.first(where: { $0.id == nav.id }) {
                ContactDetailView(contact: target)
            }
        }
        .sheet(isPresented: $showMetViaPicker) {
            MetViaPickerView(contact: contact, allContacts: allContacts)
        }
        .sheet(isPresented: $showIntroducedToPicker) {
            IntroducedToPickerView(contact: contact, allContacts: allContacts)
        }
        .sheet(isPresented: $viewModel.showMergeContact) {
            MergeContactPickerView(primaryContact: contact) {
                viewModel.showMergeContact = false
            }
        }
        .sheet(isPresented: $viewModel.showTagPicker) {
            ContactTagPickerView(contact: contact, allTags: allTags)
        }
        .sheet(isPresented: $viewModel.showGroupPicker) {
            ContactGroupPickerView(contact: contact, allGroups: allGroups)
        }
        .sheet(isPresented: $viewModel.showLocationPicker) {
            ContactLocationPickerView(contact: contact, allLocations: allLocations)
        }
    }

    private var headerSection: some View {
        VStack(spacing: 20) {
            ContactAvatarView(contact: contact, size: AppConstants.UI.profileAvatarSize)
            VStack(spacing: 6) {
                Text(contact.displayName).font(.title.weight(.bold))
                if let jt = contact.jobTitle, let co = contact.company {
                    Text("\(jt) at \(co)").font(.body).foregroundStyle(.secondary)
                } else if let co = contact.company {
                    Text(co).font(.body).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 28) {
                VStack(spacing: 6) {
                    ZStack {
                        Circle().stroke(Color.gray.opacity(0.2), lineWidth: 7)
                        Circle().trim(from: 0, to: contact.relationshipScore / 100)
                            .stroke(AppConstants.UI.scoreColor(for: contact.relationshipScore), style: StrokeStyle(lineWidth: 7, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text("\(Int(contact.relationshipScore))").font(.title2.weight(.bold).monospacedDigit())
                    }.frame(width: AppConstants.UI.scoreRingSize, height: AppConstants.UI.scoreRingSize)
                    Text(contact.scoreCategory.rawValue).font(.caption.weight(.medium))
                        .foregroundStyle(AppConstants.UI.scoreColor(for: contact.relationshipScore))
                }
                let stats = viewModel.interactionStats(for: contact)
                VStack(alignment: .leading, spacing: 10) {
                    StatRow(label: "Interactions", value: "\(stats.totalCount)")
                    StatRow(label: "Frequency", value: stats.frequencyDescription)
                    if let d = contact.lastInteractionDate { StatRow(label: "Last Contact", value: d.relativeDescription) }
                    if contact.isPriority { Label("Priority", systemImage: "star.fill").font(.subheadline.weight(.medium)).foregroundStyle(AppConstants.UI.accentGold) }
                }
            }.padding(AppConstants.UI.cardPadding).background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 12))
            if !contact.tags.isEmpty || !contact.groups.isEmpty || !contact.locations.isEmpty || !contact.activities.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(contact.locations) { location in
                            HStack(spacing: 5) {
                                Image(systemName: location.icon).font(.caption)
                                Text(location.name).font(.caption.weight(.medium))
                            }
                            .foregroundStyle(location.color)
                            .padding(.horizontal, AppConstants.UI.chipPaddingH).padding(.vertical, AppConstants.UI.chipPaddingV)
                            .background(location.color.opacity(0.15), in: Capsule())
                        }
                        ForEach(contact.groups) { group in
                            HStack(spacing: 5) {
                                Image(systemName: group.icon).font(.caption)
                                Text(group.name).font(.caption.weight(.medium))
                            }
                            .foregroundStyle(group.color)
                            .padding(.horizontal, AppConstants.UI.chipPaddingH).padding(.vertical, AppConstants.UI.chipPaddingV)
                            .background(group.color.opacity(0.15), in: Capsule())
                        }
                        ForEach(contact.activities) { activity in
                            HStack(spacing: 5) {
                                Image(systemName: activity.icon).font(.caption)
                                Text(activity.name).font(.caption.weight(.medium))
                            }
                            .foregroundStyle(activity.color)
                            .padding(.horizontal, AppConstants.UI.chipPaddingH).padding(.vertical, AppConstants.UI.chipPaddingV)
                            .background(activity.color.opacity(0.15), in: Capsule())
                        }
                        ForEach(contact.tags) { tag in
                            Text(tag.name).font(.caption.weight(.medium)).foregroundStyle(tag.color)
                                .padding(.horizontal, AppConstants.UI.chipPaddingH).padding(.vertical, AppConstants.UI.chipPaddingV)
                                .background(tag.color.opacity(0.15), in: Capsule())
                        }
                    }
                }
            }
        }.padding(AppConstants.UI.sectionSpacing)
    }

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: AppConstants.UI.sectionSpacing) {
            if !contact.phones.isEmpty { InfoBlock(title: "Phone", items: contact.phones, icon: "phone") }
            if !contact.emails.isEmpty { InfoBlock(title: "Email", items: contact.emails, icon: "envelope") }
            if !contact.addresses.isEmpty { InfoBlock(title: "Address", items: contact.addresses, icon: "mappin.and.ellipse") }
            if let b = contact.birthday { DetailRow(icon: "gift", label: "Birthday", value: b.shortFormatted) }
            if !contact.interests.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Interests", systemImage: "sparkles").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    FlowLayout(spacing: 8) {
                        ForEach(contact.interests, id: \.self) { i in
                            Text(i).font(.subheadline).padding(.horizontal, 12).padding(.vertical, 6).background(Color.secondary.opacity(0.12), in: Capsule())
                        }
                    }
                }
            }
            if let f = contact.familyDetails, !f.isEmpty { DetailRow(icon: "figure.2.and.child.holdinghands", label: "Family", value: f) }
            VStack(alignment: .leading, spacing: 6) {
                Label("Met via", systemImage: "person.line.dotted.person").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                if let metViaContact = contact.metVia {
                    NavigationLink(value: ContactNavigationID(id: metViaContact.id)) {
                        HStack(spacing: 10) {
                            ContactAvatarView(contact: metViaContact, size: AppConstants.UI.metViaAvatarSize)
                            Text(metViaContact.displayName).font(.body.weight(.medium))
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                    }.buttonStyle(.plain)
                } else {
                    Text("None").font(.body).foregroundStyle(.tertiary)
                }
                Button { showMetViaPicker = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil").font(.caption)
                        Text("Edit").font(.caption)
                    }.foregroundStyle(AppConstants.UI.accentGold)
                }.buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 8) {
                Label("Introduced to", systemImage: "person.2").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                if contact.metViaBacklinks.isEmpty {
                    Text("None").font(.body).foregroundStyle(.tertiary)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(contact.metViaBacklinks.sorted { $0.displayName < $1.displayName }) { linked in
                            NavigationLink(value: ContactNavigationID(id: linked.id)) {
                                HStack(spacing: 10) {
                                    ContactAvatarView(contact: linked, size: AppConstants.UI.metViaAvatarSize)
                                    Text(linked.displayName).font(.body.weight(.medium))
                                }
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                            }.buttonStyle(.plain)
                        }
                    }
                }
                Button { showIntroducedToPicker = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil").font(.caption)
                        Text("Edit").font(.caption)
                    }.foregroundStyle(AppConstants.UI.accentGold)
                }.buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 8) {
                Label("Tags", systemImage: "tag").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                if contact.tags.isEmpty {
                    Text("None").font(.body).foregroundStyle(.tertiary)
                } else {
                    FlowLayout(spacing: 8) {
                        ForEach(contact.tags.sorted { $0.name < $1.name }) { tag in
                            Text(tag.name).font(.subheadline.weight(.medium)).foregroundStyle(tag.color)
                                .padding(.horizontal, AppConstants.UI.chipPaddingH).padding(.vertical, AppConstants.UI.chipPaddingV)
                                .background(tag.color.opacity(0.15), in: Capsule())
                        }
                    }
                }
                Button { viewModel.showTagPicker = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil").font(.caption)
                        Text("Edit").font(.caption)
                    }.foregroundStyle(AppConstants.UI.accentGold)
                }.buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 8) {
                Label("Groups", systemImage: "folder").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                if contact.groups.isEmpty {
                    Text("None").font(.body).foregroundStyle(.tertiary)
                } else {
                    FlowLayout(spacing: 8) {
                        ForEach(contact.groups.sorted { $0.name < $1.name }) { group in
                            HStack(spacing: 5) {
                                Image(systemName: group.icon).font(.caption)
                                Text(group.name).font(.subheadline.weight(.medium))
                            }
                            .foregroundStyle(group.color)
                            .padding(.horizontal, AppConstants.UI.chipPaddingH).padding(.vertical, AppConstants.UI.chipPaddingV)
                            .background(group.color.opacity(0.15), in: Capsule())
                        }
                    }
                }
                Button { viewModel.showGroupPicker = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil").font(.caption)
                        Text("Edit").font(.caption)
                    }.foregroundStyle(AppConstants.UI.accentGold)
                }.buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 8) {
                Label("Locations", systemImage: "mappin").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                if contact.locations.isEmpty {
                    Text("None").font(.body).foregroundStyle(.tertiary)
                } else {
                    FlowLayout(spacing: 8) {
                        ForEach(contact.locations.sorted { $0.name < $1.name }) { location in
                            HStack(spacing: 5) {
                                Image(systemName: location.icon).font(.caption)
                                Text(location.name).font(.subheadline.weight(.medium))
                            }
                            .foregroundStyle(location.color)
                            .padding(.horizontal, AppConstants.UI.chipPaddingH).padding(.vertical, AppConstants.UI.chipPaddingV)
                            .background(location.color.opacity(0.15), in: Capsule())
                        }
                    }
                }
                Button { viewModel.showLocationPicker = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil").font(.caption)
                        Text("Edit").font(.caption)
                    }.foregroundStyle(AppConstants.UI.accentGold)
                }.buttonStyle(.plain)
            }
        }.padding(AppConstants.UI.sectionSpacing)
    }

    private var interactionsSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button { viewModel.showLogInteraction = true } label: { Label("Log Interaction", systemImage: "plus.bubble").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(AppConstants.UI.accentGold).padding(.horizontal, AppConstants.UI.sectionSpacing)
            let interactions = contact.interactions.sorted { $0.date > $1.date }
            if interactions.isEmpty {
                ContentUnavailableView {
                    Label("No Interactions", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Log your first interaction.")
                }.frame(maxWidth: .infinity)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(interactions) { i in InteractionRowView(interaction: i).padding(.horizontal, AppConstants.UI.sectionSpacing).padding(.vertical, 10); Divider().padding(.leading, 56) }
                }
            }
        }
    }

    private var notesSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button { viewModel.showAddNote = true } label: { Label("Add Note", systemImage: "note.text.badge.plus").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(AppConstants.UI.accentGold).padding(.horizontal, AppConstants.UI.sectionSpacing)
            let notes = viewModel.filteredNotes(for: contact)
            if notes.isEmpty {
                ContentUnavailableView {
                    Label("No Notes", systemImage: "note.text")
                } description: {
                    Text("Add notes about this contact.")
                }.frame(maxWidth: .infinity)
            }
            else { LazyVStack(spacing: 14) { ForEach(notes) { n in NoteCardView(note: n).padding(.horizontal, AppConstants.UI.sectionSpacing) } } }
        }
    }

    private var remindersSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button { viewModel.showAddReminder = true } label: { Label("Set Reminder", systemImage: "bell.badge.fill").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(AppConstants.UI.accentGold).padding(.horizontal, AppConstants.UI.sectionSpacing)
            let reminders = contact.reminders.sorted { $0.dueDate < $1.dueDate }
            if reminders.isEmpty {
                ContentUnavailableView {
                    Label("No Reminders", systemImage: "bell.slash")
                } description: {
                    Text("Set reminders to follow up.")
                }.frame(maxWidth: .infinity)
            }
            else { LazyVStack(spacing: 10) { ForEach(reminders) { r in ReminderRowView(reminder: r).padding(.horizontal, AppConstants.UI.sectionSpacing) } } }
        }
    }
}

struct MetViaPickerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Bindable var contact: Contact
    let allContacts: [Contact]
    @State private var searchText = ""

    private var eligible: [Contact] {
        allContacts.filter { $0.id != contact.id }
    }

    private var filtered: [Contact] {
        guard !searchText.isEmpty else { return eligible }
        let query = searchText.lowercased()
        return eligible.filter { $0.displayName.lowercased().contains(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        contact.metVia = nil
                        contact.updatedAt = Date()
                        try? modelContext.save()
                        dismiss()
                    } label: {
                        HStack {
                            Text("None").foregroundStyle(contact.metVia == nil ? .primary : .secondary)
                            Spacer()
                            if contact.metVia == nil {
                                Image(systemName: "checkmark").foregroundStyle(AppConstants.UI.accentGold)
                            }
                        }
                    }
                }
                Section {
                    ForEach(filtered) { c in
                        Button {
                            contact.metVia = c
                            contact.updatedAt = Date()
                            try? modelContext.save()
                            dismiss()
                        } label: {
                            HStack(spacing: 10) {
                                ContactAvatarView(contact: c, size: 32)
                                Text(c.displayName).font(.body)
                                Spacer()
                                if contact.metVia?.id == c.id {
                                    Image(systemName: "checkmark").foregroundStyle(AppConstants.UI.accentGold)
                                }
                            }
                        }.buttonStyle(.plain)
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search contacts")
            .navigationTitle("Met via")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 400, idealHeight: 500)
        #endif
    }
}

struct IntroducedToPickerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Bindable var contact: Contact
    let allContacts: [Contact]
    @State private var searchText = ""
    @State private var selectedIDs: Set<UUID> = []

    private var eligible: [Contact] {
        allContacts.filter { $0.id != contact.id }
    }

    private var filtered: [Contact] {
        guard !searchText.isEmpty else { return eligible }
        let query = searchText.lowercased()
        return eligible.filter {
            $0.displayName.lowercased().contains(query) ||
            ($0.company?.lowercased().contains(query) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if !searchText.isEmpty && filtered.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                } else {
                    ForEach(filtered) { c in
                        Button {
                            if selectedIDs.contains(c.id) {
                                selectedIDs.remove(c.id)
                            } else {
                                selectedIDs.insert(c.id)
                            }
                        } label: {
                            HStack(spacing: 10) {
                                ContactAvatarView(contact: c, size: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.displayName).font(.body)
                                    if let company = c.company, !company.isEmpty {
                                        Text(company).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if selectedIDs.contains(c.id) {
                                    Image(systemName: "checkmark").foregroundStyle(AppConstants.UI.accentGold)
                                }
                            }
                        }.buttonStyle(.plain)
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search contacts")
            .navigationTitle("Introduced to")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        let currentBacklinkIDs = Set(contact.metViaBacklinks.map(\.id))
                        for c in eligible {
                            if selectedIDs.contains(c.id) && !currentBacklinkIDs.contains(c.id) {
                                c.metVia = contact
                                c.updatedAt = Date()
                            } else if !selectedIDs.contains(c.id) && currentBacklinkIDs.contains(c.id) {
                                c.metVia = nil
                                c.updatedAt = Date()
                            }
                        }
                        contact.updatedAt = Date()
                        try? modelContext.save()
                        dismiss()
                    }.fontWeight(.semibold)
                }
            }
            .onAppear {
                selectedIDs = Set(contact.metViaBacklinks.map(\.id))
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 400, idealHeight: 500)
        #endif
    }
}

struct StatRow: View {
    let label: String; let value: String
    var body: some View {
        HStack {
            Text(label).font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.subheadline.weight(.semibold))
        }
    }
}
struct DetailRow: View {
    let icon: String; let label: String; let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(label, systemImage: icon).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.body)
        }
    }
}
struct InfoBlock: View {
    let title: String; let items: [String]; let icon: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: icon).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(items, id: \.self) { Text($0).font(.body) }
        }
    }
}
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        layout(proposal: proposal, subviews: subviews).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let r = layout(proposal: proposal, subviews: subviews)
        for (i, p) in r.positions.enumerated() { subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified) }
    }
    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxW = proposal.width ?? .infinity; var positions: [CGPoint] = []; var x: CGFloat = 0; var y: CGFloat = 0; var rowH: CGFloat = 0
        for sv in subviews { let s = sv.sizeThatFits(.unspecified); if x + s.width > maxW, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }; positions.append(CGPoint(x: x, y: y)); rowH = max(rowH, s.height); x += s.width + spacing }
        return (CGSize(width: maxW, height: y + rowH), positions)
    }
}
struct InteractionRowView: View {
    let interaction: Interaction
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: interaction.type.icon).font(.body).foregroundStyle(AppConstants.UI.accentGold)
                .frame(width: AppConstants.UI.interactionIconSize, height: AppConstants.UI.interactionIconSize)
                .background(AppConstants.UI.accentGold.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(interaction.type.rawValue).font(.body.weight(.medium))
                    if let s = interaction.sentiment { Image(systemName: s.icon).font(.subheadline).foregroundStyle(.secondary) }
                }
                if let sum = interaction.summary, !sum.isEmpty { Text(sum).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(interaction.date.relativeDescription).font(.caption).foregroundStyle(.secondary)
                if let d = interaction.duration { Text(d.formattedDuration).font(.caption).foregroundStyle(.tertiary) }
            }
        }
    }
}
struct NoteCardView: View {
    let note: Note
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if let c = note.category { Label(c.rawValue, systemImage: c.icon).font(.caption.weight(.semibold)).foregroundStyle(AppConstants.UI.accentGold) }
                Spacer()
                Text(note.createdAt.relativeDescription).font(.caption).foregroundStyle(.tertiary)
            }
            Text(note.content).font(.body).lineLimit(4)
        }.padding(AppConstants.UI.cardPadding).background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10))
    }
}
struct ReminderRowView: View {
    @Environment(\.modelContext) private var modelContext
    @Bindable var reminder: Reminder
    var body: some View {
        HStack(spacing: 14) {
            Button { reminder.isCompleted.toggle(); try? modelContext.save() } label: {
                Image(systemName: reminder.isCompleted ? "checkmark.circle.fill" : "circle").font(.title2)
                    .foregroundStyle(reminder.isCompleted ? .green : reminder.isOverdue ? .red : .secondary)
            }.buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 3) {
                Text(reminder.title).font(.body.weight(.medium)).strikethrough(reminder.isCompleted)
                HStack(spacing: 5) {
                    Text(reminder.dueDate.shortFormatted).font(.subheadline).foregroundStyle(reminder.isOverdue ? .red : .secondary)
                    if let r = reminder.recurrence { Text("(\(r.rawValue))").font(.subheadline).foregroundStyle(.tertiary) }
                }
            }; Spacer()
        }.padding(14).background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10))
    }
}
