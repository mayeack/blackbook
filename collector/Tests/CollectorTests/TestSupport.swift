import Foundation
import SQLite3
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

// All fixtures are synthetic: 555-01xx numbers, example.com addresses, invented names.

enum TestPaths {
    /// collector/Tests, resolved from this source file so it works under SwiftPM and Xcode.
    static let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    static let schema = testsDir.appendingPathComponent("Fixtures/chatdb.schema.sql")
    static let golden = testsDir.appendingPathComponent("Golden", isDirectory: true)

    static func tempDir(_ label: String = "yb") -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(label)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

/// Builds `NSArchiver` typedstream blobs the way Messages stores `attributedBody`.
enum AttributedBody {
    static func blob(_ text: String, link: Bool = false) -> Data {
        let attributed = NSMutableAttributedString(string: text)
        if link, text.count > 3 {
            attributed.addAttribute(.link, value: URL(string: "https://example.com/x")!, range: NSRange(location: 0, length: 3))
        }
        return NSArchiver.archivedData(withRootObject: attributed)
    }
}

let refDate = ISOTime.parse("2026-10-01T12:00:00.000Z")!

struct AttachmentSpec {
    var mime: String? = "image/jpeg"
    var uti: String? = "public.jpeg"
    var name: String? = "IMG_0001.jpeg"
    var bytes: Int64 = 12345
    var sticker = false
}

struct MessageSpec {
    var guid: String
    var text: String? = nil
    var body: Data? = nil
    var handle: Int64 = 0
    var fromMe = false
    var date: Date = refDate
    var chat: Int64? = nil
    var service = "iMessage"
    var itemType = 0
    var groupActionType = 0
    var otherHandle: Int64 = 0
    var groupTitle: String? = nil
    var assocType = 0
    var assocGUID: String? = nil
    var assocEmoji: String? = nil
    var balloon: String? = nil
    var dateEdited: Date? = nil
    var dateRetracted: Date? = nil
    var isDelivered = true
    var isSent = true
    var error = 0
    var isSpam = false
    var replyTo: String? = nil
    var threadOriginator: String? = nil
    var account: String? = nil
    var destinationCallerID: String? = nil
    var summaryInfo: Data? = nil
    var attachments: [AttachmentSpec] = []
}

/// A temp chat.db created from the real (schema-only) Tahoe DDL, in WAL mode like Messages'.
final class ChatDBFixture {
    let dir: URL
    let path: String
    let conn: SQLiteConnection

    init() throws {
        dir = TestPaths.tempDir("chatdb")
        path = dir.appendingPathComponent("chat.db").path
        conn = try SQLiteConnection(path: path, mode: .readWriteCreate)
        _ = try conn.scalarText("PRAGMA journal_mode=WAL")
        try Self.applySchema(conn, sql: try String(contentsOf: TestPaths.schema, encoding: .utf8))
    }

    deinit {
        conn.close()
        try? FileManager.default.removeItem(at: dir)
    }

    /// Runs every CREATE TABLE/INDEX statement; skips triggers (they call Messages-private
    /// functions) and sqlite-internal tables.
    static func applySchema(_ conn: SQLiteConnection, sql: String) throws {
        var statement = ""
        for line in sql.components(separatedBy: "\n") {
            if statement.isEmpty && (line.hasPrefix("--") || line.trimmingCharacters(in: .whitespaces).isEmpty) { continue }
            statement += line + "\n"
            guard sqlite3_complete(statement) != 0 else { continue }
            let text = statement.trimmingCharacters(in: .whitespacesAndNewlines)
            statement = ""
            if text.hasPrefix("CREATE TRIGGER") || text.hasPrefix("CREATE TABLE sqlite_") { continue }
            try conn.execute(text)
        }
    }

    @discardableResult
    func handle(_ id: String, service: String = "iMessage") throws -> Int64 {
        try conn.run("INSERT INTO handle (id, service, uncanonicalized_id) VALUES (?, ?, ?)", [.text(id), .text(service), .text(id)])
        return conn.lastInsertRowID
    }

    @discardableResult
    func chat(guid: String, style: Int, identifier: String, displayName: String? = nil, service: String = "iMessage",
              accountLogin: String? = nil, members: [Int64] = []) throws -> Int64 {
        try conn.run("""
            INSERT INTO chat (guid, style, chat_identifier, display_name, service_name, account_login)
            VALUES (?, ?, ?, ?, ?, ?)
            """, [.text(guid), .int(Int64(style)), .text(identifier), displayName.map(SQLiteValue.text) ?? .null,
                  .text(service), accountLogin.map(SQLiteValue.text) ?? .null])
        let id = conn.lastInsertRowID
        for m in members {
            try conn.run("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)", [.int(id), .int(m)])
        }
        return id
    }

