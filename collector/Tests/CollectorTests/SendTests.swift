import Foundation
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

@Suite("send: allowlist, verifier, idempotency")
struct SendTests {
    // MARK: Allowlist

    @Test func allowlistRequiresCompiledAndOwnAddress() {
        let own: Set<String> = ["+15555550100", "owner@example.com"]
        let list = RecipientAllowlist(compiledHandles: ["+1 (555) 555-0100", "Owner@Example.com", "+15555550199"],
                                      ownAddresses: { own })
        #expect(list.allows("+15555550100"))
        #expect(list.allows("tel:+1 555-555-0100"))
        #expect(list.allows("OWNER@example.com"))
        #expect(!list.allows("+15555550199"), "compiled but not one of this Mac's addresses")
        #expect(!list.allows("+15555550101"), "a friend")
        #expect(!list.allows("5555550100"), "no fuzzy country-code or last-10-digit matching")
        #expect(!list.allows(""))
        #expect(!list.allows("+1555555010O"))
    }

    @Test func emptyCompiledListRefusesEverything() {
        let list = RecipientAllowlist(compiledHandles: GeneratedSelfHandles.handles, ownAddresses: { ["+15555550100"] })
        #expect(GeneratedSelfHandles.handles.isEmpty, "dev/test builds compile the empty fallback list")
        #expect(!list.allows("+15555550100"))
    }

    @Test func unreadableChatDBFailsClosed() {
        struct Boom: Error {}
        let list = RecipientAllowlist(compiledHandles: ["+15555550100"], ownAddresses: { throw Boom() })
        #expect(!list.allows("+15555550100"))
    }

    // MARK: Verifier state machine

    private func verify(_ script: [[SentRow]], timeout: TimeInterval = 8) -> (SendResult, FakeSentRows, FakeClock) {
        let rows = FakeSentRows()
        rows.script = script
        let clock = FakeClock()
        let result = SendVerifier(source: rows, clock: clock)
            .verify(to: "+15555550100", text: "🅨 hello", afterRowID: 100, timeout: timeout)
        return (result, rows, clock)
    }

    @Test func deliveredAfterSettleCollectsBothNoteToSelfRows() {
        let one = sentRow(101, text: "🅨 hello", delivered: true)
        let two = sentRow(102, text: "🅨 hello", delivered: true)
        let (result, rows, clock) = verify([[], [one], [one], [one, two], [one, two], [one, two], [one, two], [one, two]])
        #expect(result.status == .delivered)
        #expect(result.rowIDs == [101, 102])
        #expect(result.messageGUIDs == ["SENT-101", "SENT-102"])
        #expect(clock.now().timeIntervalSince(refDate) < 8, "stops early once delivered and settled")
        #expect(rows.polls >= 5)
    }

    @Test func sentButNotDeliveredRunsToTimeout() {
        let (result, rows, clock) = verify([[sentRow(101, text: "🅨 hello")]], timeout: 2)
        #expect(result.status == .sent)
        #expect(result.rowIDs == [101])
        #expect(clock.now().timeIntervalSince(refDate) >= 2)
        #expect(rows.polls == 9, "polls every 250 ms: t=0 … t=2.0")
    }

    @Test func nothingAppearsIsUnverified() {
        let (result, _, clock) = verify([[]], timeout: 1)
        #expect(result == SendResult(status: .unverified, messageGUIDs: [], rowIDs: [], errorCode: nil))
        #expect(clock.sleeps == 4)
    }

    @Test func emptyRowInSelfChatIsGhost() {
        let (result, _, _) = verify([[sentRow(101, text: nil)]], timeout: 1)
        #expect(result.status == .ghost)
        #expect(result.rowIDs == [101])
        #expect(result.errorCode == "ghost_row")
    }

    @Test func errorRowFailsImmediately() {
        let (result, rows, _) = verify([[sentRow(101, text: "🅨 hello", error: 22)]])
        #expect(result.status == .failed)
        #expect(result.errorCode == "messages_error_22")
        #expect(rows.polls == 1)
    }

