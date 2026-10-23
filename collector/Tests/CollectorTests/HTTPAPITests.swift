import Foundation
import Network
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

/// Wires a CollectorAPI over a synthetic world with fakes for everything that touches the system.
final class APIHarness {
    static let port: UInt16 = 4321
    let world: SyntheticWorld
    let dataDir: URL
    let token: CollectorToken
    let runner = FakeAppleScriptRunner()
    let contacts = FakeContacts()
    let api: CollectorAPI
    let whatsappSource: URL
    /// Stands in for ~/Library/Application Support/CallHistoryDB/CallHistory.storedata (absent until a test writes it).
    let callHistoryPath: String
    /// Stands in for ~/Library/Messages/Attachments.
    let attachmentsRoot: URL

    init(port: UInt16 = APIHarness.port, compiledHandles: [String] = ["+15555550100"]) throws {
        world = try SyntheticWorld()
        dataDir = TestPaths.tempDir("ybdata")
        whatsappSource = dataDir.appendingPathComponent("wa-source", isDirectory: true)
        callHistoryPath = dataDir.appendingPathComponent("CallHistory.storedata").path
        token = try CollectorToken.loadOrCreate(at: dataDir.appendingPathComponent("collector.token"))
        let reader = world.reader
        let clock = FakeClock()
        let whatsapp = WhatsAppSnapshotter(sourceDir: whatsappSource,
                                           destRoot: dataDir.appendingPathComponent("snapshots/whatsapp"), now: { refDate })
        let allowlist = RecipientAllowlist(compiledHandles: compiledHandles, ownAddresses: { try reader.ownAccountAddresses() })
        let send = SendService(allowlist: allowlist,
                               ledger: SendLedger(fileURL: nil), sender: MessagesSender(runner: runner), rows: reader, clock: clock)
        attachmentsRoot = dataDir.appendingPathComponent("attachments", isDirectory: true)
        let attachments = AttachmentService(reader: reader, allowlist: allowlist, root: attachmentsRoot)
        let health = HealthReporter(reader: reader, whatsapp: whatsapp, probe: FakeProbe(),
                                    startedAt: refDate.addingTimeInterval(-3600),
                                    info: ["CFBundleShortVersionString": "2.0.0", "CFBundleVersion": "2"], macOSVersion: "26.0.0")
        let tok = token
        api = CollectorAPI(port: port, dependencies: .init(token: { tok }, reader: reader, contacts: contacts,
                                                           whatsapp: whatsapp, calls: CallHistoryReader(path: callHistoryPath),
                                                           send: send, attachments: attachments, health: health, now: { refDate }))
    }

    deinit { try? FileManager.default.removeItem(at: dataDir) }

    func loopbackRequest(_ method: String, _ target: String, headers: [String: String] = [:], body: Data = Data(),
                         auth: Bool = true, host: String = "127.0.0.1:4321") -> LoopbackRequest {
        let (path, query) = HTTPRequestParser.splitTarget(target)
        var h = ["host": host]
        if auth { h["authorization"] = "Bearer \(token.value)" }
        if !body.isEmpty { h["content-type"] = "application/json" }
        for (k, v) in headers { h[k.lowercased()] = v }
        return LoopbackRequest(method: method, path: path, query: query, headers: h, body: body)
    }

    func request(_ method: String, _ target: String, headers: [String: String] = [:], body: Data = Data(),
                 auth: Bool = true, host: String = "127.0.0.1:4321") -> LoopbackResponse {
        api.handle(loopbackRequest(method, target, headers: headers, body: body, auth: auth, host: host))
    }

    func request(_ target: String, headers: [String: String] = [:], auth: Bool = true,
                 host: String = "127.0.0.1:4321") -> LoopbackResponse {
        request("GET", target, headers: headers, auth: auth, host: host)
    }

    func reply(_ target: String) -> CollectorAPI.Reply {
        api.evaluate(loopbackRequest("GET", target))
    }

    static func json(_ r: LoopbackResponse) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any] ?? [:]
    }

    static func errorCode(_ r: LoopbackResponse) -> String? {
        (json(r)["error"] as? [String: Any])?["code"] as? String
    }
}

@Suite("HTTP parsing")
struct HTTPParserTests {
    let limits = HTTPLimits()

