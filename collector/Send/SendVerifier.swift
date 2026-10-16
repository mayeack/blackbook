import Foundation

enum SendStatus: String, Equatable {
    case delivered, sent, unverified, ghost, failed
}

struct SendResult: Equatable {
    var status: SendStatus
    var messageGUIDs: [String]
    var rowIDs: [Int64]
    var errorCode: String?

    var json: JSON {
        .object([
            ("status", .string(status.rawValue)),
            ("message_guids", .array(messageGUIDs.map(JSON.string))),
            ("rowids", .array(rowIDs.map { .int($0) })),
            ("error_code", .str(errorCode)),
        ])
    }
}

/// Source of outgoing chat.db rows; `MessageReader` in production, a fake in tests.
protocol SentRowSource: AnyObject {
    func maxRowID() throws -> Int64
    func sentRows(afterRowID: Int64) throws -> [SentRow]
}

extension MessageReader: SentRowSource {
    func sentRows(afterRowID: Int64) throws -> [SentRow] {
        try sentRows(afterRowID: afterRowID, limit: 200)
    }
}

/// Confirms a send by watching chat.db (architecture.md §1a "Send algorithm"):
/// poll every 250 ms until the timeout for `is_from_me = 1` rows after the recorded
/// MAX(ROWID), in the recipient's self chat, whose decoded text matches. Returns every
/// match (note-to-self can write one or two rows). Never retries.
final class SendVerifier {
    static let pollInterval: TimeInterval = 0.25
    /// After the first match, keep watching briefly to collect the second note-to-self row.
    static let settleInterval: TimeInterval = 1.0

    private let source: SentRowSource
    private let clock: CollectorClock

    init(source: SentRowSource, clock: CollectorClock) {
        self.source = source
        self.clock = clock
    }

    func verify(to recipient: String, text: String, afterRowID: Int64, timeout: TimeInterval) -> SendResult {
        let target = HandleCanonical.canonical(recipient)
        let wanted = MessageText.clean(text)
        let deadline = clock.now().addingTimeInterval(max(0, timeout))
        var firstMatchAt: Date?
        var matches: [SentRow] = []
        var ghosts: [SentRow] = []
        var readFailures = 0

        while true {
            if let rows = try? source.sentRows(afterRowID: afterRowID) {
                let inSelfChat = rows.filter { row in
                    [row.chatIdentifier, row.handleID].contains { $0.map(HandleCanonical.canonical) == target }
                }
                matches = inSelfChat.filter { ($0.text.map(MessageText.clean) ?? "") == wanted }
                ghosts = inSelfChat.filter { row in
                    (row.text ?? "").isEmpty && !row.hasAttachments && row.balloonBundleID == nil
                }
            } else {
                readFailures += 1
            }

            let now = clock.now()
            if matches.contains(where: { $0.error != 0 }) { break }
            if !matches.isEmpty {
                if firstMatchAt == nil { firstMatchAt = now }
                let settled = now.timeIntervalSince(firstMatchAt!) >= Self.settleInterval
                if settled && matches.contains(where: \.isDelivered) { break }
            }
            if now >= deadline { break }
            clock.sleep(Self.pollInterval)
        }

        return Self.classify(matches: matches, ghosts: ghosts)
    }

    static func classify(matches: [SentRow], ghosts: [SentRow]) -> SendResult {
        if let failed = matches.first(where: { $0.error != 0 }) {
            return SendResult(status: .failed, messageGUIDs: matches.map(\.guid), rowIDs: matches.map(\.rowid),
                              errorCode: "messages_error_\(failed.error)")
        }
        if !matches.isEmpty {
            let status: SendStatus = matches.contains(where: \.isDelivered) ? .delivered : .sent
            return SendResult(status: status, messageGUIDs: matches.map(\.guid), rowIDs: matches.map(\.rowid), errorCode: nil)
        }
        if !ghosts.isEmpty {
            return SendResult(status: .ghost, messageGUIDs: ghosts.map(\.guid), rowIDs: ghosts.map(\.rowid), errorCode: "ghost_row")
        }
        return SendResult(status: .unverified, messageGUIDs: [], rowIDs: [], errorCode: nil)
    }
}
