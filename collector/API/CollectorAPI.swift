import Foundation
import os

private let log = Logger(subsystem: "com.blackbookdevelopment.server", category: "CollectorAPI")

/// Routes and guards for the collector's loopback API v1 (architecture.md §1a).
///
/// Every request must: carry no `Origin` header (browsers always send one on cross-site
/// requests, so this blocks DNS-rebinding/CSRF from web pages), name the collector itself in
/// `Host`, and present the bearer token. CORS is never answered.
final class CollectorAPI {
    static let apiVersion = "v1"

    struct Dependencies {
        var token: () -> CollectorToken?
        var reader: MessageReader
        var contacts: ContactsSource
        var whatsapp: WhatsAppSnapshotter
        var send: SendService
        var health: HealthReporter
        var now: () -> Date
    }

    let port: UInt16
    private let deps: Dependencies
    private let allowedHosts: Set<String>

    init(port: UInt16, dependencies: Dependencies) {
        self.port = port
        self.deps = dependencies
        self.allowedHosts = ["127.0.0.1:\(port)", "localhost:\(port)"]
    }

    func handle(_ request: LoopbackRequest) -> LoopbackResponse {
        let started = Date()
        let reply = evaluate(request)
        log.info("\(request.method, privacy: .public) \(request.path, privacy: .public) \(reply.status, privacy: .public) \(Int(Date().timeIntervalSince(started) * 1000), privacy: .public)ms")
        return .json(reply.status, reply.body, headers: reply.headers)
    }

    struct Reply {
        let status: Int
        let body: JSON
        var headers: [(String, String)] = []
    }

    /// Guards + routing, returning the JSON reply before serialization.
    func evaluate(_ request: LoopbackRequest) -> Reply {
        if request.header("origin") != nil { return Self.reply(.forbiddenOrigin) }
        guard let host = request.header("host")?.lowercased(), allowedHosts.contains(host) else {
            return Self.reply(.badHost)
        }
        guard let token = deps.token(), token.authorizes(request.header("authorization")) else {
            return Self.reply(.unauthorized)
        }
        do {
            return Reply(status: 200, body: try dispatch(request))
        } catch let error as MethodNotAllowed {
            var r = Self.reply(.methodNotAllowed)
            r.headers.append(("Allow", error.allow))
            return r
        } catch let error as APIError {
            return Self.reply(error)
        } catch let error as ChatDBError {
            return Self.reply(.from(error))
        } catch {
            log.error("route failed: \(String(describing: type(of: error)), privacy: .public)")
            return Self.reply(.internalError("internal error"))
        }
    }

    private static func reply(_ error: APIError) -> Reply {
        Reply(status: error.status, body: APIErrorBody.json(code: error.code, message: error.message),
              headers: error.status == 401 ? [("WWW-Authenticate", "Bearer")] : [])
    }

    private struct MethodNotAllowed: Error { let allow: String }

    private func dispatch(_ r: LoopbackRequest) throws -> JSON {
        func expect(_ method: String) throws {
            guard r.method == method else { throw MethodNotAllowed(allow: method) }
        }
        switch r.path {
        case "/v1/health":
            try expect("GET")
            return envelope(deps.health.fields(now: deps.now()))
        case "/v1/imessage/messages":
            try expect("GET")
            return try messages(r)
        case "/v1/imessage/messages/by-date":
            try expect("GET")
            return try messagesByDate(r)
        case "/v1/imessage/edited":
            try expect("GET")
            return try edited(r)
        case "/v1/imessage/chats":
            try expect("GET")
            return try chats(r)
        case "/v1/imessage/handles":
            try expect("GET")
            return try handles()
        case "/v1/imessage/send":
            try expect("POST")
            return try send(r)
        case "/v1/contacts":
            try expect("GET")
            return try contacts()
        case "/v1/whatsapp/snapshot":
            try expect("POST")
            return try whatsappSnapshot(r)
        default:
            throw APIError.notFound
        }
    }

    // MARK: Envelope

    private func envelope(_ fields: [(String, JSON)]) -> JSON {
        .object([("api", .string(Self.apiVersion)), ("generated_at", .iso(deps.now()))] + fields)
    }

    private func pageEnvelope<T>(_ page: RowPage<T>, _ encode: (T) -> JSON) -> JSON {
        envelope([
            ("items", .array(page.items.map(encode))),
            ("next_after_rowid", .int(page.nextAfterRowID)),
            ("has_more", .bool(page.hasMore)),
            ("max_rowid", .int(page.maxRowID)),
        ])
    }

    // MARK: iMessage