    private func parse(_ s: String) -> HTTPParseResult { HTTPRequestParser.parse(Data(s.utf8), limits: limits) }

    @Test func completeGetWithQuery() {
        guard case let .complete(r) = parse("GET /v1/imessage/messages?after_rowid=10&limit=5&chat_guid=any%3B%2B%3Bchat1 HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nAuthorization: Bearer x\r\n\r\n") else {
            Issue.record("expected complete"); return
        }
        #expect(r.method == "GET")
        #expect(r.path == "/v1/imessage/messages")
        #expect(r.query == ["after_rowid": "10", "limit": "5", "chat_guid": "any;+;chat1"])
        #expect(r.header("HOST") == "127.0.0.1:4321")
    }

    @Test func incrementalBody() {
        let head = "POST /v1/imessage/send HTTP/1.1\r\nHost: 127.0.0.1:4321\r\nContent-Length: 10\r\n\r\n"
        if case .needMore = parse("POST /v1/imessage/send HTTP/1.1\r\nHost: 127") {} else { Issue.record("partial head") }
        if case .needMore = parse(head + "{\"a\":") {} else { Issue.record("partial body") }
        guard case let .complete(r) = parse(head + "{\"a\":true}") else { Issue.record("complete"); return }
        #expect(String(decoding: r.body, as: UTF8.self) == "{\"a\":true}")
    }

    @Test func limitsAndStrictness() {
        func status(_ s: String) -> Int? {
            if case let .failure(status, _, _) = parse(s) { return status }
            return nil
        }
        #expect(status("POST /v1/whatsapp/snapshot HTTP/1.1\r\nHost: 127.0.0.1:4321\r\n\r\n") == 411)
        #expect(status("POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: \(2 << 20)\r\n\r\n") == 413)
        #expect(status("POST /x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n") == 501)
        #expect(status("GET /x HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n") == 400)
        #expect(status("GET /x HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx") == 400)
        #expect(status("GET http://evil.example.com/x HTTP/1.1\r\nHost: a\r\n\r\n") == 400)
        #expect(status("GET /x HTTP/2.0\r\nHost: a\r\n\r\n") == 505)
        #expect(status("GET /x HTTP/1.1\r\nHost: a\r\n folded\r\n\r\n") == 400)
        #expect(status("POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: -1\r\n\r\n") == 400)
        let huge = "GET /x HTTP/1.1\r\nX-Pad: " + String(repeating: "a", count: 70_000)
        #expect(status(huge) == 431)
        #expect(status(huge + "\r\n\r\n") == 431)
    }

    @Test func statusTexts() {
        #expect(HTTPStatus.text(202) == "Accepted")
        #expect(HTTPStatus.text(503) == "Service Unavailable")
        #expect(HTTPStatus.text(411) == "Length Required")
        let wire = String(decoding: LoopbackResponse.json(202, .object([])).encoded(), as: UTF8.self)
        #expect(wire.hasPrefix("HTTP/1.1 202 Accepted\r\n"))
        #expect(wire.contains("Content-Length: 2\r\n"))
        #expect(wire.contains("Cache-Control: no-store\r\n"))
        #expect(!wire.lowercased().contains("access-control-allow"))
    }
}

@Suite("collector API guards and routes")
struct CollectorAPITests {
    @Test func originHostAndTokenGuards() throws {
        let h = try APIHarness()
        let origin = h.request("/v1/health", headers: ["Origin": "https://yeackbot.com"])
        #expect(origin.status == 403)
        #expect(APIHarness.errorCode(origin) == "forbidden_origin")

        for host in ["evil.example.com", "127.0.0.1", "127.0.0.1:4320", "localhost:80", "[::1]:4321"] {
            let r = h.request("/v1/health", host: host)
            #expect(r.status == 403, "host \(host)")
            #expect(APIHarness.errorCode(r) == "bad_host")
        }
        #expect(h.request("/v1/health", host: "LOCALHOST:4321").status == 200)

        let missing = h.request("/v1/health", auth: false)
        #expect(missing.status == 401)
        #expect(missing.headers.contains { $0 == ("WWW-Authenticate", "Bearer") })
        #expect(h.request("/v1/health", headers: ["Authorization": "Bearer \(h.token.value)x"], auth: false).status == 401)
        #expect(h.request("/v1/health", headers: ["Authorization": "Basic \(h.token.value)"], auth: false).status == 401)
        #expect(h.request("/v1/health", headers: ["Authorization": "bearer \(h.token.value)"], auth: false).status == 200)
    }

