import SwiftUI
import SwiftData

struct MergeContactPickerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: [SortDescriptor(\Contact.firstName), SortDescriptor(\Contact.lastName)]) private var allContacts: [Contact]
    let primaryContact: Contact
    var onMerge: () -> Void

    @State private var searchText = ""
    @State private var selectedContact: Contact?
    @State private var showConfirmation = false

    private var eligible: [Contact] {
        allContacts.filter { $0.id != primaryContact.id && !$0.isHidden && !$0.isMergedAway }
    }

    private var filtered: [Contact] {
        guard !searchText.isEmpty else { return eligible }
        let query = searchText.lowercased()
        return eligible.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
            ($0.company?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if !searchText.isEmpty && filtered.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                } else {
                    ForEach(filtered) { contact in
                        Button {
                            selectedContact = contact
                            showConfirmation = true
                        } label: {
                            HStack(spacing: 12) {
                                ContactAvatarView(contact: contact, size: 36)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(contact.displayName)
                                        .font(.body.weight(.medium))
                                    if let company = contact.company, !company.isEmpty {
                                        Text(company)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                ScoreBadgeView(score: contact.relationshipScore)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search contacts")
            .navigationTitle("Merge with\u{2026}")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert(
                "Merge Contacts",
                isPresented: $showConfirmation,
                presenting: selectedContact
            ) { secondary in
                Button("Cancel", role: .cancel) { selectedContact = nil }
                Button("Merge", role: .destructive) {
                    let service = ContactMergeService()
                    try? service.merge(primary: primaryContact, secondary: secondary, context: modelContext)
                    onMerge()
                    dismiss()
                }
            } message: { secondary in
                Text("Merge \(secondary.displayName) into \(primaryContact.displayName)? All interactions, notes, and relationships from \(secondary.displayName) will be moved to \(primaryContact.displayName). \(secondary.displayName) will no longer appear in your contacts.")
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 400, idealHeight: 500)
        #endif
    }
}
