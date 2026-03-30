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
        let pendingContacts = try fetchPendingContacts(context: context)
        logger.info("Pushing \(pendingContacts.count) contact(s)")

        if !isConnected {
            for contact in pendingContacts { enqueueOfflineRecord(for: contact) }
            return
        }

        let contactsPayload = pendingContacts.map { ContactSyncApply.contactToDict($0) }
        let body: [String: Any] = ["contacts": contactsPayload]
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

        for contact in pendingContacts {
            contact.syncStatus = SyncStatus.synced.rawValue
            contact.lastSyncedAt = Date()
            contact.syncVersion += 1
        }
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

        guard let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let contacts = top["contacts"] as? [[String: Any]] else {
            return
        }
        logger.info("Pulled \(contacts.count) contact(s)")

        for dict in contacts {
            try ContactSyncApply.applyRemoteContact(dict, to: context)
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
