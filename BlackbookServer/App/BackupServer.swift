import Foundation
import Network
import CryptoKit
import SwiftData
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.server", category: "BackupServer")

/// Minimal HTTP request parsed from raw TCP data.
private struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]
    let body: Data?
}

/// Lightweight HTTP server that handles backup storage and retrieval.
/// Uses Network.framework (NWListener) for TCP, publishes via Bonjour.
final class BackupServer: @unchecked Sendable {
    private let password: String
    private let container: ModelContainer?
    /// iMessage reader, used by the localhost console's safe actions (backfill/toggle) and stats.
    private let imessage: IMessageSyncService?
    private let queue = DispatchQueue(label: "com.blackbookdevelopment.backupserver")
    private var listener: NWListener?
    /// Loopback-only listener serving the web console on `defaultConsolePort`. Never exposed via
    /// the Cloudflare tunnel (which forwards only the sync port), so it needs no password.
    private var consoleListener: NWListener?
    private var bonjourService: NetService?
    private(set) var isRunning = false
    private(set) var port: UInt16 = 0
    private var configuredPort: UInt16 = 8765
    private var isStopping = false
    private var restartDelay: TimeInterval = 1.0
    private let maxRestartDelay: TimeInterval = 30.0

    static let defaultPort: UInt16 = 8765
    static let defaultConsolePort: UInt16 = 8766
    static let bonjourType = "_blackbook-sync._tcp"
    static let passwordHeader = "X-Sync-Password"
    static let userEmailHeader = "X-User-Email"

    /// Derive a deterministic sync password from a user email using SHA256.
    static func derivePassword(from email: String) -> String {
        let hash = SHA256.hash(data: Data(email.utf8))
        return Data(hash).prefix(24).base64EncodedString()
    }

    /// Stamped on every HTTP response (header `X-Server-Epoch`). Clients use a change here to
    /// detect that the master store has been reset and bootstrap a full re-push of their local data.
    /// Loaded once at init from the epoch file next to the master store; persists across restarts.
    private let serverEpoch: String

    init(password: String, container: ModelContainer? = nil, imessage: IMessageSyncService? = nil) {
        self.password = password
        self.container = container
        self.imessage = imessage
        self.serverEpoch = ServerModelContainer.currentEpoch()
    }