    @Test func rowsOutsideSelfChatOrWithOtherTextAreIgnored() {
        let other = sentRow(101, text: "🅨 hello", chat: "+15555550101", delivered: true)
        let different = sentRow(102, text: "something else", delivered: true)
        let attachment = sentRow(103, text: nil, attachments: true)
        let (result, _, _) = verify([[other, different, attachment]], timeout: 1)
        #expect(result.status == .unverified)
    }

    @Test func zeroTimeoutPollsOnce() {
        let (result, rows, _) = verify([[]], timeout: 0)
        #expect(result.status == .unverified)
        #expect(rows.polls == 1)
    }

    // MARK: Service: refusal, idempotency, never-retry

    private func makeService(compiled: [String] = ["+15555550100"], own: Set<String> = ["+15555550100"],
                             ledgerURL: URL? = nil, runner: FakeAppleScriptRunner = FakeAppleScriptRunner(),
                             rows: FakeSentRows = FakeSentRows()) -> (SendService, FakeAppleScriptRunner, FakeSentRows) {
        let svc = SendService(allowlist: RecipientAllowlist(compiledHandles: compiled, ownAddresses: { own }),
                              ledger: SendLedger(fileURL: ledgerURL), sender: MessagesSender(runner: runner),
                              rows: rows, clock: FakeClock())
        return (svc, runner, rows)
    }

    private func request(_ to: String = "+15555550100", ref: String = "6F9619FF-8B86-D011-B42D-00C04FC964FF") -> SendRequest {
        SendRequest(to: to, text: "🅨 hello", clientRef: ref.lowercased(), verifyTimeoutMs: 500)
    }

    @Test func refusedRecipientNeverReachesAppleScript() {
        let (svc, runner, _) = makeService()
        #expect(throws: APIError.recipientNotAllowed) { try svc.send(request("+15555550101")) }
        #expect(runner.calls.isEmpty)
    }

    @Test func noGeneratedHandlesMeansRefusal() {
        let (svc, runner, _) = makeService(compiled: GeneratedSelfHandles.handles)
        #expect(throws: APIError.recipientNotAllowed) { try svc.send(request()) }
        #expect(runner.calls.isEmpty)
    }

    @Test func sameClientRefSendsOnce() throws {
        let rows = FakeSentRows()
        rows.script = [[sentRow(101, text: "🅨 hello", delivered: true)]]
        let (svc, runner, _) = makeService(rows: rows)
        let first = try svc.send(request())
        let second = try svc.send(request())
        #expect(runner.calls.count == 1)
        #expect(first.status == .delivered)
        #expect(second == first)
        _ = try svc.send(request(ref: "7F9619FF-8B86-D011-B42D-00C04FC964FF"))
        #expect(runner.calls.count == 2)
    }

    @Test func automationDeniedIsFailedWithoutRetry() throws {
        let runner = FakeAppleScriptRunner()
        runner.outcome = .error(number: -1743, message: "Not authorized")
        let (svc, _, _) = makeService(runner: runner)
        let result = try svc.send(request())
        #expect(result == SendResult(status: .failed, messageGUIDs: [], rowIDs: [], errorCode: "automation_denied"))
        #expect(try svc.send(request()) == result)
        #expect(runner.calls.count == 1)
    }

    @Test func ledgerPersistsAndPendingIsNeverResent() throws {
        let dir = TestPaths.tempDir("ledger")
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("send-ledger.json")

        let crashed = SendLedger(fileURL: url)
        crashed.markPending("ref-a", at: refDate)
        #expect(SecureFiles.posixMode(url) == 0o600)

        let (svc, runner, _) = makeService(ledgerURL: url)
        let result = try svc.send(SendRequest(to: "+15555550100", text: "x", clientRef: "ref-a", verifyTimeoutMs: 0))
        #expect(result.status == .unverified)
        #expect(result.errorCode == "interrupted")
        #expect(runner.calls.isEmpty, "a ref left pending by a crash is reported, not re-sent")
    }

