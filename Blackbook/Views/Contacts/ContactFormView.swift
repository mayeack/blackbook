import SwiftUI
import SwiftData

struct ContactFormView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Tag.name) private var allTags: [Tag]
    @Query(sort: \Group.name) private var allGroups: [Group]
    @Query(sort: \Location.name) private var allLocations: [Location]
    @Query(sort: [SortDescriptor(\Contact.firstName), SortDescriptor(\Contact.lastName)]) private var allContacts: [Contact]
    let contact: Contact?
    @State private var firstName = ""; @State private var lastName = ""; @State private var company = ""
    @State private var jobTitle = ""; @State private var emailsText = ""; @State private var phonesText = ""
    @State private var addressesText = ""
    @State private var birthday: Date?; @State private var hasBirthday = false; @State private var interests = ""
    @State private var familyDetails = ""; @State private var linkedInURL = ""; @State private var twitterHandle = ""
    @State private var instagramHandle = ""
    @State private var isPriority = false; @State private var selectedTagIds: Set<UUID> = []
    @State private var selectedGroupIds: Set<UUID> = []
    @State private var selectedLocationIds: Set<UUID> = []
    @State private var metViaContactId: UUID?
    @State private var expandedSections: Set<String> = ["Name", "Work", "Contact Info"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("First Name", text: $firstName); TextField("Last Name", text: $lastName) }
                Section("Work") { TextField("Company", text: $company); TextField("Job Title", text: $jobTitle) }
                Section("Contact Info") {
                    TextField("Emails (comma separated)", text: $emailsText)
                        #if os(iOS)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never)
                        #endif
                    TextField("Phones (comma separated)", text: $phonesText)
                    TextField("Addresses (semicolon separated)", text: $addressesText)
                }
                Section {
                    DisclosureGroup(isExpanded: sectionBinding("Personal")) {
                        Toggle("Birthday", isOn: $hasBirthday)
                        if hasBirthday { DatePicker("Date", selection: Binding(get: { birthday ?? Date() }, set: { birthday = $0 }), displayedComponents: .date) }
                        TextField("Interests (comma separated)", text: $interests)
                        TextField("Family Details", text: $familyDetails)
                    } label: {
                        Label("Personal", systemImage: "person.fill")
                    }
                }
                Section {
                    DisclosureGroup(isExpanded: sectionBinding("Social")) {
                        TextField("LinkedIn URL", text: $linkedInURL)
                            #if os(iOS)
                            .keyboardType(.URL).textInputAutocapitalization(.never)
                            #endif
                        TextField("Twitter Handle", text: $twitterHandle)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                        TextField("Instagram Handle", text: $instagramHandle)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                    } label: {
                        Label("Social", systemImage: "at")
                    }
                }
                Section {
                    DisclosureGroup(isExpanded: sectionBinding("Met via")) {
                        let eligible = allContacts.filter { $0.id != contact?.id && !$0.isHidden && !$0.isMergedAway }
                        Picker("Met via", selection: $metViaContactId) {
                            Text("None").tag(UUID?.none)
                            ForEach(eligible) { c in
                                Text(c.displayName).tag(UUID?.some(c.id))
                            }
                        }
                    } label: {
                        Label("Met via", systemImage: "person.line.dotted.person")
                    }
                }
                if !allTags.isEmpty {
                    Section {
                        DisclosureGroup(isExpanded: sectionBinding("Tags")) {
                            ForEach(allTags) { tag in
                                Toggle(isOn: Binding(get: { selectedTagIds.contains(tag.id) }, set: { if $0 { selectedTagIds.insert(tag.id) } else { selectedTagIds.remove(tag.id) } })) {
                                    HStack { Circle().fill(tag.color).frame(width: 10, height: 10); Text(tag.name) }
                                }
                            }
                        } label: {
                            Label("Tags", systemImage: "tag")
                        }
                    }
                }
                if !allGroups.isEmpty {
                    Section {
                        DisclosureGroup(isExpanded: sectionBinding("Groups")) {
                            ForEach(allGroups) { group in
                                Toggle(isOn: Binding(get: { selectedGroupIds.contains(group.id) }, set: { if $0 { selectedGroupIds.insert(group.id) } else { selectedGroupIds.remove(group.id) } })) {
                                    HStack(spacing: 8) {
                                        Image(systemName: group.icon).foregroundStyle(group.color).frame(width: 16)
                                        Text(group.name)
                                    }
                                }
                            }
                        } label: {
                            Label("Groups", systemImage: "folder")
                        }
                    }
                }
                if !allLocations.isEmpty {
                    Section {
                        DisclosureGroup(isExpanded: sectionBinding("Locations")) {
                            ForEach(allLocations) { location in
                                Toggle(isOn: Binding(get: { selectedLocationIds.contains(location.id) }, set: { if $0 { selectedLocationIds.insert(location.id) } else { selectedLocationIds.remove(location.id) } })) {
                                    HStack(spacing: 8) {
                                        Image(systemName: location.icon).foregroundStyle(location.color).frame(width: 16)
                                        Text(location.name)
                                    }
                                }
                            }
                        } label: {
                            Label("Locations", systemImage: "mappin")
                        }
                    }
                }
                Section { Toggle("Priority Contact", isOn: $isPriority) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .navigationTitle(contact != nil ? "Edit Contact" : "New Contact")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(firstName.isEmpty && lastName.isEmpty) }
            }
            .onAppear { if let c = contact { firstName = c.firstName; lastName = c.lastName; company = c.company ?? ""; jobTitle = c.jobTitle ?? ""; emailsText = c.emails.joined(separator: ", "); phonesText = c.phones.joined(separator: ", "); addressesText = c.addresses.joined(separator: "; "); birthday = c.birthday; hasBirthday = c.birthday != nil; interests = c.interests.joined(separator: ", "); familyDetails = c.familyDetails ?? ""; linkedInURL = c.linkedInURL ?? ""; twitterHandle = c.twitterHandle ?? ""; instagramHandle = c.instagramHandle ?? ""; isPriority = c.isPriority; selectedTagIds = Set(c.tags.map(\.id)); selectedGroupIds = Set(c.groups.map(\.id)); selectedLocationIds = Set(c.locations.map(\.id)); metViaContactId = c.metVia?.id } }
        }
    }

    private func sectionBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { expandedSections.contains(key) },
            set: { if $0 { expandedSections.insert(key) } else { expandedSections.remove(key) } }
        )
    }

    private func save() {
        let t = contact ?? { let c = Contact(firstName: firstName, lastName: lastName); modelContext.insert(c); return c }()
        t.firstName = firstName; t.lastName = lastName
        t.company = company.isEmpty ? nil : company; t.jobTitle = jobTitle.isEmpty ? nil : jobTitle
        t.emails = emailsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        t.phones = phonesText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        t.addresses = addressesText.split(separator: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        t.birthday = hasBirthday ? birthday : nil
        t.interests = interests.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        t.familyDetails = familyDetails.isEmpty ? nil : familyDetails
        t.linkedInURL = linkedInURL.isEmpty ? nil : linkedInURL
        t.twitterHandle = twitterHandle.isEmpty ? nil : twitterHandle
        t.instagramHandle = instagramHandle.isEmpty ? nil : instagramHandle
        t.isPriority = isPriority; t.updatedAt = Date()
        t.tags = allTags.filter { selectedTagIds.contains($0.id) }
        t.groups = allGroups.filter { selectedGroupIds.contains($0.id) }
        t.locations = allLocations.filter { selectedLocationIds.contains($0.id) }
        t.metVia = allContacts.first { $0.id == metViaContactId }
        try? modelContext.save(); dismiss()
    }
}
