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
    var lastSyncDate: Date? {
        get { UserDefaults.standard.object(forKey: "contactSync.lastSyncDate") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "contactSync.lastSyncDate") }
    }
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

        // Run synchronously on the main thread to keep ModelContext safe.
        importContacts(into: modelContext)
        startObservingChanges()
    }

    func startObservingChanges() {
        guard changeObserver == nil else { return }

        changeObserver = NotificationCenter.default.addObserver(
            forName: .CNContactStoreDidChange,
            object: nil,
            queue: .main
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
            self.importContacts(into: modelContext)
        }
    }

    // MARK: - Import

    /// Imports contacts synchronously. Must be called on the main thread.
    func importContacts(into modelContext: ModelContext) {
        guard authorizationStatus == .authorized else {
            syncError = "Contacts access not authorized"; return
        }
        guard !isSyncing else { return }
        isSyncing = true; syncError = nil
        let started = Date()
        do {
            let cnContacts = try fetchAllSystemContacts()
            let outcome = try mergeOrInsert(cnContacts, into: modelContext)
            try modelContext.save()
            lastSyncDate = Date()
            logger.info("Contact sync completed — processed=\(cnContacts.count) updated=\(outcome.identifierMatched) reattached=\(outcome.reattached) inserted=\(outcome.inserted)")
            let durationMs = Int(Date().timeIntervalSince(started) * 1000)
            Log.action("contacts.sync", metadata: [
                "processed": "\(cnContacts.count)",
                "updated": "\(outcome.identifierMatched)",
                "reattached": "\(outcome.reattached)",
                "inserted": "\(outcome.inserted)"
            ], durationMs: durationMs, success: true)
        } catch {
            syncError = error.localizedDescription
            logger.error("Contact sync failed: \(error.localizedDescription)")
            Log.action("contacts.sync", success: false, error: error.localizedDescription)
        }
        isSyncing = false
        Task { await UserActionLogger.shared.uploadPending() }
    }

    // MARK: - Fetch for Selective Import

    /// Returns system contacts without importing. Must be called on main thread after authorization.
    func fetchSystemContacts() -> [CNContact] {
        guard authorizationStatus == .authorized else { return [] }
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
        var results: [CNContact] = []
        try? contactStore.enumerateContacts(with: request) { contact, _ in
            results.append(contact)
        }
        return results.sorted {
            let cmp = $0.familyName.localizedCaseInsensitiveCompare($1.familyName)
            if cmp != .orderedSame { return cmp == .orderedAscending }
            return $0.givenName.localizedCaseInsensitiveCompare($1.givenName) == .orderedAscending
        }
    }

    /// Import specific system contacts by identifier.
    func importSelected(_ identifiers: Set<String>, into modelContext: ModelContext) {
        guard !isSyncing else { return }
        isSyncing = true; syncError = nil
        let started = Date()
        do {
            let allSystem = fetchSystemContacts()
            let selected = allSystem.filter { identifiers.contains($0.identifier) }
            let outcome = try mergeOrInsert(selected, into: modelContext)
            try modelContext.save()
            lastSyncDate = Date()
            logger.info("Selective import completed — \(selected.count) contacts imported")
            let durationMs = Int(Date().timeIntervalSince(started) * 1000)
            Log.action("contacts.sync.selective", metadata: [
                "processed": "\(selected.count)",
                "updated": "\(outcome.identifierMatched)",
                "reattached": "\(outcome.reattached)",
                "inserted": "\(outcome.inserted)"
            ], durationMs: durationMs, success: true)
        } catch {
            syncError = error.localizedDescription
            logger.error("Selective import failed: \(error.localizedDescription)")
            Log.action("contacts.sync.selective", success: false, error: error.localizedDescription)
        }
        isSyncing = false
    }

    // MARK: - Match / Insert Pipeline

    private struct MergeOutcome {
        var identifierMatched = 0
        var reattached = 0
        var inserted = 0
    }

    private func fetchAllSystemContacts() throws -> [CNContact] {
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
        var results: [CNContact] = []
        try contactStore.enumerateContacts(with: request) { contact, _ in
            results.append(contact)
        }
        return results
    }

    /// Resolves each CNContact to an existing Blackbook Contact (reattaching by name +
    /// email/phone if the cnContactIdentifier no longer matches), or inserts a new one.
    /// Returns counts of each outcome.
    private func mergeOrInsert(_ cnContacts: [CNContact], into modelContext: ModelContext) throws -> MergeOutcome {
        var outcome = MergeOutcome()

        let allActive = try modelContext.fetch(
            FetchDescriptor<Contact>(predicate: #Predicate<Contact> { !$0.isMergedAway })
        )
        let identifierMap = Dictionary(uniqueKeysWithValues: allActive.compactMap { c in
            c.cnContactIdentifier.map { ($0, c) }
        })
        let liveIdentifiers = Set(cnContacts.map(\.identifier))

        // Build fallback indexes: name → contacts, email → contact, phone → contact.
        var nameIndex: [String: [Contact]] = [:]
        var emailIndex: [String: Contact] = [:]
        var phoneIndex: [String: Contact] = [:]
        for c in allActive {
            let key = Self.nameKey(first: c.firstName, last: c.lastName)
            if !key.isEmpty { nameIndex[key, default: []].append(c) }
            for e in c.emails {
                let k = Self.normalizeEmail(e)
                if !k.isEmpty, emailIndex[k] == nil { emailIndex[k] = c }
            }
            for p in c.phones {
                let k = Self.normalizePhone(p)
                if !k.isEmpty, phoneIndex[k] == nil { phoneIndex[k] = c }
            }
        }

        for cnContact in cnContacts {
            // Pass 1: existing identifier match.
            if let existing = identifierMap[cnContact.identifier] {
                updateContact(existing, from: cnContact)
                outcome.identifierMatched += 1
                continue
            }

            // Pass 2: fallback match by name OR shared email/phone.
            if let candidate = findFallbackMatch(
                cnContact,
                nameIndex: nameIndex,
                emailIndex: emailIndex,
                phoneIndex: phoneIndex,
                liveIdentifiers: liveIdentifiers
            ) {
                candidate.cnContactIdentifier = cnContact.identifier
                updateContact(candidate, from: cnContact)
                outcome.reattached += 1
                Log.action("contact.import.reattach", metadata: [
                    "contactId": candidate.id.uuidString,
                    "displayName": Self.displayName(candidate),
                    "newCNIdentifier": cnContact.identifier
                ])
                continue
            }

            // No match: insert new.
            let inserted = createContact(from: cnContact)
            modelContext.insert(inserted)
            outcome.inserted += 1
            Log.action("contact.import.insert", metadata: [
                "contactId": inserted.id.uuidString,
                "displayName": Self.displayName(inserted),
                "cnIdentifier": cnContact.identifier
            ])
        }
        return outcome
    }

    private func findFallbackMatch(_ cn: CNContact,
                                   nameIndex: [String: [Contact]],
                                   emailIndex: [String: Contact],
                                   phoneIndex: [String: Contact],
                                   liveIdentifiers: Set<String>) -> Contact? {
        let key = Self.nameKey(first: cn.givenName, last: cn.familyName)
        var byName: [Contact] = nameIndex[key] ?? []

        // Scan emails / phones for direct hits.
        var byEmailOrPhone: [Contact] = []
        for emailValue in cn.emailAddresses {
            let k = Self.normalizeEmail(emailValue.value as String)
            if let c = emailIndex[k] { byEmailOrPhone.append(c) }
        }
        for phoneValue in cn.phoneNumbers {
            let k = Self.normalizePhone(phoneValue.value.stringValue)
            if let c = phoneIndex[k] { byEmailOrPhone.append(c) }
        }

        // Combine candidates (name OR email/phone, per moderate match key).
        var candidates: [Contact] = byName + byEmailOrPhone
        candidates = candidates.uniqued()

        // Don't steal a contact whose existing identifier is still live in the iOS store.
        candidates.removeAll { c in
            if let existing = c.cnContactIdentifier, liveIdentifiers.contains(existing) { return true }
            return false
        }
        return candidates.first
    }

    private static func displayName(_ c: Contact) -> String {
        let name = "\(c.firstName) \(c.lastName)".trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "(unnamed)" : name
    }

    static func nameKey(first: String, last: String) -> String {
        let combined = "\(first)|\(last)"
            .folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return combined == "|" ? "" : combined
    }

    static func normalizeEmail(_ raw: String) -> String {
        raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func normalizePhone(_ raw: String) -> String {
        raw.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) }.map(String.init).joined()
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
            } else if service.localizedCaseInsensitiveContains("instagram") {
                contact.instagramHandle = profile.value.username
            }
        }
    }
}

private extension Array where Element == Contact {
    /// Returns the receiver with duplicates removed, preserving order, identifying contacts by their `id`.
    func uniqued() -> [Contact] {
        var seen: Set<UUID> = []
        var result: [Contact] = []
        result.reserveCapacity(count)
        for c in self where seen.insert(c.id).inserted {
            result.append(c)
        }
        return result
    }
}
