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
    private var periodicTask: Task<Void, Never>?
    /// Scheduled after any in-flight sync failure to retry quickly (~30s) without waiting for the
    /// 5-min periodic tick. Cancelled on next successful sync and on `stopPeriodicSync` / deinit.
    private var failureRetryTask: Task<Void, Never>?
    private static let failureRetryDelay: TimeInterval = 30

    private static let offlineQueueKey = "localsync.offlineQueue"
    private static let lastSyncKey = "localsync.lastSyncDate"
    private static let lastSeenEpochKey = "localsync.lastSeenServerEpoch"
    private static let serverEpochHeader = "X-Server-Epoch"

    /// The server's epoch UUID as seen on the most recent successful HTTP response. A mismatch
    /// against the value the server sends on a subsequent response means the master store has
    /// been reset and the client should bootstrap a full re-push.
    private var lastSeenEpoch: String? {
        get { UserDefaults.standard.string(forKey: Self.lastSeenEpochKey) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: Self.lastSeenEpochKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.lastSeenEpochKey)
            }
        }
    }

    init() {
        loadOfflineQueue()
        loadLastSyncDate()
        startNetworkMonitoring()
    }

    deinit {
        networkMonitor.cancel()
        periodicTask?.cancel()
        failureRetryTask?.cancel()
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

    /// Starts a repeating background sync that fires every `intervalSeconds` while the app is foregrounded.
    /// Safe to call multiple times — any previous loop is cancelled first.
    func startPeriodicSync(intervalSeconds: TimeInterval = 300) {
        periodicTask?.cancel()
        periodicTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(intervalSeconds))
                if Task.isCancelled { break }
                await self?.performFullSync()
            }
        }
        logger.info("Periodic sync started (interval: \(Int(intervalSeconds))s)")
    }

    func stopPeriodicSync() {
        periodicTask?.cancel()
        periodicTask = nil
        failureRetryTask?.cancel()
        failureRetryTask = nil
    }

    /// Compares the server epoch from the most recent response against the last one we stored.
    /// On change (or first-ever sight): marks every locally-synced record as pending so the next
    /// push pumps the whole local store up to the master, and resets `lastSyncDate` so the next
    /// pull is a full pull. Returns `true` iff a bootstrap was triggered (caller may want to
    /// recompute pushPendingCount in that case).
    @discardableResult
    private func handleServerEpoch(_ epoch: String?, context: ModelContext) -> Bool {
        guard let epoch, !epoch.isEmpty else { return false }
        let previous = lastSeenEpoch
        guard previous != epoch else { return false }
        logger.info("Server epoch changed (\(previous ?? "nil") -> \(epoch)) — bootstrapping full re-sync")
        Log.action("sync.bootstrap", metadata: ["from": previous ?? "nil", "to": epoch])
        markAllSyncedRecordsPending(context: context)
        lastSyncDate = nil
        saveLastSyncDate()
        lastSeenEpoch = epoch
        return true
    }

    /// One-time bootstrap sweep: flips every record currently marked `.synced` to `.pending` so
    /// the next push uploads the entire local store. Records in `.deleted` (tombstones awaiting
    /// push), `.modified` (in-progress edits), or already `.pending` are left untouched —
    /// touching them would corrupt deletion intent or merge state.
    private func markAllSyncedRecordsPending(context: ModelContext) {
        let synced = SyncStatus.synced.rawValue
        let pending = SyncStatus.pending.rawValue
        var flippedCount = 0
        func flip<T: PersistentModel>(_ type: T.Type, _ predicate: Predicate<T>, _ apply: (T) -> Void) {
            guard let records = try? context.fetch(FetchDescriptor<T>(predicate: predicate)) else { return }
            for r in records { apply(r) }
            flippedCount += records.count
        }
        flip(Tag.self, #Predicate<Tag> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(Group.self, #Predicate<Group> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(Location.self, #Predicate<Location> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(Activity.self, #Predicate<Activity> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(Contact.self, #Predicate<Contact> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(Interaction.self, #Predicate<Interaction> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(Note.self, #Predicate<Note> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(Reminder.self, #Predicate<Reminder> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(ContactRelationship.self, #Predicate<ContactRelationship> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        flip(RejectedCalendarEvent.self, #Predicate<RejectedCalendarEvent> { $0.syncStatus == synced }) { $0.syncStatus = pending }
        try? context.save()
        logger.info("Bootstrap marked \(flippedCount) record(s) pending")
        Log.action("sync.bootstrap.markPending", metadata: ["count": "\(flippedCount)"])
    }

    func performFullSync() async {
        guard let modelContext, !isSyncing else { return }
        guard let baseURL, let password, let url = URL(string: baseURL), !baseURL.isEmpty else {
            syncError = "Sync server not configured. Add server URL and password in Settings."
            Log.action("sync.local", success: false, error: "server not configured")
            await sendHeartbeat(baseURL: nil, password: nil, status: "skipped", error: "server not configured")
            return
        }
        isSyncing = true
        syncError = nil
        defer { isSyncing = false }

        let started = Date()
        var pushedCount = pushPendingCount(context: modelContext)
        Log.action("sync.local.start", metadata: ["pushPending": "\(pushedCount)"])
        let startedEpoch = await sendHeartbeat(baseURL: url, password: password, status: "started", pushPending: pushedCount)
        // Before we push, check whether the server's epoch has changed. A change means the master
        // store was reset (or this is the client's first sync ever), in which case we mark every
        // locally-synced record as pending so the next step pushes the full local store up.
        if handleServerEpoch(startedEpoch, context: modelContext) {
            pushedCount = pushPendingCount(context: modelContext)
        }
        do {
            try await pushLocalChanges(context: modelContext, baseURL: url, password: password)
            try await pullRemoteChanges(context: modelContext, baseURL: url, password: password)
            lastSyncDate = Date()
            saveLastSyncDate()
            logger.info("Local sync completed")
            let durationMs = Int(Date().timeIntervalSince(started) * 1000)
            Log.action("sync.local", metadata: ["pushed": "\(pushedCount)"], durationMs: durationMs, success: true)
            await sendHeartbeat(baseURL: url, password: password, status: "success", pushPending: pushedCount, durationMs: durationMs)
            // Sync succeeded — cancel any pending fast retry from a previous failure.
            failureRetryTask?.cancel()
            failureRetryTask = nil
            // Tell observers (e.g. DashboardView) to re-fetch from the settled store.
            NotificationCenter.default.post(name: .blackbookSyncDidComplete, object: nil)
        } catch {
            syncError = error.localizedDescription
            logger.error("Local sync failed: \(error.localizedDescription)")
            Log.action("sync.local", success: false, error: error.localizedDescription)
            let durationMs = Int(Date().timeIntervalSince(started) * 1000)
            await sendHeartbeat(baseURL: url, password: password, status: "failed", pushPending: pushedCount, durationMs: durationMs, error: error.localizedDescription)
            scheduleFailureRetry()
        }
        await UserActionLogger.shared.uploadPending()
    }

    /// Schedule a single fast retry of `performFullSync` after a transient sync failure. The retry
    /// fires after `failureRetryDelay` seconds. At most one retry is queued at any time — a new
    /// failure cancels and reschedules. A successful sync also cancels the queued retry.
    private func scheduleFailureRetry() {
        failureRetryTask?.cancel()
        failureRetryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.failureRetryDelay))
            guard let self, !Task.isCancelled else { return }
            logger.info("Retrying sync \(Int(Self.failureRetryDelay))s after failure")
            await self.performFullSync()
        }
    }

    /// Best-effort heartbeat ping. Records a check-in line server-side regardless of whether
    /// a data sync occurred or succeeded. Never throws — heartbeat failure must not break sync.
    /// Returns the server's `X-Server-Epoch` header value (if any), so callers can detect a
    /// master-store reset and trigger a bootstrap.
    @discardableResult
    private func sendHeartbeat(baseURL: URL?,
                               password: String?,
                               status: String,
                               pushPending: Int = 0,
                               durationMs: Int? = nil,
                               error: String? = nil) async -> String? {
        guard let baseURL, let password else { return nil }
        var comp = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comp.path = LocalSyncProtocol.Path.heartbeat
        guard let endpoint = comp.url else { return nil }

        var body: [String: Any] = [
            "platform": Self.currentPlatform,
            "device": Self.currentDeviceName,
            "appVersion": Self.currentAppVersion,
            "status": status,
            "sentAt": ISO8601DateFormatter().string(from: Date()),
            "pushPending": pushPending,
            "lastSyncDate": lastSyncDate.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull()
        ]
        if let durationMs { body["durationMs"] = durationMs }
        if let error { body["error"] = error }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return nil }

        let email = UserDefaults.standard.string(forKey: "auth.userEmail") ?? ""

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(password, forHTTPHeaderField: LocalSyncProtocol.passwordHeader)
        request.setValue(email, forHTTPHeaderField: LocalSyncProtocol.userEmailHeader)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData
        request.timeoutInterval = 5

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                logger.debug("Heartbeat \(status) ack")
                return http.value(forHTTPHeaderField: Self.serverEpochHeader)
            } else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                logger.warning("Heartbeat \(status) returned status \(code)")
            }
        } catch {
            logger.warning("Heartbeat \(status) failed: \(error.localizedDescription)")
        }
        return nil
    }

    private static var currentPlatform: String {
        #if os(iOS)
        return "iOS"
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }

    private static var currentDeviceName: String {
        BackupService.currentDeviceName
    }

    private static var currentAppVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "unknown"
    }

    /// User email for the `X-User-Email` header on sync requests. The deployed BlackbookServer
    /// requires this header on every authenticated route (see `BackupServer.handleAuthed`).
    private static var currentUserEmail: String {
        UserDefaults.standard.string(forKey: "auth.userEmail") ?? ""
    }

    private func pushPendingCount(context: ModelContext) -> Int {
        let synced = SyncStatus.synced.rawValue
        var total = 0
        let tagDescriptor = FetchDescriptor<Tag>(predicate: #Predicate<Tag> { $0.syncStatus != synced })
        total += (try? context.fetchCount(tagDescriptor)) ?? 0
        let groupDescriptor = FetchDescriptor<Group>(predicate: #Predicate<Group> { $0.syncStatus != synced })
        total += (try? context.fetchCount(groupDescriptor)) ?? 0
        let locationDescriptor = FetchDescriptor<Location>(predicate: #Predicate<Location> { $0.syncStatus != synced })
        total += (try? context.fetchCount(locationDescriptor)) ?? 0
        let activityDescriptor = FetchDescriptor<Activity>(predicate: #Predicate<Activity> { $0.syncStatus != synced })
        total += (try? context.fetchCount(activityDescriptor)) ?? 0
        let contactDescriptor = FetchDescriptor<Contact>(predicate: #Predicate<Contact> { $0.syncStatus != synced })
        total += (try? context.fetchCount(contactDescriptor)) ?? 0
        let interactionDescriptor = FetchDescriptor<Interaction>(predicate: #Predicate<Interaction> { $0.syncStatus != synced })
        total += (try? context.fetchCount(interactionDescriptor)) ?? 0
        let noteDescriptor = FetchDescriptor<Note>(predicate: #Predicate<Note> { $0.syncStatus != synced })
        total += (try? context.fetchCount(noteDescriptor)) ?? 0
        let reminderDescriptor = FetchDescriptor<Reminder>(predicate: #Predicate<Reminder> { $0.syncStatus != synced })
        total += (try? context.fetchCount(reminderDescriptor)) ?? 0
        let relationshipDescriptor = FetchDescriptor<ContactRelationship>(predicate: #Predicate<ContactRelationship> { $0.syncStatus != synced })
        total += (try? context.fetchCount(relationshipDescriptor)) ?? 0
        return total
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
        request.setValue(Self.currentUserEmail, forHTTPHeaderField: LocalSyncProtocol.userEmailHeader)
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
        request.setValue(Self.currentUserEmail, forHTTPHeaderField: LocalSyncProtocol.userEmailHeader)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw NSError(domain: "LocalSync", code: -1, userInfo: [NSLocalizedDescriptionKey: "Pull failed"])
        }

        guard let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        // Apply on a separate ModelContext, then save once. This keeps the in-flight, partial-state
        // working set invisible to the main context's @Queries — which previously crashed during
        // SwiftData inverse-relationship faulting on partial pulls (work_log 2026-06-01 macOS,
        // 2026-06-02 iOS). With a single atomic commit, the main context only ever observes
        // settled state.
        let bgContext = ModelContext(context.container)
        bgContext.autosaveEnabled = false

        // Layer 0: Tags, Groups, Locations, RejectedCalendarEvents
        if let tags = top["tags"] as? [[String: Any]] {
            logger.info("Pulled \(tags.count) tag(s)")
            for dict in tags { try ModelSyncApply.applyRemoteTag(dict, to: bgContext) }
        }
        if let groups = top["groups"] as? [[String: Any]] {
            logger.info("Pulled \(groups.count) group(s)")
            for dict in groups { try ModelSyncApply.applyRemoteGroup(dict, to: bgContext) }
        }
        if let locations = top["locations"] as? [[String: Any]] {
            logger.info("Pulled \(locations.count) location(s)")
            for dict in locations { try ModelSyncApply.applyRemoteLocation(dict, to: bgContext) }
        }
        if let events = top["rejectedCalendarEvents"] as? [[String: Any]] {
            for dict in events { try ModelSyncApply.applyRemoteRejectedEvent(dict, to: bgContext) }
        }

        // Layer 1: Activities (references Groups)
        if let activities = top["activities"] as? [[String: Any]] {
            logger.info("Pulled \(activities.count) activity(ies)")
            for dict in activities { try ModelSyncApply.applyRemoteActivity(dict, to: bgContext) }
        }

        // Layer 2: Contacts (references Tags, Groups, Locations, Activities)
        if let contacts = top["contacts"] as? [[String: Any]] {
            logger.info("Pulled \(contacts.count) contact(s)")
            for dict in contacts { try ContactSyncApply.applyRemoteContact(dict, to: bgContext) }
        }

        // Layer 3: Child entities (reference Contacts)
        if let interactions = top["interactions"] as? [[String: Any]] {
            logger.info("Pulled \(interactions.count) interaction(s)")
            for dict in interactions { try ModelSyncApply.applyRemoteInteraction(dict, to: bgContext) }
        }
        if let notes = top["notes"] as? [[String: Any]] {
            logger.info("Pulled \(notes.count) note(s)")
            for dict in notes { try ModelSyncApply.applyRemoteNote(dict, to: bgContext) }
        }
        if let reminders = top["reminders"] as? [[String: Any]] {
            logger.info("Pulled \(reminders.count) reminder(s)")
            for dict in reminders { try ModelSyncApply.applyRemoteReminder(dict, to: bgContext) }
        }
        if let rels = top["contactRelationships"] as? [[String: Any]] {
            logger.info("Pulled \(rels.count) relationship(s)")
            for dict in rels { try ModelSyncApply.applyRemoteContactRelationship(dict, to: bgContext) }
        }

        try bgContext.save()
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
        request.setValue(Self.currentUserEmail, forHTTPHeaderField: LocalSyncProtocol.userEmailHeader)
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

extension Notification.Name {
    /// Posted by `LocalServerSyncService` after a full sync completes successfully. Views that
    /// snapshot the store on demand (e.g. `DashboardView`) can re-fetch in response.
    static let blackbookSyncDidComplete = Notification.Name("com.blackbookdevelopment.sync.didComplete")
}