    @Test func tokenFileIsPrivateAndStable() throws {
        let dir = TestPaths.tempDir("token")
        defer { try? FileManager.default.removeItem(at: dir) }
        let data = dir.appendingPathComponent("Yeackbot", isDirectory: true)
        let url = data.appendingPathComponent("collector.token")
        let a = try CollectorToken.loadOrCreate(at: url)
        #expect(a.value.count == 43)
        #expect(SecureFiles.posixMode(url) == 0o600)
        #expect(SecureFiles.posixMode(data) == 0o700)
        #expect(try CollectorToken.loadOrCreate(at: url).value == a.value)
        #expect(CollectorToken.constantTimeEquals(Array("abc".utf8), Array("abc".utf8)))
        #expect(!CollectorToken.constantTimeEquals(Array("abc".utf8), Array("abd".utf8)))
        #expect(!CollectorToken.constantTimeEquals(Array("abc".utf8), Array("abcd".utf8)))
    }

    @Test func routingErrors() throws {
        let h = try APIHarness()
        #expect(h.request("/v1/nope").status == 404)
        let wrong = h.request("POST", "/v1/health", body: Data("{}".utf8))
        #expect(wrong.status == 405)
        #expect(wrong.headers.contains { $0 == ("Allow", "GET") })
        #expect(h.request("/v1/imessage/messages").status == 400, "after_rowid is required")
        #expect(h.request("/v1/imessage/messages?after_rowid=0&limit=1001").status == 400)
        #expect(h.request("/v1/imessage/messages?after_rowid=abc").status == 400)
        #expect(h.request("/v1/imessage/messages/by-date?since=2026-10-02T00:00:00Z&until=2026-10-01T00:00:00Z").status == 400)
        #expect(h.request("/v1/imessage/edited?since=yesterday").status == 400)
        #expect(h.request("/v1/imessage/chats?after_rowid=0&limit=501").status == 400)
    }

    @Test func messagesEnvelope() throws {
        let h = try APIHarness()
        let r = h.request("/v1/imessage/messages?after_rowid=0&limit=4")
        #expect(r.status == 200)
        let body = APIHarness.json(r)
        #expect(body["api"] as? String == "v1")
        #expect(body["generated_at"] as? String == "2026-10-01T12:00:00.000Z")
        #expect((body["items"] as? [Any])?.count == 4)
        #expect(body["next_after_rowid"] as? Int == 4)
        #expect(body["has_more"] as? Bool == true)
        #expect(body["max_rowid"] as? Int == (try h.world.reader.maxRowID()).asInt)

        let byDate = APIHarness.json(h.request("/v1/imessage/messages/by-date?since=2026-10-01T12:01:00.000Z&until=2026-10-01T12:04:00Z"))
        #expect((byDate["items"] as? [[String: Any]])?.compactMap { $0["guid"] as? String } == ["G-BODY", "G-GROUPSEND", "G-GROUPRECV"])
        let edited = APIHarness.json(h.request("/v1/imessage/edited?since=2026-10-01T12:10:00%2B00:00"))
        #expect((edited["items"] as? [Any])?.count == 3)
    }

    @Test func sendRouteRefusesNonSelfAndValidates() throws {
        let h = try APIHarness()
        let body = { (to: String) in
            Data("{\"to\":\"\(to)\",\"text\":\"🅨 hi\",\"client_ref\":\"\(UUID().uuidString)\",\"verify_timeout_ms\":0}".utf8)
        }
        let refused = h.request("POST", "/v1/imessage/send", body: body("+15555550101"))
        #expect(refused.status == 403)
        #expect(APIHarness.errorCode(refused) == "recipient_not_allowed")
        #expect(h.runner.calls.isEmpty)

        let bad = h.request("POST", "/v1/imessage/send", body: Data("[1]".utf8))
        #expect(bad.status == 400)
        let notJSON = h.request("POST", "/v1/imessage/send", headers: ["Content-Type": "text/plain"], body: body("+15555550100"))
        #expect(notJSON.status == 400)

        let ok = h.request("POST", "/v1/imessage/send", body: body("+15555550100"))
        #expect(ok.status == 200)
        #expect(APIHarness.json(ok)["status"] as? String == "unverified")
        #expect(h.runner.calls.count == 1)
    }

