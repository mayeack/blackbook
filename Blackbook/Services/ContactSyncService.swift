import Foundation
import Observation
import Contacts
import SwiftData
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "ContactSync")

@Observable
final class ContactSyncService {
    private let contactStore = CNContactStore()
    private var changeObserver: NSObjectProtocol?
    private var debounceTask: Task<Void, Never>?
    private weak var observedModelContext: ModelContext?

    var authorizationStatus: CNAuthorizationStatus {
        CNContactStore.authorizationStatus(for: .contacts)
    }

    var isSyncing = false
    var lastSyncDate: Date?
    var syncError: String?

    deinit {
        stopObservingChanges()
    }

    func requestAccess() async -> Bool {
        do { return try await contactStore.requestAccess(for: .contacts) }
        catch { syncError = error.localizedDescription; return false }
    }

    // MARK: - Automatic Sync

    /// Performs an initial sync on launch if permission was already granted,
    /// then begins observing the system address book for changes.
    func startAutoSync(with modelContext: ModelContext) {
        observedModelContext = modelContext

        guard authorizationStatus == .authorized else {
            logger.info("Skipping auto-sync — contacts access not yet authorized")
            return
        }

        Task { @MainActor in
            await importContacts(into: modelContext)
            startObservingChanges()
        }
    }

    func startObservingChanges() {
        guard changeObserver == nil else { return }

        changeObserver = NotificationCenter.default.addObserver(
            forName: .CNContactStoreDidChange,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.handleContactStoreChange()
        }
        logger.info("Now observing system contact changes")
    }

    func stopObservingChanges() {
        if let observer = changeObserver {
            NotificationCenter.default.removeObserver(observer)
            changeObserver = nil
        }
        debounceTask?.cancel()
        debounceTask = nil
    }

    private func handleContactStoreChange() {
        debounceTask?.cancel()
        debounceTask = Task { @MainActor [weak self] in
            guard let self, let modelContext = self.observedModelContext else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            logger.info("System contacts changed — re-syncing")
            await self.importContacts(into: modelContext)
        }
    }

    // MARK: - Import

    func importContacts(into modelContext: ModelContext) async {
        guard authorizationStatus == .authorized else {
            syncError = "Contacts access not authorized"; return
        }
        guard !isSyncing else { return }
        isSyncing = true; syncError = nil
        do {
            let keysToFetch: [CNKeyDescriptor] = [
                CNContactGivenNameKey as CNKeyDescriptor,
                CNContactFamilyNameKey as CNKeyDescriptor,
                CNContactOrganizationNameKey as CNKeyDescriptor,
                CNContactJobTitleKey as CNKeyDescriptor,
                CNContactEmailAddressesKey as CNKeyDescriptor,
                CNContactPhoneNumbersKey as CNKeyDescriptor,
                CNContactBirthdayKey as CNKeyDescriptor,
                CNContactThumbnailImageDataKey as CNKeyDescriptor,
                CNContactIdentifierKey as CNKeyDescriptor,
                CNContactSocialProfilesKey as CNKeyDescriptor,
                CNContactPostalAddressesKey as CNKeyDescriptor
            ]
            let request = CNContactFetchRequest(keysToFetch: keysToFetch)
            var cnContacts: [CNContact] = []
            try contactStore.enumerateContacts(with: request) { contact, _ in
                cnContacts.append(contact)
            }
            let existingDescriptor = FetchDescriptor<Contact>(
                predicate: #Predicate { $0.cnContactIdentifier != nil }
            )
            let existingContacts = try modelContext.fetch(existingDescriptor)
            let existingMap = Dictionary(
                uniqueKeysWithValues: existingContacts.compactMap { c in
                    c.cnContactIdentifier.map { ($0, c) }
                }
            )
            for cnContact in cnContacts {
                if let existing = existingMap[cnContact.identifier] {
                    updateContact(existing, from: cnContact)
                } else {
                    modelContext.insert(createContact(from: cnContact))
                }
            }
            try modelContext.save()
            lastSyncDate = Date()
            logger.info("Contact sync completed — \(cnContacts.count) contacts processed")
        } catch {
            syncError = error.localizedDescription
            logger.error("Contact sync failed: \(error.localizedDescription)")
        }
        isSyncing = false
    }

    // MARK: - Mapping

    private func createContact(from cn: CNContact) -> Contact {
        let contact = Contact(
            firstName: cn.givenName, lastName: cn.familyName,
            company: cn.organizationName.isEmpty ? nil : cn.organizationName,
            jobTitle: cn.jobTitle.isEmpty ? nil : cn.jobTitle,
            cnContactIdentifier: cn.identifier
        )
        populateFields(contact, from: cn)
        return contact
    }

    private func updateContact(_ contact: Contact, from cn: CNContact) {
        contact.firstName = cn.givenName
        contact.lastName = cn.familyName
        contact.company = cn.organizationName.isEmpty ? nil : cn.organizationName
        contact.jobTitle = cn.jobTitle.isEmpty ? nil : cn.jobTitle
        populateFields(contact, from: cn)
        contact.updatedAt = Date()
    }

    private func populateFields(_ contact: Contact, from cn: CNContact) {
        contact.emails = cn.emailAddresses.map { $0.value as String }
        contact.phones = cn.phoneNumbers.map { $0.value.stringValue }
        let formatter = CNPostalAddressFormatter()
        contact.addresses = cn.postalAddresses.map { formatter.string(from: $0.value) }
        contact.photoData = cn.thumbnailImageData
        if let birthday = cn.birthday {
            contact.birthday = Calendar.current.date(from: birthday)
        }
        for profile in cn.socialProfiles {
            let service = profile.label ?? ""
            if service.localizedCaseInsensitiveContains("linkedin") {
                contact.linkedInURL = profile.value.urlString
            } else if service.localizedCaseInsensitiveContains("twitter") {
                contact.twitterHandle = profile.value.username
            }
        }
    }
}