    @discardableResult
    func message(_ m: MessageSpec) throws -> Int64 {
        func opt(_ s: String?) -> SQLiteValue { s.map(SQLiteValue.text) ?? .null }
        func optDate(_ d: Date?) -> SQLiteValue { d.map { .int(AppleTime.chatDBValue(from: $0)) } ?? .null }
        try conn.run("""
            INSERT INTO message (guid, text, attributedBody, handle_id, is_from_me, date, service, item_type,
              group_action_type, other_handle, group_title, associated_message_type, associated_message_guid,
              associated_message_emoji, balloon_bundle_id, date_edited, date_retracted, is_delivered, is_sent, error,
              is_spam, reply_to_guid, thread_originator_guid, cache_has_attachments, account, destination_caller_id,
              message_summary_info)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, [
                .text(m.guid), opt(m.text), m.body.map(SQLiteValue.blob) ?? .null, .int(m.handle), .int(m.fromMe ? 1 : 0),
                .int(AppleTime.chatDBValue(from: m.date)), .text(m.service), .int(Int64(m.itemType)),
                .int(Int64(m.groupActionType)), .int(m.otherHandle), opt(m.groupTitle), .int(Int64(m.assocType)),
                opt(m.assocGUID), opt(m.assocEmoji), opt(m.balloon), optDate(m.dateEdited), optDate(m.dateRetracted),
                .int(m.isDelivered ? 1 : 0), .int(m.isSent ? 1 : 0), .int(Int64(m.error)), .int(m.isSpam ? 1 : 0),
                opt(m.replyTo), opt(m.threadOriginator), .int(m.attachments.isEmpty ? 0 : 1), opt(m.account),
                opt(m.destinationCallerID), m.summaryInfo.map(SQLiteValue.blob) ?? .null,
            ])
        let rowid = conn.lastInsertRowID
        if let chat = m.chat {
            try conn.run("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
                         [.int(chat), .int(rowid), .int(AppleTime.chatDBValue(from: m.date))])
        }
        for (i, a) in m.attachments.enumerated() {
            let guid = "\(m.guid)-att\(i)"
            try conn.run("""
                INSERT INTO attachment (guid, original_guid, filename, mime_type, uti, transfer_name, total_bytes, is_sticker)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, [.text(guid), .text(guid), .text("~/Library/Messages/Attachments/xx/\(guid)"), opt(a.mime), opt(a.uti),
                      opt(a.name), .int(a.bytes), .int(a.sticker ? 1 : 0)])
            let attID = conn.lastInsertRowID
            try conn.run("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)", [.int(rowid), .int(attID)])
        }
        return rowid
    }
}

/// Deterministic clock: `sleep` advances time instantly.
final class FakeClock: CollectorClock {
    var current: Date
    private(set) var sleeps = 0
    var onSleep: ((FakeClock) -> Void)?

    init(_ start: Date = refDate) { current = start }

    func now() -> Date { current }

    func sleep(_ seconds: TimeInterval) {
        sleeps += 1
        current = current.addingTimeInterval(seconds)
        onSleep?(self)
    }
}

/// Stand-in for NSAppleScript; records calls instead of touching Messages.
final class FakeAppleScriptRunner: AppleScriptRunning {
    var outcome: AppleScriptOutcome = .ok
    private(set) var calls: [(handle: String, text: String)] = []
    var onSend: ((String, String) -> Void)?

    func send(handle: String, text: String) -> AppleScriptOutcome {
        calls.append((handle, text))
        onSend?(handle, text)
        return outcome
    }
}

/// Scripted chat.db rows for the verifier: `script[n]` is what the nth poll sees.
final class FakeSentRows: SentRowSource {
    var max: Int64 = 100
    var script: [[SentRow]] = []
    private(set) var polls = 0

    func maxRowID() throws -> Int64 { max }

    func sentRows(afterRowID: Int64) throws -> [SentRow] {
        defer { polls += 1 }
        guard !script.isEmpty else { return [] }
        return script[min(polls, script.count - 1)].filter { $0.rowid > afterRowID }
    }
}

final class FakeContacts: ContactsSource {
    var auth: ContactsAuthorization = .granted
    var cards: [ContactCard] = []
    private(set) var requested = 0
    func authorization() -> ContactsAuthorization { auth }
    func requestAccess() { requested += 1 }
    func fetchAll() throws -> [ContactCard] { cards }
}

final class FakeProbe: SystemProbe {
    func contactsPermission() -> String { "granted" }
    func automationMessagesPermission() -> String { "not_determined" }
    func isRunning(bundleID: String) -> Bool { bundleID == "com.apple.MobileSMS" }
}

func sentRow(_ rowid: Int64, text: String?, chat: String? = "+15555550100", delivered: Bool = false, error: Int64 = 0,
             attachments: Bool = false, balloon: String? = nil) -> SentRow {
    SentRow(rowid: rowid, guid: "SENT-\(rowid)", text: text, chatIdentifier: chat, handleID: chat, isDelivered: delivered,
            isSent: true, error: error, hasAttachments: attachments, balloonBundleID: balloon)
}

/// Compares `value` with `Golden/<name>.json`. Creating or rewriting a golden is always explicit
/// (`YB_UPDATE_GOLDEN=1`): a missing file fails, so a renamed route or deleted golden can't pass silently.
func checkGolden(_ name: String, _ value: JSON) throws -> Bool {
    let url = TestPaths.golden.appendingPathComponent("\(name).json")
    let data = value.serialized(pretty: true)
    if ProcessInfo.processInfo.environment["YB_UPDATE_GOLDEN"] == "1" {
        try FileManager.default.createDirectory(at: TestPaths.golden, withIntermediateDirectories: true)
        try data.write(to: url)
        return true
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
        Issue.record("missing golden \(name).json; run with YB_UPDATE_GOLDEN=1 to create it")
        return false
    }
    return (try Data(contentsOf: url)) == data
}
