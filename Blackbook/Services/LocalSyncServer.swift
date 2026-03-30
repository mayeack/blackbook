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
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        do {
            let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            self.listener = listener
            listener.stateUpdateHandler = { [weak self] state in
                if case .ready = state {
                    self?.port = listener.port?.rawValue ?? 0
                    self?.isRunning = true
                    self?.publishBonjour(port: self?.port ?? 0)
                    logger.info("Local sync server listening on port \(self?.port ?? 0)")
                } else if case .failed(let error) = state {
                    logger.error("Listener failed: \(error.localizedDescription)")
                }
            }
            listener.newConnectionHandler = { [weak self] conn in
                self?.handle(connection: conn)
            }
            listener.start(queue: queue)
        } catch {
            logger.error("Failed to start sync server: \(error.localizedDescription)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        bonjourService?.stop()
        bonjourService = nil
        isRunning = false
        port = 0
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
            self.receiveRequest(connection: connection, accumulated: acc, completion: completion)
        }
    }

    private func receiveBody(connection: NWConnection, accumulated: Data, need: Int, completion: @escaping (Data?) -> Void) {
        if need <= 0 {
            completion(accumulated.isEmpty ? nil : accumulated)
            return
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: need) { [weak self] data, _, _, error in
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
        return (404, [:], "Not Found".data(using: .utf8))
    }

    private func handlePull(query: [String: String]) -> (status: Int, headers: [String: String], body: Data?) {
        guard let sinceStr = query["since"],
              let since = ISO8601DateFormatter().date(from: sinceStr) else {
            return (400, [:], "Missing or invalid since".data(using: .utf8))
        }
        var contactsPayload: [[String: Any]] = []
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            guard let self else { sem.signal(); return }
            let context = ModelContext(self.container)
            let predicate = #Predicate<Contact> { $0.updatedAt > since }
            var descriptor = FetchDescriptor<Contact>(predicate: predicate)
            descriptor.fetchLimit = 2000
            do {
                let list = try context.fetch(descriptor)
                contactsPayload = list.map { ContactSyncApply.contactToDict($0) }
            } catch {
                logger.error("Pull fetch failed: \(error.localizedDescription)")
            }
            sem.signal()
        }
        sem.wait()
        let json: [String: Any] = ["contacts": contactsPayload]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else {
            return (500, [:], nil)
        }
        return (200, ["Content-Type": "application/json"], data)
    }

    private func handlePush(body: Data?) -> (status: Int, headers: [String: String], body: Data?) {
        guard let body,
              let top = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let contacts = top["contacts"] as? [[String: Any]] else {
            return (400, [:], "Invalid JSON body".data(using: .utf8))
        }
        let sem = DispatchSemaphore(value: 0)
        var success = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { sem.signal(); return }
            let context = ModelContext(self.container)
            do {
                for dict in contacts {
                    try ContactSyncApply.applyRemoteContact(dict, to: context)
                }
                if let deletes = top["deletes"] as? [String] {
                    for idStr in deletes {
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