    @Test func sendRefusedWithFallbackHandles() throws {
        let h = try APIHarness(compiledHandles: GeneratedSelfHandles.handles)
        let r = h.request("POST", "/v1/imessage/send",
                          body: Data("{\"to\":\"+15555550100\",\"text\":\"🅨 hi\",\"client_ref\":\"\(UUID().uuidString)\"}".utf8))
        #expect(APIHarness.errorCode(r) == "recipient_not_allowed")
        #expect(h.runner.calls.isEmpty)
    }

    @Test func contactsPermissionStates() throws {
        let h = try APIHarness()
        h.contacts.auth = .notDetermined
        let pending = h.request("/v1/contacts")
        #expect(pending.status == 403)
        #expect(APIHarness.errorCode(pending) == "contacts_denied")
        #expect(h.contacts.requested == 1)
        h.contacts.auth = .denied
        #expect(APIHarness.errorCode(h.request("/v1/contacts")) == "contacts_denied")
        h.contacts.auth = .granted
        h.contacts.cards = ContactsTests.sampleCards
        let ok = APIHarness.json(h.request("/v1/contacts"))
        #expect((ok["hash"] as? String)?.count == 64)
        #expect((ok["items"] as? [Any])?.count == 2)
    }

    @Test func whatsappNotInstalled() throws {
        let h = try APIHarness()
        let r = h.request("POST", "/v1/whatsapp/snapshot", body: Data("{}".utf8))
        #expect(r.status == 404)
        #expect(APIHarness.errorCode(r) == "whatsapp_not_installed")
        #expect(h.request("POST", "/v1/whatsapp/snapshot", body: Data("{\"force\":\"yes\"}".utf8)).status == 400)
    }

    @Test func chatdbUnavailableIsReported() throws {
        let missing = MessageReader(db: ChatDB(path: "/nonexistent/\(UUID().uuidString)/chat.db"))
        let h = try APIHarness()
        let api = CollectorAPI(port: 4321, dependencies: .init(
            token: { h.token }, reader: missing, contacts: h.contacts,
            whatsapp: WhatsAppSnapshotter(sourceDir: h.whatsappSource, destRoot: h.dataDir),
            calls: CallHistoryReader(path: h.callHistoryPath),
            send: SendService(allowlist: RecipientAllowlist(compiledHandles: [], ownAddresses: { [] }),
                              ledger: SendLedger(fileURL: nil), sender: MessagesSender(runner: h.runner), rows: missing,
                              clock: FakeClock()),
            attachments: AttachmentService(reader: missing, allowlist: RecipientAllowlist(compiledHandles: [], ownAddresses: { [] }),
                                           root: h.attachmentsRoot),
            health: HealthReporter(reader: missing, whatsapp: WhatsAppSnapshotter(sourceDir: h.whatsappSource, destRoot: h.dataDir),
                                   probe: FakeProbe(), startedAt: refDate),
            now: { refDate }))
        let r = api.handle(LoopbackRequest(method: "GET", path: "/v1/imessage/handles", query: [:],
                                           headers: ["host": "127.0.0.1:4321", "authorization": "Bearer \(h.token.value)"], body: Data()))
        #expect(r.status == 503)
        #expect(APIHarness.errorCode(r) == "chatdb_unavailable")
    }
}

extension Int64 {
    var asInt: Int { Int(self) }
}