    @Test func ledgerIsBoundedLRU() {
        let ledger = SendLedger(fileURL: nil, capacity: 3)
        for i in 0..<5 {
            ledger.record("r\(i)", result: SendResult(status: .sent, messageGUIDs: [], rowIDs: [], errorCode: nil), at: refDate)
        }
        #expect(ledger.lookup("r0") == nil)
        #expect(ledger.lookup("r1") == nil)
        #expect(ledger.lookup("r4")?.status == "sent")
    }

    @Test func requestValidation() throws {
        func parse(_ obj: [String: Any]) throws -> SendRequest {
            try SendRequest.parse(JSONBody(fields: obj))
        }
        let ok = try parse(["to": "+15555550100", "text": "🅨 hi", "client_ref": "6F9619FF-8B86-D011-B42D-00C04FC964FF"])
        #expect(ok.verifyTimeoutMs == 8000)
        #expect(ok.clientRef == "6f9619ff-8b86-d011-b42d-00c04fc964ff")
        #expect(throws: APIError.self) { try parse(["text": "hi", "client_ref": UUID().uuidString]) }
        #expect(throws: APIError.self) { try parse(["to": "+15555550100", "text": " \u{FFFC} ", "client_ref": UUID().uuidString]) }
        #expect(throws: APIError.self) { try parse(["to": "+15555550100", "text": "🅨 hi", "client_ref": "not-a-uuid"]) }
        #expect(throws: APIError.self) {
            try parse(["to": "+15555550100", "text": "🅨 hi", "client_ref": UUID().uuidString, "verify_timeout_ms": 70000])
        }
        #expect(throws: APIError.self) {
            try parse(["to": "+15555550100", "text": "🅨 hi", "client_ref": UUID().uuidString, "verify_timeout_ms": true])
        }
        // the bot marker must be the very first scalar of the raw text
        #expect(throws: APIError.self) { try parse(["to": "+15555550100", "text": "hi", "client_ref": UUID().uuidString]) }
        #expect(throws: APIError.self) { try parse(["to": "+15555550100", "text": " 🅨 hi", "client_ref": UUID().uuidString]) }
    }

    // MARK: End to end against a synthetic chat.db (fake AppleScript writes the rows)

    @Test func endToEndAgainstSyntheticChatDB() throws {
        let w = try SyntheticWorld()
        let reader = w.reader
        let runner = FakeAppleScriptRunner()
        runner.onSend = { _, text in
            // Note-to-self writes two outgoing rows in the self chat.
            for i in 0..<2 {
                _ = try? w.fx.message(MessageSpec(guid: "NTS-\(i)", text: text, handle: w.me, fromMe: true,
                                                  chat: w.selfChat, isDelivered: true))
            }
        }
        let svc = SendService(
            allowlist: RecipientAllowlist(compiledHandles: ["+15555550100"], ownAddresses: { try reader.ownAccountAddresses() }),
            ledger: SendLedger(fileURL: nil), sender: MessagesSender(runner: runner), rows: reader, clock: FakeClock())
        let result = try svc.send(SendRequest(to: "+15555550100", text: "🅨 hello", clientRef: "e2e", verifyTimeoutMs: 8000))
        #expect(result.status == .delivered)
        #expect(result.messageGUIDs == ["NTS-0", "NTS-1"])
        #expect(runner.calls.map(\.handle) == ["+15555550100"])

        #expect(throws: APIError.recipientNotAllowed) {
            try svc.send(SendRequest(to: "+15555550101", text: "hi", clientRef: "e2e-2", verifyTimeoutMs: 0))
        }
    }

    @Test func appleScriptSourceUsesParticipantOfIMessageAccount() {
        let src = NSAppleScriptRunner.source
        #expect(src.contains("send theText to participant theHandle of (first account whose service type = iMessage)"))
        #expect(!src.contains("any;"))
    }
}