    func start(port: UInt16 = BackupServer.defaultPort) {
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
                    self?.startConsole()
                    logger.info("Backup server listening on port \(self?.port ?? 0)")
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
            logger.error("Failed to start backup server: \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    func stop() {
        isStopping = true
        listener?.cancel()
        listener = nil
        consoleListener?.cancel()
        consoleListener = nil
        bonjourService?.stop()
        bonjourService = nil
        isRunning = false
        port = 0
    }

    // MARK: - Web Console (loopback only)

    /// Starts the localhost-only console listener on `defaultConsolePort`. Bound to 127.0.0.1 via
    /// `requiredLocalEndpoint` so it's unreachable from the LAN or the Cloudflare tunnel (which maps
    /// only the sync port). Idempotent — a no-op if already listening.
    private func startConsole() {
        guard consoleListener == nil else { return }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host("127.0.0.1"),
            port: NWEndpoint.Port(rawValue: Self.defaultConsolePort)!
        )
        do {
            let cl = try NWListener(using: params)
            self.consoleListener = cl
            cl.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    logger.info("Console listening on 127.0.0.1:\(Self.defaultConsolePort)")
                case .failed(let error):
                    logger.error("Console listener failed: \(error.localizedDescription)")
                default:
                    break
                }
            }
            cl.newConnectionHandler = { [weak self] conn in
                self?.handleConsole(connection: conn)
            }
            cl.start(queue: queue)
        } catch {
            logger.error("Failed to start console listener: \(error.localizedDescription)")
        }
    }

    // MARK: - Console Request Handling

    private func handleConsole(connection: NWConnection) {
        // Defense-in-depth on top of the loopback-only bind: only serve loopback peers.
        guard Self.isLoopback(connection.endpoint) else {
            connection.cancel()
            return
        }
        connection.start(queue: queue)
        receiveRequest(connection: connection, accumulated: Data()) { [weak self] request in
            guard let self else { return }
            let response = self.handleConsoleRoute(request)
            self.sendResponse(response, on: connection) {
                connection.cancel()
            }
        }
    }

    private static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let addr): return addr.isLoopback
        case .ipv6(let addr): return addr.isLoopback
        case .name(let name, _): return name == "localhost" || name == "127.0.0.1" || name == "::1"
        @unknown default: return false
        }
    }

    private func handleConsoleRoute(_ request: HTTPRequest?) -> (status: Int, headers: [String: String], body: Data?) {
        guard let request else { return (400, [:], "Bad Request".data(using: .utf8)) }
        switch (request.method, request.path) {
        case ("GET", "/"), ("GET", "/console"):
            return consoleHTMLResponse()
        case ("GET", "/api/stats"):
            return consoleJSON(buildConsoleStats())
        case ("POST", "/api/imessage/backfill"):
            let days = consoleBodyInt(request.body, key: "days") ?? 30
            if let imessage { Task { @MainActor in await imessage.backfill(daysBack: days) } }
            return consoleJSON(["ok": true, "days": days], status: 202)
        case ("POST", "/api/imessage/toggle"):
            let enabled = consoleBodyBool(request.body, key: "enabled") ?? false
            if let imessage { Task { @MainActor in imessage.isEnabled = enabled } }
            return consoleJSON(["ok": true, "enabled": enabled])
        default:
            return (404, [:], "Not Found".data(using: .utf8))
        }
    }

    private func consoleHTMLResponse() -> (status: Int, headers: [String: String], body: Data?) {
        guard let url = Bundle.main.url(forResource: "console", withExtension: "html"),
              let data = try? Data(contentsOf: url) else {
            return (500, [:], "console.html missing from bundle".data(using: .utf8))
        }
        return (200, ["Content-Type": "text/html; charset=utf-8"], data)
    }

    private func consoleJSON(_ object: Any, status: Int = 200) -> (status: Int, headers: [String: String], body: Data?) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return (500, [:], nil) }
        return (status, ["Content-Type": "application/json"], data)
    }

    private func consoleBodyInt(_ body: Data?, key: String) -> Int? {
        guard let body, let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return obj[key] as? Int
    }

    private func consoleBodyBool(_ body: Data?, key: String) -> Bool? {
        guard let body, let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return obj[key] as? Bool
    }

    // MARK: - Console Stats

    private func buildConsoleStats() -> [String: Any] {
        [
            "generatedAt": ISO8601DateFormatter().string(from: Date()),
            "server": [
                "running": isRunning,
                "port": Int(port),
                "consolePort": Int(Self.defaultConsolePort),
                "epoch": serverEpoch
            ],
            "syncHealth": consoleSyncHealth(),
            "backups": consoleBackups(),
            "requests": consoleRequests(),
            "data": consoleData()
        ]
    }

    private func consoleSyncHealth() -> [[String: Any]] {
        let fm = FileManager.default
        let days = consoleRecentDayStems(2) // oldest first → today's lines overwrite
        var latestByDevice: [String: [String: Any]] = [:]
        guard let userDirs = try? fm.contentsOfDirectory(at: remoteBackupsDirectory, includingPropertiesForKeys: nil) else { return [] }
        for userDir in userDirs where userDir.hasDirectoryPath {
            let logsDir = userDir.appendingPathComponent("Logs", isDirectory: true)
            for day in days {
                let url = logsDir.appendingPathComponent("heartbeats-\(day).jsonl")
                for line in consoleReadLines(url) {
                    guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                    let device = (obj["device"] as? String) ?? (obj["platform"] as? String) ?? "unknown"
                    let key = "\((obj["email"] as? String) ?? "")|\(device)"
                    latestByDevice[key] = obj
                }
            }
        }
        return latestByDevice.values.map { obj in
            [
                "email": obj["email"] as? String ?? "",
                "device": obj["device"] as? String ?? "",
                "platform": obj["platform"] as? String ?? "",
                "appVersion": obj["appVersion"] as? String ?? "",
                "status": obj["status"] as? String ?? "",
                "pushPending": obj["pushPending"] as? Int ?? 0,
                "lastSyncDate": obj["lastSyncDate"] as? String ?? "",
                "sentAt": obj["sentAt"] as? String ?? "",
                "receivedAt": obj["receivedAt"] as? String ?? "",
                "durationMs": obj["durationMs"] as? Int ?? 0,
                "error": obj["error"] as? String ?? ""
            ]
        }.sorted { ($0["receivedAt"] as? String ?? "") > ($1["receivedAt"] as? String ?? "") }
    }

    private func consoleBackups() -> [String: Any] {
        let fm = FileManager.default
        var perUser: [[String: Any]] = []
        var total = 0
        if let userDirs = try? fm.contentsOfDirectory(at: remoteBackupsDirectory, includingPropertiesForKeys: nil) {
            for userDir in userDirs where userDir.hasDirectoryPath {
                let backups = ((try? fm.contentsOfDirectory(at: userDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
                    .filter { $0.hasDirectoryPath && $0.lastPathComponent != "Logs" }
                let latest = backups.compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }.max()
                total += backups.count
                perUser.append([
                    "email": userDir.lastPathComponent,
                    "count": backups.count,
                    "latest": latest.map { ISO8601DateFormatter().string(from: $0) } ?? ""
                ])
            }
        }
        return ["totalCount": total, "totalBytes": diskUsageBytes, "perUser": perUser]
    }

    private func consoleRequests() -> [String: Any] {
        let day = Self.accessDateFormatter.string(from: Date())
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Blackbook/Logs/_access/access-\(day).jsonl")
        let lines = consoleReadLines(url)
        var byStatus: [String: Int] = [:]
        for line in lines {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            let status = obj["status"] as? Int ?? 0
            byStatus[status >= 500 ? "5xx" : "\(status)", default: 0] += 1
        }
        let recent = lines.suffix(50).compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        return ["total": lines.count, "byStatus": byStatus, "recent": Array(recent.reversed())]
    }

    private func consoleData() -> [String: Any] {
        var counts: [String: Int] = [:]
        if let container {
            let ctx = ModelContext(container)
            counts["Contact"] = (try? ctx.fetchCount(FetchDescriptor<Contact>())) ?? 0
            counts["Interaction"] = (try? ctx.fetchCount(FetchDescriptor<Interaction>())) ?? 0
            counts["Note"] = (try? ctx.fetchCount(FetchDescriptor<Note>())) ?? 0
            counts["Tag"] = (try? ctx.fetchCount(FetchDescriptor<Tag>())) ?? 0
            counts["Group"] = (try? ctx.fetchCount(FetchDescriptor<Group>())) ?? 0
            counts["Location"] = (try? ctx.fetchCount(FetchDescriptor<Location>())) ?? 0
            counts["ContactRelationship"] = (try? ctx.fetchCount(FetchDescriptor<ContactRelationship>())) ?? 0
            counts["Reminder"] = (try? ctx.fetchCount(FetchDescriptor<Reminder>())) ?? 0
            counts["Activity"] = (try? ctx.fetchCount(FetchDescriptor<Activity>())) ?? 0
            counts["RejectedCalendarEvent"] = (try? ctx.fetchCount(FetchDescriptor<RejectedCalendarEvent>())) ?? 0
        }
        var im: [String: Any] = ["available": imessage != nil]
        if let imessage {
            im["isRunning"] = imessage.isRunning
            im["isEnabled"] = imessage.isEnabled
            im["messagesProcessed"] = imessage.messagesProcessed
            im["isBackfilling"] = imessage.isBackfilling
            im["lastSyncDate"] = imessage.lastSyncDate.map { ISO8601DateFormatter().string(from: $0) } ?? ""
            im["unmatchedHandles"] = imessage.unmatchedHandlesLastPoll
            if let err = imessage.syncError { im["error"] = err }
        }
        return ["recordCounts": counts, "imessage": im]
    }

    /// Day stems (UTC `yyyy-MM-dd`) for the last `n` days, oldest first.
    private func consoleRecentDayStems(_ n: Int) -> [String] {
        (0..<n).reversed().map { offset in
            Self.accessDateFormatter.string(from: Date().addingTimeInterval(-Double(offset) * 86_400))
        }
    }

    /// Reads a file as UTF-8 and returns its non-empty lines; empty array if the file is missing.
    private func consoleReadLines(_ url: URL) -> [String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    // MARK: - Restart

    private func scheduleRestart() {
        guard !isStopping else { return }
        listener?.cancel()
        listener = nil
        consoleListener?.cancel()
        consoleListener = nil
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

    // MARK: - Bonjour

    private func publishBonjour(port: Int) {
        let service = NetService(domain: "local.", type: Self.bonjourType, name: "Blackbook", port: Int32(port))
        bonjourService = service
        service.publish()
    }

    // MARK: - Connection Handling

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
            self.receiveBody(connection: connection, accumulated: rest, remaining: contentLength - rest.count) { body in
                completion(HTTPRequest(method: req.method, path: req.path, query: req.query, headers: req.headers, body: body))
            }
        }
    }

    private func receiveBody(connection: NWConnection, accumulated: Data, remaining: Int, completion: @escaping (Data?) -> Void) {
        if remaining <= 0 {
            completion(accumulated.isEmpty ? nil : accumulated)
            return
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: min(remaining, 1048576)) { [weak self] data, _, _, error in
            var acc = accumulated
            let received = data?.count ?? 0
            if let data = data { acc.append(data) }
            let newRemaining = remaining - received
            if error != nil || newRemaining <= 0 {
                completion(acc.isEmpty ? nil : acc)
            } else {
                self?.receiveBody(connection: connection, accumulated: acc, remaining: newRemaining, completion: completion)
            }
        }
    }

    // MARK: - HTTP Parsing

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

    // MARK: - Request Routing

    private func handle(request: HTTPRequest?) -> (status: Int, headers: [String: String], body: Data?) {
        guard let request else {
            return (400, [:], "Bad Request".data(using: .utf8))
        }
        let result = handleAuthed(request: request)
        Self.logAccess(method: request.method,
                       path: request.path,
                       email: request.headers["x-user-email"] ?? "",
                       status: result.status)
        return result
    }

    private func handleAuthed(request: HTTPRequest) -> (status: Int, headers: [String: String], body: Data?) {
        let auth = request.headers["x-sync-password"] ?? request.headers["X-Sync-Password"]
        guard auth == password else {
            return (401, [:], "Unauthorized".data(using: .utf8))
        }

        guard let email = request.headers["x-user-email"], !email.isEmpty else {
            return (400, [:], "Missing X-User-Email header".data(using: .utf8))
        }

        if request.path.hasPrefix("/logs") {
            return handleLogsRoute(request: request, userEmail: email)
        }

        if request.method == "POST" && request.path == "/heartbeat" {
            return handleHeartbeat(body: request.body, userEmail: email)
        }

        // Sync routes — master store push/pull. Dispatched before /backups so the
        // 404 fallback below doesn't shadow them.
        if request.method == "GET" && request.path.hasPrefix(LocalSyncProtocol.Path.syncChanges) {
            return handleSyncPull(query: request.query)
        }
        if request.method == "POST" && request.path == LocalSyncProtocol.Path.syncChanges {
            return handleSyncPush(body: request.body)
        }

        guard request.path.hasPrefix("/backups") else {
            return (404, [:], "Not Found".data(using: .utf8))
        }

        return handleBackupRoute(request: request, userEmail: email)
    }

    // MARK: - Access Log

    private static let accessDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// Per-request access log so we can see EVERY incoming request and the status returned.
    /// Writes one JSONL line per request to
    /// `<Application Support>/Blackbook/Logs/_access/access-YYYY-MM-DD.jsonl`.
    private static func logAccess(method: String, path: String, email: String, status: Int) {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Blackbook/Logs/_access", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let day = accessDateFormatter.string(from: Date())
        let url = dir.appendingPathComponent("access-\(day).jsonl")
        let entry: [String: Any] = [
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "method": method,
            "path": path,
            "email": email,
            "status": status
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: entry) else { return }
        do {
            let handle: FileHandle
            if FileManager.default.fileExists(atPath: url.path) {
                handle = try FileHandle(forWritingTo: url)
                try handle.seekToEnd()
            } else {
                FileManager.default.createFile(atPath: url.path, contents: nil)
                handle = try FileHandle(forWritingTo: url)
            }
            defer { try? handle.close() }
            try handle.write(contentsOf: data)
            try handle.write(contentsOf: Data([0x0A]))
        } catch {
            logger.warning("Access log write failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Heartbeat

    /// POST /heartbeat — body is an arbitrary JSON object describing a client check-in.
    /// We add a server-side `receivedAt` timestamp and append the line to
    /// `<Application Support>/Blackbook/Logs/<sanitized_email>/heartbeats-YYYY-MM-DD.jsonl`.
    private func handleHeartbeat(body: Data?, userEmail: String) -> (status: Int, headers: [String: String], body: Data?) {
        guard let body,
              var json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return (400, [:], "Invalid JSON body".data(using: .utf8))
        }
        json["receivedAt"] = ISO8601DateFormatter().string(from: Date())
        json["email"] = userEmail
        guard let line = try? JSONSerialization.data(withJSONObject: json) else {
            return (500, [:], nil)
        }
        let day = Self.accessDateFormatter.string(from: Date())
        let dir = userLogsDir(userEmail)
        let fileURL = dir.appendingPathComponent("heartbeats-\(day).jsonl")
        do {
            let handle: FileHandle
            if FileManager.default.fileExists(atPath: fileURL.path) {
                handle = try FileHandle(forWritingTo: fileURL)
                try handle.seekToEnd()
            } else {
                FileManager.default.createFile(atPath: fileURL.path, contents: nil)
                handle = try FileHandle(forWritingTo: fileURL)
            }
            defer { try? handle.close() }
            try handle.write(contentsOf: line)
            try handle.write(contentsOf: Data([0x0A]))
            logger.info("Heartbeat recorded for \(userEmail, privacy: .public)")
            return (200, ["Content-Type": "application/json"], "{\"ok\":true}".data(using: .utf8))
        } catch {
            logger.error("Heartbeat write failed: \(error.localizedDescription)")
            return (500, [:], "Write failed".data(using: .utf8))
        }
    }

    // MARK: - Sync (master store push/pull)

    /// GET /sync/changes?since=ISO8601 → JSON dump of all records updated after `since`.
    /// Layered in dependency order so clients can apply leaves first, then references.
    private func handleSyncPull(query: [String: String]) -> (status: Int, headers: [String: String], body: Data?) {
        guard let container else {
            return (503, [:], "Master store unavailable".data(using: .utf8))
        }
        guard let sinceStr = query["since"],
              let since = ISO8601DateFormatter().date(from: sinceStr) else {
            return (400, [:], "Missing or invalid since".data(using: .utf8))
        }
        var json: [String: Any] = [:]
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            let context = ModelContext(container)
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
                logger.error("Sync pull fetch failed: \(error.localizedDescription)")
            }
            sem.signal()
        }
        sem.wait()
        guard let data = try? JSONSerialization.data(withJSONObject: json) else {
            return (500, [:], nil)
        }
        return (200, ["Content-Type": "application/json"], data)
    }

    /// POST /sync/changes — accept JSON payload (any subset of model arrays + optional `deletes`)
    /// and apply to the master store in dependency order. Returns 200 with `{}` on success.
    private func handleSyncPush(body: Data?) -> (status: Int, headers: [String: String], body: Data?) {
        guard let container else {
            return (503, [:], "Master store unavailable".data(using: .utf8))
        }
        guard let body,
              let top = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return (400, [:], "Invalid JSON body".data(using: .utf8))
        }
        let sem = DispatchSemaphore(value: 0)
        var success = true
        DispatchQueue.main.async {
            let context = ModelContext(container)
            do {
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

                // Layer 1: Activities
                if let activities = top["activities"] as? [[String: Any]] {
                    for dict in activities { try ModelSyncApply.applyRemoteActivity(dict, to: context) }
                }

                // Layer 2: Contacts
                if let contacts = top["contacts"] as? [[String: Any]] {
                    for dict in contacts { try ContactSyncApply.applyRemoteContact(dict, to: context) }
                }

                // Layer 3: Child entities
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

                // Deletes (structured per model type)
                if let deletes = top["deletes"] as? [String: Any] {
                    try Self.applySyncDeletes(deletes, to: context)
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
                logger.error("Sync push apply failed: \(error.localizedDescription)")
                success = false
            }
            sem.signal()
        }
        sem.wait()
        return (success ? 200 : 500, ["Content-Type": "application/json"], "{}".data(using: .utf8))
    }

    /// Apply structured deletes from a sync payload. Each key maps to a list of UUID strings.
    private static func applySyncDeletes(_ deletes: [String: Any], to context: ModelContext) throws {
        if let ids = deletes["tags"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Tag.self, where: #Predicate<Tag> { $0.id == id })
            }
        }
        if let ids = deletes["groups"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Group.self, where: #Predicate<Group> { $0.id == id })
            }
        }
        if let ids = deletes["locations"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Location.self, where: #Predicate<Location> { $0.id == id })
            }
        }
        if let ids = deletes["activities"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Activity.self, where: #Predicate<Activity> { $0.id == id })
            }
        }
        if let ids = deletes["contacts"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Contact.self, where: #Predicate<Contact> { $0.id == id })
            }
        }
        if let ids = deletes["interactions"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Interaction.self, where: #Predicate<Interaction> { $0.id == id })
            }
        }
        if let ids = deletes["notes"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Note.self, where: #Predicate<Note> { $0.id == id })
            }
        }
        if let ids = deletes["reminders"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: Reminder.self, where: #Predicate<Reminder> { $0.id == id })
            }
        }
        if let ids = deletes["contactRelationships"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: ContactRelationship.self, where: #Predicate<ContactRelationship> { $0.id == id })
            }
        }
        if let ids = deletes["rejectedCalendarEvents"] as? [String] {
            for idStr in ids {
                guard let id = UUID(uuidString: idStr) else { continue }
                try context.delete(model: RejectedCalendarEvent.self, where: #Predicate<RejectedCalendarEvent> { $0.id == id })
            }
        }
    }

    // MARK: - Logs Storage

    private func userLogsDir(_ email: String) -> URL {
        let dir = userBackupDir(email).appendingPathComponent("Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func isValidLogFilename(_ name: String) -> Bool {
        // Daily: actions-YYYY-MM-DD.jsonl  (28 chars total)
        // Rotated: actions-YYYY-MM-DD-HHmmss.jsonl  (35 chars total)
        guard name.hasPrefix("actions-"), name.hasSuffix(".jsonl") else { return false }
        guard !name.contains(".."), !name.contains("/") else { return false }
        let stem = String(name.dropFirst("actions-".count).dropLast(".jsonl".count))
        return stem.count == 10 || stem.count == 17
    }

    private func handleLogsRoute(request: HTTPRequest, userEmail: String) -> (status: Int, headers: [String: String], body: Data?) {
        let path = request.path
        let segments = path.split(separator: "/").map(String.init)
        let fm = FileManager.default

        // GET /logs — list all log files for user
        if request.method == "GET" && segments.count == 1 {
            let dir = userLogsDir(userEmail)
            guard let contents = try? fm.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) else {
                return (200, ["Content-Type": "application/json"], "[]".data(using: .utf8))
            }
            var entries: [[String: Any]] = []
            for url in contents where !url.hasDirectoryPath {
                let name = url.lastPathComponent
                guard name.hasSuffix(".jsonl") else { continue }
                let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                let size = values?.fileSize ?? 0
                let modified = values?.contentModificationDate ?? Date()
                let formatter = ISO8601DateFormatter()
                entries.append([
                    "name": name,
                    "size": size,
                    "modified": formatter.string(from: modified)
                ])
            }
            entries.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
            guard let json = try? JSONSerialization.data(withJSONObject: entries) else {
                return (500, [:], nil)
            }
            return (200, ["Content-Type": "application/json"], json)
        }

        // POST /logs/{filename} — overwrite log file
        if request.method == "POST" && segments.count == 2 {
            let filename = segments[1]
            guard isValidLogFilename(filename) else {
                return (400, [:], "Invalid log filename".data(using: .utf8))
            }
            guard let body = request.body else {
                return (400, [:], "Missing body".data(using: .utf8))
            }
            let fileURL = userLogsDir(userEmail).appendingPathComponent(filename)
            do {
                try body.write(to: fileURL)
                logger.info("Saved log file \(filename) for \(userEmail) (\(body.count) bytes)")
                return (200, [:], nil)
            } catch {
                return (500, [:], "Write failed".data(using: .utf8))
            }
        }

        // GET /logs/{filename} — download log file
        if request.method == "GET" && segments.count == 2 {
            let filename = segments[1]
            guard isValidLogFilename(filename) else {
                return (400, [:], "Invalid log filename".data(using: .utf8))
            }
            let fileURL = userLogsDir(userEmail).appendingPathComponent(filename)
            guard let data = try? Data(contentsOf: fileURL) else {
                return (404, [:], "File not found".data(using: .utf8))
            }
            return (200, ["Content-Type": "application/x-ndjson"], data)
        }

        return (404, [:], "Not Found".data(using: .utf8))
    }

    // MARK: - Backup Storage

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
        let segments = path.split(separator: "/").map(String.init)
        guard segments.count >= 2 else {
            return (404, [:], "Not Found".data(using: .utf8))
        }
        let backupId = segments[1]

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
        // Always include Content-Length so proxies (Cloudflare HTTP/2) and
        // URLSession can determine when the response ends.
        headerLines += "Content-Length: \(response.body?.count ?? 0)\r\n"
        // Stamp every response with the server epoch so clients can detect a master-store reset
        // and automatically bootstrap a full re-push of their local records.
        headerLines += "X-Server-Epoch: \(serverEpoch)\r\n"
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

    // MARK: - Stats

    var backupCount: Int {
        let fm = FileManager.default
        let dir = remoteBackupsDirectory
        guard let contents = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return 0 }
        var count = 0
        for userDir in contents where userDir.hasDirectoryPath {
            if let backups = try? fm.contentsOfDirectory(at: userDir, includingPropertiesForKeys: nil) {
                count += backups.filter { $0.hasDirectoryPath }.count
            }
        }
        return count
    }

    var diskUsageBytes: Int64 {
        let fm = FileManager.default
        let dir = remoteBackupsDirectory
        guard let enumerator = fm.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                total += Int64(size)
            }
        }
        return total
    }
}
