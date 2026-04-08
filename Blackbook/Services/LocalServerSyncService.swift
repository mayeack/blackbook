import Foundation
import SwiftData
import Observation
import os
import Network

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "LocalSync")

@Observable
final class LocalServerSyncService {
    var isSyncing = false
    var lastSyncDate: Date?
    var syncError: String?
    var pendingChangesCount = 0

    private var modelContext: ModelContext?
    private let networkMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "com.blackbookdevelopment.localsync.monitor")
    private var isConnected = true
    private var offlineQueue: [SyncRecord] = []

    private static let offlineQueueKey = "localsync.offlineQueue"
    private static let lastSyncKey = "localsync.lastSyncDate"

    init() {
        loadOfflineQueue()
        loadLastSyncDate()
        startNetworkMonitoring()
    }

    deinit {
        networkMonitor.cancel()
    }

    func configure(with context: ModelContext) {
        modelContext = context
    }

    /// Returns true if server URL and password are configured.
    var isConfigured: Bool {
        baseURL != nil && password != nil
    }

    private var baseURL: String? {
        KeychainService.retrieve(
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainServerURLAccount
        )
    }

    private var password: String? {
        KeychainService.retrieve(
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainPasswordAccount
        )
    }

    private func startNetworkMonitoring() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let wasDisconnected = !(self?.isConnected ?? true)
            self?.isConnected = path.status == .satisfied
            if wasDisconnected && path.status == .satisfied {
                logger.info("Network restored — flushing offline queue")
                Task { await self?.flushOfflineQueue() }
            }
        }
        networkMonitor.start(queue: monitorQueue)
    }

    func performFullSync() async {
        guard let modelContext, !isSyncing else { return }
        guard let baseURL, let password, let url = URL(string: baseURL), !baseURL.isEmpty else {
            syncError = "Sync server not configured. Add server URL and password in Settings."
            return
        }
        isSyncing = true
        syncError = nil
        defer { isSyncing = false }

        do {
            try await pushLocalChanges(context: modelContext, baseURL: url, password: password)
            try await pullRemoteChanges(context: modelContext, baseURL: url, password: password)
            lastSyncDate = Date()
            saveLastSyncDate()
            logger.info("Local sync completed")
        } catch {
            syncError = error.localizedDescription
            logger.error("Local sync failed: \(error.localizedDescription)")
        }
    }

    private func pushLocalChanges(context: ModelContext, baseURL: URL, password: String) async throws {
        let syncedStatus = SyncStatus.synced.rawValue

        // Fetch all pending records across all model types
        let pendingTags = try context.fetch(FetchDescriptor<Tag>(predicate: #Predicate<Tag> { $0.syncStatus != syncedStatus }))
        let pendingGroups = try context.fetch(FetchDescriptor<Group>(predicate: #Predicate<Group> { $0.syncStatus != syncedStatus }))
        let pendingLocations = try context.fetch(FetchDescriptor<Location>(predicate: #Predicate<Location> { $0.syncStatus != syncedStatus }))
        let pendingActivities = try context.fetch(FetchDescriptor<Activity>(predicate: #Predicate<Activity> { $0.syncStatus != syncedStatus }))
        let pendingContacts = try fetchPendingContacts(context: context)
        let pendingInteractions = try context.fetch(FetchDescriptor<Interaction>(predicate: #Predicate<Interaction> { $0.syncStatus != syncedStatus }))
        let pendingNotes = try context.fetch(FetchDescriptor<Note>(predicate: #Predicate<Note> { $0.syncStatus != syncedStatus }))
        let pendingReminders = try context.fetch(FetchDescriptor<Reminder>(predicate: #Predicate<Reminder> { $0.syncStatus != syncedStatus }))
        let pendingRelationships = try context.fetch(FetchDescriptor<ContactRelationship>(predicate: #Predicate<ContactRelationship> { $0.syncStatus != syncedStatus }))

        let totalPending = pendingTags.count + pendingGroups.count + pendingLocations.count +
            pendingActivities.count + pendingContacts.count + pendingInteractions.count +
            pendingNotes.count + pendingReminders.count + pendingRelationships.count
        logger.info("Pushing \(totalPending) record(s)")

        guard totalPending > 0 else { return }

        if !isConnected {
            for contact in pendingContacts { enqueueOfflineRecord(for: contact) }
            return
        }

        // Build multi-model payload in dependency order
        var body: [String: Any] = [:]
        if !pendingTags.isEmpty { body["tags"] = pendingTags.map { ModelSyncApply.tagToDict($0) } }
        if !pendingGroups.isEmpty { body["groups"] = pendingGroups.map { ModelSyncApply.groupToDict($0) } }
        if !pendingLocations.isEmpty { body["locations"] = pendingLocations.map { ModelSyncApply.locationToDict($0) } }
        if !pendingActivities.isEmpty { body["activities"] = pendingActivities.map { ModelSyncApply.activityToDict($0) } }
        if !pendingContacts.isEmpty { body["contacts"] = pendingContacts.map { ContactSyncApply.contactToDict($0) } }
        if !pendingInteractions.isEmpty { body["interactions"] = pendingInteractions.map { ModelSyncApply.interactionToDict($0) } }
        if !pendingNotes.isEmpty { body["notes"] = pendingNotes.map { ModelSyncApply.noteToDict($0) } }
        if !pendingReminders.isEmpty { body["reminders"] = pendingReminders.map { ModelSyncApply.reminderToDict($0) } }
        if !pendingRelationships.isEmpty { body["contactRelationships"] = pendingRelationships.map { ModelSyncApply.contactRelationshipToDict($0) } }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }

        var comp = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comp.path = LocalSyncProtocol.Path.syncChanges
        guard let endpoint = comp.url else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(password, forHTTPHeaderField: LocalSyncProtocol.passwordHeader)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw NSError(domain: "LocalSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "Server returned error"])
        }

        // Mark all pushed records as synced
        let now = Date()
        for tag in pendingTags { tag.syncStatus = SyncStatus.synced.rawValue; tag.lastSyncedAt = now }
        for group in pendingGroups { group.syncStatus = SyncStatus.synced.rawValue; group.lastSyncedAt = now }
        for location in pendingLocations { location.syncStatus = SyncStatus.synced.rawValue; location.lastSyncedAt = now }
        for activity in pendingActivities { activity.syncStatus = SyncStatus.synced.rawValue; activity.lastSyncedAt = now }
        for contact in pendingContacts { contact.syncStatus = SyncStatus.synced.rawValue; contact.lastSyncedAt = now; contact.syncVersion += 1 }
        for interaction in pendingInteractions { interaction.syncStatus = SyncStatus.synced.rawValue; interaction.lastSyncedAt = now }
        for note in pendingNotes { note.syncStatus = SyncStatus.synced.rawValue; note.lastSyncedAt = now }
        for reminder in pendingReminders { reminder.syncStatus = SyncStatus.synced.rawValue; reminder.lastSyncedAt = now }
        for rel in pendingRelationships { rel.syncStatus = SyncStatus.synced.rawValue; rel.lastSyncedAt = now }
        try context.save()
    }

    private func pullRemoteChanges(context: ModelContext, baseURL: URL, password: String) async throws {
        let since = lastSyncDate ?? Date.distantPast
        var comp = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comp.path = LocalSyncProtocol.Path.syncChanges
        comp.queryItems = [URLQueryItem(name: "since", value: ISO8601DateFormatter().string(from: since))]
        guard let endpoint = comp.url else {
            throw NSError(domain: "LocalSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid pull URL"])
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.setValue(password, forHTTPHeaderField: LocalSyncProtocol.passwordHeader)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw NSError(domain: "LocalSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "Pull failed"])
        }

        guard let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        // Apply in dependency order: leaf entities first

        // Layer 0: Tags, Groups, Locations, RejectedCalendarEvents
        if let tags = top["tags"] as? [[String: Any]] {
            logger.info("Pulled \(tags.count) tag(s)")
            for dict in tags { try ModelSyncApply.applyRemoteTag(dict, to: context) }
        }
        if let groups = top["groups"] as? [[String: Any]] {
            logger.info("Pulled \(groups.count) group(s)")
            for dict in groups { try ModelSyncApply.applyRemoteGroup(dict, to: context) }
        }
        if let locations = top["locations"] as? [[String: Any]] {
            logger.info("Pulled \(locations.count) location(s)")
            for dict in locations { try ModelSyncApply.applyRemoteLocation(dict, to: context) }
        }
        if let events = top["rejectedCalendarEvents"] as? [[String: Any]] {
            for dict in events { try ModelSyncApply.applyRemoteRejectedEvent(dict, to: context) }
        }

        // Layer 1: Activities (references Groups)
        if let activities = top["activities"] as? [[String: Any]] {
            logger.info("Pulled \(activities.count) activity(ies)")
            for dict in activities { try ModelSyncApply.applyRemoteActivity(dict, to: context) }
        }

        // Layer 2: Contacts (references Tags, Groups, Locations, Activities)
        if let contacts = top["contacts"] as? [[String: Any]] {
            logger.info("Pulled \(contacts.count) contact(s)")
            for dict in contacts { try ContactSyncApply.applyRemoteContact(dict, to: context) }
        }

        // Layer 3: Child entities (reference Contacts)
        if let interactions = top["interactions"] as? [[String: Any]] {
            logger.info("Pulled \(interactions.count) interaction(s)")
            for dict in interactions { try ModelSyncApply.applyRemoteInteraction(dict, to: context) }
        }
        if let notes = top["notes"] as? [[String: Any]] {
            logger.info("Pulled \(notes.count) note(s)")
            for dict in notes { try ModelSyncApply.applyRemoteNote(dict, to: context) }
        }
        if let reminders = top["reminders"] as? [[String: Any]] {
            logger.info("Pulled \(reminders.count) reminder(s)")
            for dict in reminders { try ModelSyncApply.applyRemoteReminder(dict, to: context) }
        }
        if let rels = top["contactRelationships"] as? [[String: Any]] {
            logger.info("Pulled \(rels.count) relationship(s)")
            for dict in rels { try ModelSyncApply.applyRemoteContactRelationship(dict, to: context) }
        }

        try context.save()
    }

    private func fetchPendingContacts(context: ModelContext) throws -> [Contact] {
        let syncedStatus = SyncStatus.synced.rawValue
        let predicate = #Predicate<Contact> { $0.syncStatus != syncedStatus }
        var descriptor = FetchDescriptor<Contact>(predicate: predicate)
        descriptor.fetchLimit = 500
        return try context.fetch(descriptor)
    }

    private func enqueueOfflineRecord(for contact: Contact) {
        guard let data = try? JSONSerialization.data(withJSONObject: ContactSyncApply.contactToDict(contact)) else { return }
        let record = SyncRecord(
            id: contact.id.uuidString,
            modelType: "Contact",
            operation: contact.syncStatus == SyncStatus.deleted.rawValue ? .delete : .update,
            payload: data,
            timestamp: Date()
        )
        offlineQueue.append(record)
        pendingChangesCount = offlineQueue.count
        saveOfflineQueue()
    }

    private func flushOfflineQueue() async {
        guard isConnected, let baseURL, let password, let url = URL(string: baseURL),
              let modelContext, !offlineQueue.isEmpty else { return }
        logger.info("Flushing \(self.offlineQueue.count) offline record(s)")
        var remaining: [SyncRecord] = []
        var contactsPayload: [[String: Any]] = []
        var deletes: [String] = []
        for record in offlineQueue {
            if record.operation == .delete {
                deletes.append(record.id)
            } else if let dict = try? JSONSerialization.jsonObject(with: record.payload) as? [String: Any] {
                contactsPayload.append(dict)
            }
        }
        let body: [String: Any] = ["contacts": contactsPayload]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return }
        var comp = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comp.path = LocalSyncProtocol.Path.syncChanges
        guard let endpoint = comp.url else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(password, forHTTPHeaderField: LocalSyncProtocol.passwordHeader)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData
        do {
            let (_, resp) = try await URLSession.shared.data(for: request)
            if (resp as? HTTPURLResponse)?.statusCode == 200 {
                offlineQueue.removeAll()
                try? modelContext.save()
            }
        } catch {
            logger.warning("Offline flush failed: \(error.localizedDescription)")
        }
        pendingChangesCount = offlineQueue.count
        saveOfflineQueue()
    }

    private func saveOfflineQueue() {
        guard let data = try? JSONEncoder().encode(offlineQueue) else { return }
        UserDefaults.standard.set(data, forKey: Self.offlineQueueKey)
    }

    private func loadOfflineQueue() {
        guard let data = UserDefaults.standard.data(forKey: Self.offlineQueueKey),
              let queue = try? JSONDecoder().decode([SyncRecord].self, from: data) else { return }
        offlineQueue = queue
        pendingChangesCount = queue.count
    }

    private func saveLastSyncDate() {
        UserDefaults.standard.set(lastSyncDate, forKey: Self.lastSyncKey)
    }

    private func loadLastSyncDate() {
        lastSyncDate = UserDefaults.standard.object(forKey: Self.lastSyncKey) as? Date
    }
}
