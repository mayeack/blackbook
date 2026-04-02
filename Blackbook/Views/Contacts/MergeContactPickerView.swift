import SwiftUI
import SwiftData

struct MergeContactPickerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: [SortDescriptor(\Contact.lastName), SortDescriptor(\Contact.firstName)]) private var allContacts: [Contact]
    let initialPrimary: Contact
    var onMerge: () -> Void

    @State private var searchText = ""
    @State private var selectedContact: Contact?
    @State private var showPrimarySelection = false

    private var eligible: [Contact] {
        allContacts.filter { $0.id != initialPrimary.id && !$0.isHidden && !$0.isMergedAway }
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
                            showPrimarySelection = true
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
            .sheet(isPresented: $showPrimarySelection) {
                if let secondary = selectedContact {
                    MergePrimarySelectionView(
                        contactA: initialPrimary,
                        contactB: secondary,
                        onConfirm: { primary, secondary in
                            let service = ContactMergeService()
                            try? service.merge(primary: primary, secondary: secondary, context: modelContext)
                            onMerge()
                            dismiss()
                        },
                        onCancel: {
                            selectedContact = nil
                        }
                    )
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 400, idealHeight: 500)
        #endif
    }
}

// MARK: - Primary Contact Selection

struct MergePrimarySelectionView: View {
    @Environment(\.dismiss) private var dismiss
    let contactA: Contact
    let contactB: Contact
    var onConfirm: (Contact, Contact) -> Void
    var onCancel: () -> Void

    @State private var selectedPrimaryID: UUID?
    @State private var showFinalConfirm = false

    private var primary: Contact? {
        guard let id = selectedPrimaryID else { return nil }
        return id == contactA.id ? contactA : contactB
    }

    private var secondary: Contact? {
        guard let id = selectedPrimaryID else { return nil }
        return id == contactA.id ? contactB : contactA
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Text("Choose the primary contact record. The other contact will be merged into it and removed.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                VStack(spacing: 12) {
                    contactCard(contactA)
                    contactCard(contactB)
                }
                .padding(.horizontal)

                Spacer()
            }
            .padding(.top)
            .navigationTitle("Choose Primary")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") {
                        onCancel()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Merge") {
                        showFinalConfirm = true
                    }
                    .fontWeight(.semibold)
                    .disabled(selectedPrimaryID == nil)
                }
            }
            .alert(
                "Merge Contacts",
                isPresented: $showFinalConfirm
            ) {
                Button("Cancel", role: .cancel) {}
                Button("Merge", role: .destructive) {
                    if let primary, let secondary {
                        dismiss()
                        onConfirm(primary, secondary)
                    }
                }
            } message: {
                if let primary, let secondary {
                    Text("Merge \(secondary.displayName) into \(primary.displayName)? All interactions, notes, and relationships from \(secondary.displayName) will be moved to \(primary.displayName). \(secondary.displayName) will no longer appear in your contacts.")
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, idealWidth: 450, minHeight: 350, idealHeight: 400)
        #endif
    }

    private func contactCard(_ contact: Contact) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                selectedPrimaryID = contact.id
            }
        } label: {
            HStack(spacing: 14) {
                ContactAvatarView(contact: contact, size: 48)
                VStack(alignment: .leading, spacing: 3) {
                    Text(contact.displayName)
                        .font(.body.weight(.semibold))
                    if let company = contact.company, !company.isEmpty {
                        Text(company)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 8) {
                        ScoreBadgeView(score: contact.relationshipScore)
                        if !contact.emails.isEmpty {
                            Text(contact.emails.first!)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                Spacer()
                Image(systemName: selectedPrimaryID == contact.id ? "checkmark.circle.fill" : "circle")
                    .font(.title2)
                    .foregroundStyle(selectedPrimaryID == contact.id ? AppConstants.UI.accentGold : .secondary)
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(selectedPrimaryID == contact.id ? AppConstants.UI.accentGold.opacity(0.08) : Color.secondary.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(selectedPrimaryID == contact.id ? AppConstants.UI.accentGold : .clear, lineWidth: 2)
            )
        }
        .buttonStyle(.plain)
    }
}