/// Real sockets on 127.0.0.1: auth over the wire, Origin rejection, 411, and the idle timeout.
@Suite("loopback server over TCP", .serialized)
struct LoopbackServerTests {
    /// A port the kernel says is free right now: bind 127.0.0.1:0, read the assigned port, close. (A random pick
    /// collided with long-running local listeners in the same range.)
    private static func freePort() -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        precondition(fd >= 0, "socket() failed")
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 && getsockname(fd, $0, &len) == 0 }
        }
        precondition(bound, "could not bind an ephemeral loopback port")
        return UInt16(bigEndian: addr.sin_port)
    }

    private func startServer(api: CollectorAPI? = nil, port: UInt16, limits: HTTPLimits = HTTPLimits(),
                             handler: LoopbackHTTPServer.Handler? = nil) throws -> LoopbackHTTPServer {
        let server = LoopbackHTTPServer(port: port, limits: limits, handler: handler ?? { api!.handle($0) })
        let ready = DispatchSemaphore(value: 0)
        server.onStateChange = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        try server.start()
        _ = ready.wait(timeout: .now() + 5)
        guard case .ready = server.state else { throw SQLiteError(code: -1, message: "listener not ready") }
        return server
    }

    /// Sends raw bytes and returns the full response (server closes after one response).
    private func raw(_ port: UInt16, _ payload: String, wait: TimeInterval = 5) -> String {
        let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        let done = DispatchSemaphore(value: 0)
        var received = Data()
        let q = DispatchQueue(label: "raw-client")
        func readMore() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                if let data { received.append(data) }
                if complete || error != nil { done.signal() } else { readMore() }
            }
        }
        conn.stateUpdateHandler = { state in
            if case .ready = state {
                if !payload.isEmpty { conn.send(content: Data(payload.utf8), completion: .contentProcessed { _ in }) }
                readMore()
            }
            if case .failed = state { done.signal() }
        }
        conn.start(queue: q)
        _ = done.wait(timeout: .now() + wait)
        conn.cancel()
        return q.sync { String(decoding: received, as: UTF8.self) }
    }

    @Test func authenticatedRequestOverTCP() throws {
        let port = Self.freePort()
        let h = try APIHarness(port: port)
        let server = try startServer(api: h.api, port: port)
        defer { server.stop() }

        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/imessage/handles")!)
        req.setValue("Bearer \(h.token.value)", forHTTPHeaderField: "Authorization")
        let done = DispatchSemaphore(value: 0)
        var status = 0
        var payload = Data()
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            payload = data ?? Data()
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 10)
        #expect(status == 200)
        let items = (try? JSONSerialization.jsonObject(with: payload) as? [String: Any])?["items"] as? [Any]
        #expect(items?.count == 5)

        let noAuth = raw(port, "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\r\n")
        #expect(noAuth.hasPrefix("HTTP/1.1 401 Unauthorized"))
        let withOrigin = raw(port, "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nOrigin: http://127.0.0.1:\(port)\r\nAuthorization: Bearer \(h.token.value)\r\n\r\n")
        #expect(withOrigin.hasPrefix("HTTP/1.1 403 Forbidden"))
        #expect(withOrigin.contains("forbidden_origin"))
        let rebound = raw(port, "GET /v1/health HTTP/1.1\r\nHost: attacker.example.com\r\nAuthorization: Bearer \(h.token.value)\r\n\r\n")
        #expect(rebound.contains("bad_host"))
        let noLength = raw(port, "POST /v1/whatsapp/snapshot HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nAuthorization: Bearer \(h.token.value)\r\n\r\n")
        #expect(noLength.hasPrefix("HTTP/1.1 411 Length Required"))
    }

    @Test func idleConnectionsTimeOut() throws {
        let port = Self.freePort()
        var limits = HTTPLimits()
        limits.idleTimeout = 0.5
        let server = try startServer(port: port, limits: limits, handler: { _ in .json(200, .object([])) })
        defer { server.stop() }
        let started = Date()
        let response = raw(port, "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1", wait: 5)
        #expect(response.hasPrefix("HTTP/1.1 408 Request Timeout"))
        #expect(Date().timeIntervalSince(started) < 4)
    }

    @Test func bindsToLoopbackOnly() {
        let params = LoopbackHTTPServer.loopbackParameters(port: 4321)
        guard case let .hostPort(host, port)? = params.requiredLocalEndpoint else {
            Issue.record("no required local endpoint"); return
        }
        #expect(host == NWEndpoint.Host("127.0.0.1"))
        #expect(port.rawValue == 4321)
        #expect(LoopbackHTTPServer.isLoopback(.hostPort(host: "127.0.0.1", port: 1)))
        #expect(LoopbackHTTPServer.isLoopback(.hostPort(host: "::1", port: 1)))
        #expect(!LoopbackHTTPServer.isLoopback(.hostPort(host: "192.168.1.20", port: 1)))
    }
}
