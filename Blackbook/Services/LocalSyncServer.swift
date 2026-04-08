#if os(macOS)
import Foundation
import Network
import SwiftData
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "LocalSyncServer")

/// Minimal HTTP request for the sync server.
private struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]
    let body: Data?
}

/// Runs a minimal HTTP sync server on the Mac (contacts pull/push, photos). macOS only.
final class LocalSyncServer: @unchecked Sendable {
    private let password: String
    private let photoDirectory: URL
    private let container: ModelContainer
    private let queue = DispatchQueue(label: "com.blackbookdevelopment.localsync.server")
    private var listener: NWListener?
    private var bonjourService: NetService?
    private(set) var isRunning = false
    private(set) var port: UInt16 = 0
    private var configuredPort: UInt16 = LocalSyncProtocol.defaultPort
    private var isStopping = false
    private var restartDelay: TimeInterval = 1.0
    private let maxRestartDelay: TimeInterval = 30.0

    init(container: ModelContainer, password: String) {
        self.container = container
        self.password = password
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("Blackbook", isDirectory: true)
            .appendingPathComponent("Photos", isDirectory: true)
        self.photoDirectory = dir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    func start(port: UInt16 = LocalSyncProtocol.defaultPort) {
        guard !isRunning else { return }
        isStopping = false
        configuredPort = port
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        do {
            let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            self.listener = listener
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.port = listener.port?.rawValue ?? 0
                    self?.isRunning = true
                    self?.restartDelay = 1.0
                    self?.publishBonjour(port: Int(self?.port ?? 0))
                    logger.info("Local sync server listening on port \(self?.port ?? 0)")
                case .failed(let error):
                    logger.error("Listener failed: \(error.localizedDescription)")
                    self?.scheduleRestart()
                case .cancelled:
                    self?.isRunning = false
                    self?.port = 0
                case .waiting(let error):
                    logger.warning("Listener waiting: \(error.localizedDescription)")
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] conn in
                self?.handle(connection: conn)
            }
            listener.start(queue: queue)
        } catch {
            logger.error("Failed to start sync server: \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    func stop() {
        isStopping = true
        listener?.cancel()
        listener = nil
        bonjourService?.stop()
        bonjourService = nil
        isRunning = false
        port = 0
    }

    private func scheduleRestart() {
        guard !isStopping else { return }
        listener?.cancel()
        listener = nil
        bonjourService?.stop()
        bonjourService = nil
        isRunning = false
        port = 0
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, maxRestartDelay)
        logger.info("Scheduling server restart in \(delay)s")
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.isStopping else { return }
            self.start(port: self.configuredPort)
        }
    }

    private func publishBonjour(port: Int) {
        let service = NetService(domain: "local.", type: LocalSyncProtocol.bonjourType, name: "Blackbook", port: Int32(port))
        bonjourService = service
        service.publish()
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(connection: connection, accumulated: Data()) { [weak self] request in
            guard let self else { return }
            let response = self.handle(request: request)
            self.sendResponse(response, on: connection) {
                connection.cancel()
            }
        }
    }

    private func receiveRequest(connection: NWConnection, accumulated: Data, completion: @escaping (HTTPRequest?) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var acc = accumulated
            if let data = data, !data.isEmpty { acc.append(data) }
            if error != nil || isComplete {
                completion(self.parseRequest(acc))
                return
            }
            let separator = Data([0x0d, 0x0a, 0x0d, 0x0a])
            guard let range = acc.firstRange(of: separator) else {
                self.receiveRequest(connection: connection, accumulated: acc, completion: completion)
                return
            }
            let head = Data(acc[..<range.lowerBound])
            let rest = Data(acc[range.upperBound...])
            guard let req = self.parseRequestHead(head) else {
                completion(nil)
                return
            }
            let contentLength = (req.headers["content-length"] ?? req.headers["Content-Length"]).flatMap { Int($0) } ?? 0
            if contentLength == 0 {
                completion(HTTPRequest(method: req.method, path: req.path, query: req.query, headers: req.headers, body: nil))
                return
            }
            if rest.count >= contentLength {
                let body = Data(rest.prefix(contentLength))
                completion(HTTPRequest(method: req.method, path: req.path, query: req.query, headers: req.headers, body: body))
                return
            }
            self.receiveBody(connection: connection, accumulated: rest, need: contentLength - rest.count) { body in
                completion(HTTPRequest(method: req.method, path: req.path, query: req.query, headers: req.headers, body: body))
            }
        }
    }

    private func receiveBody(connection: NWConnection, accumulated: Data, need: Int, completion: @escaping (Data?) -> Void) {
        if need <= 0 {
            completion(accumulated.isEmpty ? nil : accumulated)
            return
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: min(need, 1048576)) { [weak self] data, _, _, error in
            var acc = accumulated
            if let data = data { acc.append(data) }
            if error != nil || acc.count >= need {
                completion(acc.isEmpty ? nil : acc)
            } else {
                self?.receiveBody(connection: connection, accumulated: acc, need: need - acc.count, completion: completion)
            }
        }
    }

    private func parseRequest(_ data: Data) -> HTTPRequest? {
        let sep = Data([0x0d, 0x0a, 0x0d, 0x0a])
        guard let idx = data.firstRange(of: sep) else { return nil }
        let head = data.prefix(upTo: idx.lowerBound)
        let rest = data.suffix(from: idx.upperBound)
        guard let req = parseRequestHead(Data(head)) else { return nil }
        let len = (req.headers["content-length"] ?? req.headers["Content-Length"]).flatMap { Int($0) } ?? 0
        let body = len > 0 && rest.count >= len ? rest.prefix(len) : nil
        return HTTPRequest(method: req.method, path: req.path, query: req.query, headers: req.headers, body: body.map { Data($0) })
    }

    private func parseRequestHead(_ data: Data) -> (method: String, path: String, query: [String: String], headers: [String: String])? {
        guard let str = String(data: data, encoding: .utf8) else { return nil }
        let lines = str.components(separatedBy: "\r\n")
        guard let first = lines.first else { return nil }
        let parts = first.split(separator: " ", maxSplits: 2)
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0])
        let pathQuery = String(parts[1])
        let pathComps = pathQuery.split(separator: "?", maxSplits: 1)
        let path = String(pathComps[0])
        var query: [String: String] = [:]
        if pathComps.count > 1 {
            for pair in pathComps[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                if kv.count == 2 {
                    query[String(kv[0]).removingPercentEncoding ?? String(kv[0])] = String(kv[1]).removingPercentEncoding ?? String(kv[1])
                }
            }
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() where line.contains(":") {
            let sep = line.firstIndex(of: ":")!
            let key = line[..<sep].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: sep)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        return (method, path, query, headers)
    }

    private func handle(request: HTTPRequest?) -> (status: Int, headers: [String: String], body: Data?) {
        guard let request else {
            return (400, [:], "Bad Request".data(using: .utf8))
        }
        let auth = request.headers["x-sync-password"] ?? request.headers["X-Sync-Password"]
        guard auth == password else {
            return (401, [:], "Unauthorized".data(using: .utf8))
        }

        if request.method == "GET" && request.path.hasPrefix("/sync/changes") {
            return handlePull(query: request.query)
        }
        if request.method == "POST" && request.path == "/sync/changes" {
            return handlePush(body: request.body)
        }
        if request.method == "GET" && request.path.hasPrefix("/photo/") {
            let id = String(request.path.dropFirst("/photo/".count))
            return handleGetPhoto(contactId: id)
        }
        if request.method == "POST" && request.path.hasPrefix("/photo/") {
            let id = String(request.path.dropFirst("/photo/".count))
            return handlePostPhoto(contactId: id, body: request.body)
        }
        if request.method == "DELETE" && request.path.hasPrefix("/photo/") {
            let id = String(request.path.dropFirst("/photo/".count))
            return handleDeletePhoto(contactId: id)
        }
        // Backup endpoints
        if request.path.hasPrefix("/backups") {
            guard let email = request.headers["x-user-email"], !email.isEmpty else {
                return (400, [:], "Missing X-User-Email header".data(using: .utf8))
            }
            return handleBackupRoute(request: request, userEmail: email)
        }
        return (404, [:], "Not Found".data(using: .utf8))
    }

    private func handlePull(query: [String: String]) -> (status: Int, headers: [String: String], body: Data?) {
        guard let sinceStr = query["since"],
              let since = ISO8601DateFormatter().date(from: sinceStr) else {
            return (400, [:], "Missing or invalid since".data(using: .utf8))
        }
        var json: [String: Any] = [:]
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            guard let self else { sem.signal(); return }
            let context = ModelContext(self.container)
            do {
                // Layer 0: Leaf entities (no foreign keys)
                let tagPred = #Predicate<Tag> { $0.updatedAt > since }
                var tagDesc = FetchDescriptor<Tag>(predicate: tagPred); tagDesc.fetchLimit = 2000
                json["tags"] = try context.fetch(tagDesc).map { ModelSyncApply.tagToDict($0) }

                let groupPred = #Predicate<Group> { $0.updatedAt > since }
                var groupDesc = FetchDescriptor<Group>(predicate: groupPred); groupDesc.fetchLimit = 2000
                json["groups"] = try context.fetch(groupDesc).map { ModelSyncApply.groupToDict($0) }

                let locationPred = #Predicate<Location> { $0.updatedAt > since }
                var locationDesc = FetchDescriptor<Location>(predicate: locationPred); locationDesc.fetchLimit = 2000
                json["locations"] = try context.fetch(locationDesc).map { ModelSyncApply.locationToDict($0) }

                let rejectedPred = #Predicate<RejectedCalendarEvent> { $0.updatedAt > since }
                var rejectedDesc = FetchDescriptor<RejectedCalendarEvent>(predicate: rejectedPred); rejectedDesc.fetchLimit = 2000
                json["rejectedCalendarEvents"] = try context.fetch(rejectedDesc).map { ModelSyncApply.rejectedEventToDict($0) }

                // Layer 1: Activities (references Groups)
                let activityPred = #Predicate<Activity> { $0.updatedAt > since }
                var activityDesc = FetchDescriptor<Activity>(predicate: activityPred); activityDesc.fetchLimit = 2000
                json["activities"] = try context.fetch(activityDesc).map { ModelSyncApply.activityToDict($0) }

                // Layer 2: Contacts (references Tags, Groups, Locations, Activities)
                let contactPred = #Predicate<Contact> { $0.updatedAt > since }
                var contactDesc = FetchDescriptor<Contact>(predicate: contactPred); contactDesc.fetchLimit = 2000
                json["contacts"] = try context.fetch(contactDesc).map { ContactSyncApply.contactToDict($0) }

                // Layer 3: Child entities (reference Contacts)
                let interactionPred = #Predicate<Interaction> { $0.updatedAt > since }
                var interactionDesc = FetchDescriptor<Interaction>(predicate: interactionPred); interactionDesc.fetchLimit = 5000
                json["interactions"] = try context.fetch(interactionDesc).map { ModelSyncApply.interactionToDict($0) }

                let notePred = #Predicate<Note> { $0.updatedAt > since }
                var noteDesc = FetchDescriptor<Note>(predicate: notePred); noteDesc.fetchLimit = 2000
                json["notes"] = try context.fetch(noteDesc).map { ModelSyncApply.noteToDict($0) }

                let reminderPred = #Predicate<Reminder> { $0.updatedAt > since }
                var reminderDesc = FetchDescriptor<Reminder>(predicate: reminderPred); reminderDesc.fetchLimit = 2000
                json["reminders"] = try context.fetch(reminderDesc).map { ModelSyncApply.reminderToDict($0) }

                let relPred = #Predicate<ContactRelationship> { $0.updatedAt > since }
                var relDesc = FetchDescriptor<ContactRelationship>(predicate: relPred); relDesc.fetchLimit = 2000
                json["contactRelationships"] = try context.fetch(relDesc).map { ModelSyncApply.contactRelationshipToDict($0) }
            } catch {
                logger.error("Pull fetch failed: \(error.localizedDescription)")
            }
            sem.signal()
        }
        sem.wait()
        guard let data = try? JSONSerialization.data(withJSONObject: json) else {
            return (500, [:], nil)
        }
        return (200, ["Content-Type": "application/json"], data)
    }

    private func handlePush(body: Data?) -> (status: Int, headers: [String: String], body: Data?) {
        guard let body,
              let top = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return (400, [:], "Invalid JSON body".data(using: .utf8))
        }
        let sem = DispatchSemaphore(value: 0)
        var success = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { sem.signal(); return }
            let context = ModelContext(self.container)
            do {
                // Apply in dependency order: leaf entities first

                // Layer 0: Tags, Groups, Locations, RejectedCalendarEvents
                if let tags = top["tags"] as? [[String: Any]] {
                    for dict in tags { try ModelSyncApply.applyRemoteTag(dict, to: context) }
                }
                if let groups = top["groups"] as? [[String: Any]] {
                    for dict in groups { try ModelSyncApply.applyRemoteGroup(dict, to: context) }
                }
                if let locations = top["locations"] as? [[String: Any]] {
                    for dict in locations { try ModelSyncApply.applyRemoteLocation(dict, to: context) }
                }
                if let events = top["rejectedCalendarEvents"] as? [[String: Any]] {
                    for dict in events { try ModelSyncApply.applyRemoteRejectedEvent(dict, to: context) }
                }

                // Layer 1: Activities (references Groups)
                if let activities = top["activities"] as? [[String: Any]] {
                    for dict in activities { try ModelSyncApply.applyRemoteActivity(dict, to: context) }
                }

                // Layer 2: Contacts (references Tags, Groups, Locations, Activities)
                if let contacts = top["contacts"] as? [[String: Any]] {
                    for dict in contacts { try ContactSyncApply.applyRemoteContact(dict, to: context) }
                }

                // Layer 3: Child entities (reference Contacts)
                if let interactions = top["interactions"] as? [[String: Any]] {
                    for dict in interactions { try ModelSyncApply.applyRemoteInteraction(dict, to: context) }
                }
                if let notes = top["notes"] as? [[String: Any]] {
                    for dict in notes { try ModelSyncApply.applyRemoteNote(dict, to: context) }
                }
                if let reminders = top["reminders"] as? [[String: Any]] {
                    for dict in reminders { try ModelSyncApply.applyRemoteReminder(dict, to: context) }
                }
                if let rels = top["contactRelationships"] as? [[String: Any]] {
                    for dict in rels { try ModelSyncApply.applyRemoteContactRelationship(dict, to: context) }
                }

                // Handle deletes (structured per model type)
                if let deletes = top["deletes"] as? [String: Any] {
                    try Self.applyDeletes(deletes, to: context)
                }
                // Legacy: flat deletes array for backward compatibility (contact-only)
                if let legacyDeletes = top["deletes"] as? [String] {
                    for idStr in legacyDeletes {
                        guard let id = UUID(uuidString: idStr) else { continue }
                        let predicate = #Predicate<Contact> { $0.id == id }
                        try context.delete(model: Contact.self, where: predicate)
                    }
                }

                try context.save()
            } catch {
                logger.error("Push apply failed: \(error.localizedDescription)")
                success = false
            }
            sem.signal()
        }
        sem.wait()
        return (success ? 200 : 500, ["Content-Type": "application/json"], "{}".data(using: .utf8))
    }

    private static func applyDeletes(_ deletes: [String: Any], to context: ModelContext) throws {
        if let ids = deletes["tags"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Tag> { $0.id == id }
                try context.delete(model: Tag.self, where: pred)
            }
        }
        if let ids = deletes["groups"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Group> { $0.id == id }
                try context.delete(model: Group.self, where: pred)
            }
        }
        if let ids = deletes["locations"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Location> { $0.id == id }
                try context.delete(model: Location.self, where: pred)
            }
        }
        if let ids = deletes["activities"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Activity> { $0.id == id }
                try context.delete(model: Activity.self, where: pred)
            }
        }
        if let ids = deletes["contacts"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Contact> { $0.id == id }
                try context.delete(model: Contact.self, where: pred)
            }
        }
        if let ids = deletes["interactions"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Interaction> { $0.id == id }
                try context.delete(model: Interaction.self, where: pred)
            }
        }
        if let ids = deletes["notes"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Note> { $0.id == id }
                try context.delete(model: Note.self, where: pred)
            }
        }
        if let ids = deletes["reminders"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<Reminder> { $0.id == id }
                try context.delete(model: Reminder.self, where: pred)
            }
        }
        if let ids = deletes["contactRelationships"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                let pred = #Predicate<ContactRelationship> { $0.id == id }
                try context.delete(model: ContactRelationship.self, where: pred)
            }
        }
    }

    private func handleGetPhoto(contactId: String) -> (status: Int, headers: [String: String], body: Data?) {
        let fileURL = photoDirectory.appendingPathComponent("\(contactId).jpg")
        guard FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            return (404, [:], nil)
        }
        return (200, ["Content-Type": "image/jpeg"], data)
    }

    private func handlePostPhoto(contactId: String, body: Data?) -> (status: Int, headers: [String: String], body: Data?) {
        guard let body, !body.isEmpty else { return (400, [:], nil) }
        let fileURL = photoDirectory.appendingPathComponent("\(contactId).jpg")
        do {
            try body.write(to: fileURL)
            return (200, [:], nil)
        } catch {
            logger.error("Photo write failed: \(error.localizedDescription)")
            return (500, [:], nil)
        }
    }

    private func handleDeletePhoto(contactId: String) -> (status: Int, headers: [String: String], body: Data?) {
        let fileURL = photoDirectory.appendingPathComponent("\(contactId).jpg")
        try? FileManager.default.removeItem(at: fileURL)
        return (200, [:], nil)
    }

    // MARK: - Backup Endpoints

    private var remoteBackupsDirectory: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Blackbook/RemoteBackups", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func sanitizeEmail(_ email: String) -> String {
        email.replacingOccurrences(of: "@", with: "_at_")
            .replacingOccurrences(of: ".", with: "_")
    }

    private func userBackupDir(_ email: String) -> URL {
        remoteBackupsDirectory.appendingPathComponent(sanitizeEmail(email), isDirectory: true)
    }

    private func handleBackupRoute(request: HTTPRequest, userEmail: String) -> (status: Int, headers: [String: String], body: Data?) {
        let path = request.path
        let fm = FileManager.default

        // GET /backups — list all backups for user
        if request.method == "GET" && path == "/backups" {
            let userDir = userBackupDir(userEmail)
            guard let contents = try? fm.contentsOfDirectory(at: userDir, includingPropertiesForKeys: nil) else {
                return (200, ["Content-Type": "application/json"], "[]".data(using: .utf8))
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            var backups: [BackupMetadata] = []
            for dir in contents where dir.hasDirectoryPath {
                let metaURL = dir.appendingPathComponent("metadata.json")
                guard let data = try? Data(contentsOf: metaURL),
                      let meta = try? decoder.decode(BackupMetadata.self, from: data),
                      meta.isComplete else { continue }
                backups.append(meta)
            }
            backups.sort { $0.createdAt > $1.createdAt }
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            guard let json = try? encoder.encode(backups) else {
                return (500, [:], nil)
            }
            return (200, ["Content-Type": "application/json"], json)
        }

        // Parse path segments: /backups/{id}/...
        let segments = path.split(separator: "/").map(String.init) // ["backups", id, ...]
        guard segments.count >= 2 else {
            return (404, [:], "Not Found".data(using: .utf8))
        }
        let backupId = segments[1]

        // Validate backup ID (prevent path traversal)
        guard !backupId.contains(".."), !backupId.contains("/") else {
            return (400, [:], "Invalid backup ID".data(using: .utf8))
        }

        let backupDir = userBackupDir(userEmail).appendingPathComponent(backupId, isDirectory: true)

        // DELETE /backups/{id}
        if request.method == "DELETE" && segments.count == 2 {
            try? fm.removeItem(at: backupDir)
            logger.info("Deleted remote backup \(backupId) for \(userEmail)")
            return (200, [:], nil)
        }

        // POST /backups/{id}/metadata
        if request.method == "POST" && segments.count == 3 && segments[2] == "metadata" {
            guard let body = request.body else { return (400, [:], "Missing body".data(using: .utf8)) }
            try? fm.createDirectory(at: backupDir, withIntermediateDirectories: true)
            do {
                try body.write(to: backupDir.appendingPathComponent("metadata.json"))
                logger.info("Saved metadata for backup \(backupId) from \(userEmail)")
                return (200, [:], nil)
            } catch {
                return (500, [:], "Write failed".data(using: .utf8))
            }
        }

        // POST /backups/{id}/file/{filename...}
        if request.method == "POST" && segments.count >= 4 && segments[2] == "file" {
            let filename = segments[3...].joined(separator: "/")
            guard !filename.contains(".."), !filename.hasPrefix("/") else {
                return (400, [:], "Invalid filename".data(using: .utf8))
            }
            guard let body = request.body else { return (400, [:], "Missing body".data(using: .utf8)) }
            let fileURL = backupDir.appendingPathComponent(filename)
            try? fm.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            do {
                try body.write(to: fileURL)
                logger.info("Saved backup file \(filename) for \(backupId)")
                return (200, [:], nil)
            } catch {
                return (500, [:], "Write failed".data(using: .utf8))
            }
        }

        // GET /backups/{id}/files — list files in backup
        if request.method == "GET" && segments.count == 3 && segments[2] == "files" {
            guard let enumerator = fm.enumerator(at: backupDir, includingPropertiesForKeys: [.fileSizeKey]) else {
                return (404, [:], "Backup not found".data(using: .utf8))
            }
            var files: [[String: Any]] = []
            while let url = enumerator.nextObject() as? URL {
                guard !url.hasDirectoryPath else { continue }
                let relativePath = url.path.replacingOccurrences(of: backupDir.path + "/", with: "")
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                files.append(["name": relativePath, "size": size])
            }
            guard let json = try? JSONSerialization.data(withJSONObject: ["files": files]) else {
                return (500, [:], nil)
            }
            return (200, ["Content-Type": "application/json"], json)
        }

        // GET /backups/{id}/file/{filename...} — download file
        if request.method == "GET" && segments.count >= 4 && segments[2] == "file" {
            let filename = segments[3...].joined(separator: "/")
            guard !filename.contains(".."), !filename.hasPrefix("/") else {
                return (400, [:], "Invalid filename".data(using: .utf8))
            }
            let fileURL = backupDir.appendingPathComponent(filename)
            guard let data = try? Data(contentsOf: fileURL) else {
                return (404, [:], "File not found".data(using: .utf8))
            }
            return (200, ["Content-Type": "application/octet-stream"], data)
        }

        return (404, [:], "Not Found".data(using: .utf8))
    }

    // MARK: - Response Helpers

    private func sendResponse(_ response: (status: Int, headers: [String: String], body: Data?), on connection: NWConnection, completion: @escaping () -> Void) {
        let statusLine = "HTTP/1.1 \(response.status) \(statusText(response.status))\r\n"
        var headerLines = ""
        for (k, v) in response.headers {
            headerLines += "\(k): \(v)\r\n"
        }
        if let body = response.body {
            headerLines += "Content-Length: \(body.count)\r\n"
        }
        headerLines += "\r\n"
        var data = (statusLine + headerLines).data(using: .utf8)!
        if let body = response.body { data.append(body) }
        connection.send(content: data, completion: .contentProcessed { _ in completion() })
    }

    private func statusText(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        default: return "Unknown"
        }
    }
}

#endif