    private func messages(_ r: LoopbackRequest) throws -> JSON {
        let after = try Params.int(r, "after_rowid", required: true, min: 0)!
        let limit = try Params.int(r, "limit", default: 500, min: 1, max: MessageReader.maxPageSize)!
        let chat = r.query["chat_guid"].flatMap { $0.isEmpty ? nil : $0 }
        return pageEnvelope(try deps.reader.messages(afterRowID: Int64(after), limit: limit, chatGUID: chat), \.json)
    }

    private func messagesByDate(_ r: LoopbackRequest) throws -> JSON {
        let since = try Params.date(r, "since")
        let until = try Params.date(r, "until")
        guard since < until else { throw APIError.badRequest("`since` must be before `until`") }
        let after = try Params.int(r, "after_rowid", default: 0, min: 0)!
        let limit = try Params.int(r, "limit", default: 500, min: 1, max: MessageReader.maxPageSize)!
        return pageEnvelope(try deps.reader.messages(since: since, until: until, afterRowID: Int64(after), limit: limit), \.json)
    }

    private func edited(_ r: LoopbackRequest) throws -> JSON {
        let since = try Params.date(r, "since")
        let after = try Params.int(r, "after_rowid", default: 0, min: 0)!
        let limit = try Params.int(r, "limit", default: 500, min: 1, max: MessageReader.maxPageSize)!
        return pageEnvelope(try deps.reader.edited(since: since, afterRowID: Int64(after), limit: limit), \.json)
    }

    private func chats(_ r: LoopbackRequest) throws -> JSON {
        let after = try Params.int(r, "after_rowid", default: 0, min: 0)!
        let limit = try Params.int(r, "limit", default: 500, min: 1, max: MessageReader.maxChatPageSize)!
        return pageEnvelope(try deps.reader.chats(afterRowID: Int64(after), limit: limit), \.json)
    }

    private func handles() throws -> JSON {
        envelope([("items", .array(try deps.reader.handles().map(\.json)))])
    }

    private func send(_ r: LoopbackRequest) throws -> JSON {
        let body = try Params.jsonBody(r)
        let request = try SendRequest.parse(body)
        let result = try deps.send.send(request)
        guard case let .object(fields) = result.json else { throw APIError.internalError("encode") }
        return envelope(fields)
    }

    // MARK: Contacts and WhatsApp

    private func contacts() throws -> JSON {
        switch deps.contacts.authorization() {
        case .granted, .unknown:
            break
        case .notDetermined:
            deps.contacts.requestAccess()
            throw APIError.contactsDenied("Contacts access requested; approve the prompt and retry")
        case .denied, .restricted:
            throw APIError.contactsDenied("Contacts access is denied for the collector")
        }
        let cards: [ContactCard]
        do {
            cards = try deps.contacts.fetchAll()
        } catch {
            throw APIError.contactsDenied("Contacts fetch failed")
        }
        let payload = ContactsExport.payload(cards)
        return envelope([("hash", .string(payload.hash)), ("items", .array(payload.items))])
    }

    private func whatsappSnapshot(_ r: LoopbackRequest) throws -> JSON {
        let body = try Params.jsonBody(r)
        if body.has("force"), body.bool("force") == nil { throw APIError.badRequest("`force` must be a boolean") }
        let result = try deps.whatsapp.snapshot(force: body.bool("force") ?? false)
        guard case let .object(fields) = result.json else { throw APIError.internalError("encode") }
        return envelope(fields)
    }
}

/// Query-string and body validation.
enum Params {
    static func int(_ r: LoopbackRequest, _ name: String, required: Bool = false, default def: Int? = nil,
                    min: Int? = nil, max: Int? = nil) throws -> Int? {
        guard let raw = r.query[name], !raw.isEmpty else {
            if required { throw APIError.badRequest("`\(name)` is required") }
            return def
        }
        guard raw.count <= 19, raw.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == "-") }), let v = Int(raw) else {
            throw APIError.badRequest("`\(name)` must be an integer")
        }
        if let min, v < min { throw APIError.badRequest("`\(name)` must be >= \(min)") }
        if let max, v > max { throw APIError.badRequest("`\(name)` must be <= \(max)") }
        return v
    }

    static func date(_ r: LoopbackRequest, _ name: String) throws -> Date {
        guard let raw = r.query[name], !raw.isEmpty else { throw APIError.badRequest("`\(name)` is required") }
        guard let d = ISOTime.parse(raw) else { throw APIError.badRequest("`\(name)` must be an ISO-8601 timestamp") }
        return d
    }

    static func jsonBody(_ r: LoopbackRequest) throws -> JSONBody {
        if !r.body.isEmpty {
            let type = (r.header("content-type") ?? "").lowercased()
            guard type.hasPrefix("application/json") else { throw APIError.badRequest("Content-Type must be application/json") }
        }
        guard let body = JSONBody.parse(r.body) else { throw APIError.badRequest("body must be a JSON object") }
        return body
    }
}
