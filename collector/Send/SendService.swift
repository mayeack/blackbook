import Foundation

struct SendRequest: Equatable {
    static let maxTextLength = 10_000
    static let defaultVerifyTimeoutMs = 8000
    static let maxVerifyTimeoutMs = 60_000
    /// Every bot message starts with U+1F168 so the Node ingester can always tell a bot row from a typed command.
    static let botMarker: Unicode.Scalar = "\u{1F168}"

    let to: String
    let text: String
    let clientRef: String
    let verifyTimeoutMs: Int

    /// Validates a `POST /v1/imessage/send` body.
    static func parse(_ body: JSONBody) throws -> SendRequest {
        guard let to = body.string("to")?.trimmingCharacters(in: .whitespacesAndNewlines), !to.isEmpty else {
            throw APIError.badRequest("`to` is required")
        }
        guard let text = body.string("text"), !MessageText.clean(text).isEmpty else {
            throw APIError.badRequest("`text` is required")
        }
        guard text.count <= maxTextLength else { throw APIError.badRequest("`text` is too long") }
        guard text.unicodeScalars.first == botMarker else {
            throw APIError.badRequest("`text` must start with the bot marker U+1F168")
        }
        guard let ref = body.string("client_ref"), UUID(uuidString: ref) != nil else {
            throw APIError.badRequest("`client_ref` must be a UUID")
        }
        var timeout = defaultVerifyTimeoutMs
        if body.has("verify_timeout_ms") {
            guard let t = body.int("verify_timeout_ms"), (0...maxVerifyTimeoutMs).contains(t) else {
                throw APIError.badRequest("`verify_timeout_ms` must be an integer in 0...\(maxVerifyTimeoutMs)")
            }
            timeout = t
        }
        return SendRequest(to: to, text: text, clientRef: ref.lowercased(), verifyTimeoutMs: timeout)
    }
}

/// `POST /v1/imessage/send`: allowlist → idempotency → record MAX(ROWID) → AppleScript →
/// verify. Sends are serialized; the collector never retries a send.
final class SendService {
    private let allowlist: RecipientAllowlist
    private let ledger: SendLedger
    private let sender: MessagesSender
    private let rows: SentRowSource
    private let clock: CollectorClock
    private let sendLock = NSLock()

    init(allowlist: RecipientAllowlist, ledger: SendLedger, sender: MessagesSender,
         rows: SentRowSource, clock: CollectorClock) {
        self.allowlist = allowlist
        self.ledger = ledger
        self.sender = sender
        self.rows = rows
        self.clock = clock
    }

    func send(_ request: SendRequest) throws -> SendResult {
        guard allowlist.allows(request.to) else { throw APIError.recipientNotAllowed }

        sendLock.lock()
        defer { sendLock.unlock() }

        if let previous = ledger.lookup(request.clientRef) {
            return SendLedger.result(from: previous)
        }
        let before: Int64
        do {
            before = try rows.maxRowID()
        } catch let error as ChatDBError {
            throw APIError.from(error)
        }

        ledger.markPending(request.clientRef, at: clock.now())
        let result: SendResult
        switch sender.send(to: request.to, text: request.text) {
        case let .error(number, _):
            let code = number == AppleScriptOutcome.automationDeniedNumber ? "automation_denied" : "applescript_error_\(number)"
            result = SendResult(status: .failed, messageGUIDs: [], rowIDs: [], errorCode: code)
        case .ok:
            let verifier = SendVerifier(source: rows, clock: clock)
            result = verifier.verify(to: request.to, text: request.text, afterRowID: before,
                                     timeout: TimeInterval(request.verifyTimeoutMs) / 1000)
        }
        ledger.record(request.clientRef, result: result, at: clock.now())
        return result
    }
}
