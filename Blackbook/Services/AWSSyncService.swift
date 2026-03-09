import Foundation
import SwiftData
import Amplify
import Observation
import os
import Network

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "AWSSync")

@Observable
final class AWSSyncService {
    var isSyncing = false
    var lastSyncDate: Date?
    var syncError: String?
    var pendingChangesCount = 0

    private var modelContext: ModelContext?
    private let networkMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "com.blackbookdevelopment.syncmonitor")
    private var isConnected = true
    private var offlineQueue: [SyncRecord] = []

    private static let offlineQueueKey = "awssync.offlineQueue"
    private static let lastSyncKey = "awssync.lastSyncDate"

    init() {
        loadOfflineQueue()
        loadLastSyncDate()
        startNetworkMonitoring()
    }

    deinit {
        networkMonitor.cancel()
    }

    // MARK: - Setup

    func configure(with context: ModelContext) {
        self.modelContext = context
    }

    // MARK: - Network Monitoring

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

    // MARK: - Full Sync

    func performFullSync() async {
        guard let modelContext, !isSyncing else { return }
        isSyncing = true
        syncError = nil
        defer { isSyncing = false }

        do {
            try await pushLocalChanges(context: modelContext)
            try await pullRemoteChanges(context: modelContext)

            lastSyncDate = Date()
            saveLastSyncDate()
            logger.info("Full sync completed")
        } catch {
            syncError = error.localizedDescription
            logger.error("Sync failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Push Local Changes

    private func pushLocalChanges(context: ModelContext) async throws {
        let pendingContacts = try fetchPendingContacts(context: context)
        logger.info("Pushing \(pendingContacts.count) pending contact(s)")

        for contact in pendingContacts {
            if !isConnected {
                enqueueOfflineRecord(for: contact)
                continue
            }

            let document = buildContactMutation(contact)
            do {
                let request = GraphQLRequest<JSONValue>(
                    apiName: AppConstants.AWS.graphQLAPIName,
                    document: document.query,
                    variables: document.variables,
                    responseType: JSONValue.self
                )
                _ = try await Amplify.API.mutate(request: request).get()
                contact.syncStatus = SyncStatus.synced.rawValue
                contact.lastSyncedAt = Date()
                contact.syncVersion += 1
            } catch {
                logger.warning("Failed to push contact \(contact.id): \(error.localizedDescription)")
                enqueueOfflineRecord(for: contact)
            }
        }

        try context.save()
    }

    // MARK: - Pull Remote Changes

    private func pullRemoteChanges(context: ModelContext) async throws {
        let since = lastSyncDate ?? Date.distantPast
        let query = """
        query ListContacts($filter: ModelContactFilterInput, $limit: Int) {
            listContacts(filter: $filter, limit: $limit) {
                items {
                    id
                    firstName
                    lastName
                    company
                    jobTitle
                    emails
                    phones
                    addresses
                    birthday
                    photoS3Key
                    interests
                    familyDetails
                    linkedInURL
                    twitterHandle
                    customFields
                    relationshipScore
                    lastInteractionDate
                    isPriority
                    isHidden
                    isMergedAway
                    scoreTrendRaw
                    createdAt
                    updatedAt
                }
                nextToken
            }
        }
        """
        let variables: [String: Any] = [
            "filter": [
                "updatedAt": ["gt": ISO8601DateFormatter().string(from: since)]
            ],
            "limit": 1000
        ]

        let request = GraphQLRequest<JSONValue>(
            apiName: AppConstants.AWS.graphQLAPIName,
            document: query,
            variables: variables,
            responseType: JSONValue.self
        )

        let response = try await Amplify.API.query(request: request).get()

        guard case .object(let root) = response,
              case .object(let listContacts) = root["listContacts"],
              case .array(let items) = listContacts["items"] else {
            logger.info("No remote changes to pull")
            return
        }

        logger.info("Pulled \(items.count) remote contact(s)")

        for item in items {
            try applyRemoteContact(item, to: context)
        }

        try context.save()
    }

    // MARK: - Offline Queue

    private func enqueueOfflineRecord(for contact: Contact) {
        guard let data = try? JSONSerialization.data(withJSONObject: contactToDict(contact)) else { return }
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
        logger.info("Enqueued offline record for contact \(contact.id)")
    }

    private func flushOfflineQueue() async {
        guard isConnected, !offlineQueue.isEmpty else { return }
        logger.info("Flushing \(self.offlineQueue.count) offline record(s)")

        var remaining: [SyncRecord] = []

        for record in offlineQueue {
            do {
                let mutation = buildMutationFromRecord(record)
                let request = GraphQLRequest<JSONValue>(
                    apiName: AppConstants.AWS.graphQLAPIName,
                    document: mutation.query,
                    variables: mutation.variables,
                    responseType: JSONValue.self
                )
                _ = try await Amplify.API.mutate(request: request).get()
            } catch {
                logger.warning("Failed to flush record \(record.id): \(error.localizedDescription)")
                remaining.append(record)
            }
        }

        offlineQueue = remaining
        pendingChangesCount = remaining.count
        saveOfflineQueue()
    }

    // MARK: - Persistence for Offline Queue

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

    // MARK: - Query Helpers

    private func fetchPendingContacts(context: ModelContext) throws -> [Contact] {
        let syncedStatus = SyncStatus.synced.rawValue
        let predicate = #Predicate<Contact> { $0.syncStatus != syncedStatus }
        var descriptor = FetchDescriptor<Contact>(predicate: predicate)
        descriptor.fetchLimit = 500
        return try context.fetch(descriptor)
    }

    // MARK: - Mutation Builders

    private struct GraphQLDocument {
        let query: String
        let variables: [String: Any]
    }

    private func buildContactMutation(_ contact: Contact) -> GraphQLDocument {
        let mutation = """
        mutation UpsertContact($input: CreateContactInput!) {
            createContact(input: $input) {
                id
            }
        }
        """
        let variables: [String: Any] = [
            "input": contactToDict(contact)
        ]
        return GraphQLDocument(query: mutation, variables: variables)
    }

    private func buildMutationFromRecord(_ record: SyncRecord) -> GraphQLDocument {
        let mutation: String
        if record.operation == .delete {
            mutation = """
            mutation DeleteContact($input: DeleteContactInput!) {
                deleteContact(input: $input) { id }
            }
            """
            return GraphQLDocument(
                query: mutation,
                variables: ["input": ["id": record.id]]
            )
        }

        mutation = """
        mutation UpsertContact($input: CreateContactInput!) {
            createContact(input: $input) { id }
        }
        """
        let dict = (try? JSONSerialization.jsonObject(
            with: record.payload
        ) as? [String: Any]) ?? ["id": record.id]
        return GraphQLDocument(query: mutation, variables: ["input": dict])
    }

    private func contactToDict(_ contact: Contact) -> [String: Any] {
        var dict: [String: Any] = [
            "id": contact.id.uuidString,
            "firstName": contact.firstName,
            "lastName": contact.lastName,
            "emails": contact.emails,
            "phones": contact.phones,
            "addresses": contact.addresses,
            "interests": contact.interests,
            "relationshipScore": contact.relationshipScore,
            "isPriority": contact.isPriority,
            "isHidden": contact.isHidden,
            "isMergedAway": contact.isMergedAway,
            "scoreTrendRaw": contact.scoreTrendRaw,
            "createdAt": ISO8601DateFormatter().string(from: contact.createdAt),
            "updatedAt": ISO8601DateFormatter().string(from: contact.updatedAt),
            "tagIds": contact.tags.map { $0.id.uuidString },
            "groupIds": contact.groups.map { $0.id.uuidString },
            "locationIds": contact.locations.map { $0.id.uuidString },
            "activityIds": contact.activities.map { $0.id.uuidString }
        ]

        if let company = contact.company { dict["company"] = company }
        if let jobTitle = contact.jobTitle { dict["jobTitle"] = jobTitle }
        if let familyDetails = contact.familyDetails { dict["familyDetails"] = familyDetails }
        if let linkedInURL = contact.linkedInURL { dict["linkedInURL"] = linkedInURL }
        if let twitterHandle = contact.twitterHandle { dict["twitterHandle"] = twitterHandle }
        if let lastInteractionDate = contact.lastInteractionDate {
            dict["lastInteractionDate"] = ISO8601DateFormatter().string(from: lastInteractionDate)
        }
        if let birthday = contact.birthday {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            dict["birthday"] = formatter.string(from: birthday)
        }
        if !contact.customFields.isEmpty {
            dict["customFields"] = (try? String(
                data: JSONSerialization.data(withJSONObject: contact.customFields),
                encoding: .utf8
            )) ?? "{}"
        }

        return dict
    }

    // MARK: - Conflict Resolution (Last Writer Wins with timestamp)

    private func applyRemoteContact(_ json: JSONValue, to context: ModelContext) throws {
        guard case .string(let idString) = json["id"],
              let remoteId = UUID(uuidString: idString) else { return }

        let predicate = #Predicate<Contact> { $0.id == remoteId }
        let descriptor = FetchDescriptor<Contact>(predicate: predicate)
        let existing = try context.fetch(descriptor).first

        guard case .string(let remoteUpdatedStr) = json["updatedAt"],
              let remoteUpdated = ISO8601DateFormatter().date(from: remoteUpdatedStr) else { return }

        if let local = existing {
            // Last-writer-wins: skip if local is newer
            if local.updatedAt > remoteUpdated && local.syncStatus != SyncStatus.synced.rawValue {
                local.syncStatus = SyncStatus.conflict.rawValue
                logger.info("Conflict detected for contact \(idString) — local is newer")
                return
            }

            applyJsonToContact(json, contact: local)
            local.syncStatus = SyncStatus.synced.rawValue
            local.lastSyncedAt = Date()
        } else {
            let contact = Contact(
                firstName: jsonString(json["firstName"]) ?? "",
                lastName: jsonString(json["lastName"]) ?? ""
            )
            contact.id = remoteId
            applyJsonToContact(json, contact: contact)
            contact.syncStatus = SyncStatus.synced.rawValue
            contact.lastSyncedAt = Date()
            context.insert(contact)
        }
    }

    private func applyJsonToContact(_ json: JSONValue, contact: Contact) {
        if let v = jsonString(json["firstName"]) { contact.firstName = v }
        if let v = jsonString(json["lastName"]) { contact.lastName = v }
        contact.company = jsonString(json["company"])
        contact.jobTitle = jsonString(json["jobTitle"])
        contact.familyDetails = jsonString(json["familyDetails"])
        contact.linkedInURL = jsonString(json["linkedInURL"])
        contact.twitterHandle = jsonString(json["twitterHandle"])
        if let v = jsonDouble(json["relationshipScore"]) { contact.relationshipScore = v }
        if let v = jsonBool(json["isPriority"]) { contact.isPriority = v }
        if let v = jsonBool(json["isHidden"]) { contact.isHidden = v }
        if let v = jsonBool(json["isMergedAway"]) { contact.isMergedAway = v }
        if let v = jsonString(json["scoreTrendRaw"]) { contact.scoreTrendRaw = v }
        if let v = jsonStringArray(json["emails"]) { contact.emails = v }
        if let v = jsonStringArray(json["phones"]) { contact.phones = v }
        if let v = jsonStringArray(json["addresses"]) { contact.addresses = v }
        if let v = jsonStringArray(json["interests"]) { contact.interests = v }

        if let v = jsonString(json["updatedAt"]),
           let date = ISO8601DateFormatter().date(from: v) {
            contact.updatedAt = date
        }
        if let v = jsonString(json["createdAt"]),
           let date = ISO8601DateFormatter().date(from: v) {
            contact.createdAt = date
        }
        if let v = jsonString(json["lastInteractionDate"]),
           let date = ISO8601DateFormatter().date(from: v) {
            contact.lastInteractionDate = date
        }
    }

    // MARK: - JSON Helpers

    private func jsonString(_ value: JSONValue?) -> String? {
        guard let value, case .string(let s) = value else { return nil }
        return s
    }

    private func jsonDouble(_ value: JSONValue?) -> Double? {
        guard let value, case .number(let n) = value else { return nil }
        return n
    }

    private func jsonBool(_ value: JSONValue?) -> Bool? {
        guard let value, case .boolean(let b) = value else { return nil }
        return b
    }

    private func jsonStringArray(_ value: JSONValue?) -> [String]? {
        guard let value, case .array(let arr) = value else { return nil }
        return arr.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
    }
}

// MARK: - JSONValue subscript helper
private extension JSONValue {
    subscript(_ key: String) -> JSONValue? {
        guard case .object(let dict) = self else { return nil }
        return dict[key]
    }
}
