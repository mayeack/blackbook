// yb-collector-verify: reads the REAL ~/Library/Messages/chat.db read-only through the same
// MessageReader the API uses and prints aggregate counts only — never message text, handles
// or names. Requires Full Disk Access for the invoking terminal.
//
//   swift run yb-collector-verify [--days 90] [--db /path/to/chat.db]

@testable import CollectorCore
import Foundation

var days = 90
var path = ChatDB.defaultPath
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--days": days = Int(args.popFirst() ?? "") ?? days
    case "--db": path = args.popFirst() ?? path
    default:
        FileHandle.standardError.write(Data("unknown argument\n".utf8))
        exit(2)
    }
}

let reader = MessageReader(db: ChatDB(path: path))
let until = Date().addingTimeInterval(60)
let since = until.addingTimeInterval(-Double(days) * 86_400)

struct Tally {
    var rows = 0
    var reactions = 0
    var groupEvents = 0
    var regular = 0
    var withText = 0
    var fromTextColumn = 0
    var fromAttributedBody = 0
    var noTextAttachment = 0
    var noTextBalloon = 0
    var noTextRetracted = 0
    var noTextOther = 0
    var groupSendsHandleZero = 0
    var fromMeNoSender = 0
    var pages = 0
}

var t = Tally()
var after: Int64 = 0
do {
    while true {
        let page = try reader.messages(since: since, until: until, afterRowID: after, limit: MessageReader.maxPageSize)
        t.pages += 1
        for m in page.items {
            t.rows += 1
            if m.isFromMe && m.senderHandle == nil { t.fromMeNoSender += 1 }
            if m.isFromMe && m.chatStyle == 43 { t.groupSendsHandleZero += 1 }
            if let a = m.assoc, (2000...3999).contains(a.type) {
                t.reactions += 1
                continue
            }
            if m.itemType != 0 {
                t.groupEvents += 1
                continue
            }
            t.regular += 1
            switch m.textSource {
            case .text: t.withText += 1; t.fromTextColumn += 1
            case .attributedBody: t.withText += 1; t.fromAttributedBody += 1
            case .none:
                if m.dateRetracted != nil { t.noTextRetracted += 1 }
                else if !m.attachments.isEmpty { t.noTextAttachment += 1 }
                else if m.balloonBundleID != nil { t.noTextBalloon += 1 }
                else { t.noTextOther += 1 }
            }
        }
        after = page.nextAfterRowID
        if !page.hasMore { break }
    }
} catch {
    print("error: \(error)")
    exit(1)
}

// Raw SQL cross-check for handle_id = 0 outgoing group rows in the same window.
let rawHandleZero: Int64 = (try? reader.db.read { conn, _ in
    try conn.scalarInt("""
        SELECT COUNT(*) FROM message m
        JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
        WHERE m.is_from_me = 1 AND m.handle_id = 0 AND c.style = 43 AND m.date >= ? AND m.date < ?
        """, [.int(AppleTime.chatDBValue(from: since)), .int(AppleTime.chatDBValue(from: until))])
}) ?? nil ?? -1

func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : String(format: "%.2f%%", 100 * Double(n) / Double(d)) }

let textBearing = t.regular - t.noTextAttachment - t.noTextBalloon - t.noTextRetracted
print("window_days=\(days) pages=\(t.pages) rows=\(t.rows)")
print("reactions_excluded=\(t.reactions) group_events=\(t.groupEvents)")
print("non_reaction_messages=\(t.regular) with_text=\(t.withText) pct=\(pct(t.withText, t.regular))")
print("  text_column=\(t.fromTextColumn) attributed_body=\(t.fromAttributedBody)")
print("  no_text: attachment_only=\(t.noTextAttachment) balloon_only=\(t.noTextBalloon) retracted=\(t.noTextRetracted) other=\(t.noTextOther)")
print("text_bearing_messages=\(textBearing) with_text_pct=\(pct(t.withText, textBearing))")
print("group_sends_from_me(style 43, collector)=\(t.groupSendsHandleZero) raw_sql_handle_id0_group_sends=\(rawHandleZero)")
print("from_me_rows_with_null_sender=\(t.fromMeNoSender)")
