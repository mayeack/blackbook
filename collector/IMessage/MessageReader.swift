import Foundation

/// Read-side queries over chat.db. Row selection follows the research recipe: LEFT JOIN handle
/// (so `handle_id = 0` group sends survive), the message's chat via chat_message_join, and
/// attachment metadata only. Node owns every cursor; this type is stateless.
final class MessageReader {
    static let maxPageSize = 1000
    static let maxChatPageSize = 500

    let db: ChatDB

    init(db: ChatDB) {
        self.db = db
    }

    // MARK: Messages

    func messages(afterRowID: Int64, limit: Int, chatGUID: String? = nil) throws -> RowPage<Msg> {
        if let chatGUID {
            let clause = """
                m.ROWID IN (SELECT j.message_id FROM chat_message_join j JOIN chat cc ON cc.ROWID = j.chat_id
                            WHERE cc.guid = ? AND j.message_id > ?)
                """
            return try page(clause: clause, binds: [.text(chatGUID), .int(afterRowID)], after: afterRowID, limit: limit)
        }
        return try page(clause: "m.ROWID > ?", binds: [.int(afterRowID)], after: afterRowID, limit: limit)
    }

    /// The 48 h overlap re-read: rows whose `date` is in [since, until), paged by rowid.
    func messages(since: Date, until: Date, afterRowID: Int64, limit: Int) throws -> RowPage<Msg> {
        try page(clause: "m.date >= ? AND m.date < ? AND m.ROWID > ?",
                 binds: [.int(AppleTime.chatDBValue(from: since)), .int(AppleTime.chatDBValue(from: until)), .int(afterRowID)],
                 after: afterRowID, limit: limit)
    }

    /// Rows edited or unsent after `since` (a rowid cursor never sees these changes), with the
    /// unsent part indexes from `message_summary_info`.
    func edited(since: Date, afterRowID: Int64, limit: Int) throws -> RowPage<EditedMsg> {
        let t = AppleTime.chatDBValue(from: since)
        let page = try page(clause: "(COALESCE(%date_edited%, 0) > ? OR COALESCE(%date_retracted%, 0) > ?) AND m.ROWID > ?",
                            binds: [.int(t), .int(t), .int(afterRowID)], after: afterRowID, limit: limit)
        var summaries: [Int64: Data] = [:]
        if !page.items.isEmpty {
            try db.read { conn, caps in
                guard caps.messageColumns.contains("message_summary_info") else { return }
                let list = page.items.map { String($0.rowid) }.joined(separator: ",")
                for (id, blob) in try conn.query("SELECT ROWID, message_summary_info FROM message WHERE ROWID IN (\(list))",
                                                 map: { ($0.int(0), $0.blob(1)) }) {
                    if let blob { summaries[id] = blob }
                }
            }
        }
        let items = page.items.map { EditedMsg(msg: $0, retractedParts: EditedMsg.retractedParts(fromSummaryInfo: summaries[$0.rowid])) }
        return RowPage(items: items, nextAfterRowID: page.nextAfterRowID, hasMore: page.hasMore, maxRowID: page.maxRowID)
    }

    private func page(clause: String, binds: [SQLiteValue], after: Int64, limit: Int) throws -> RowPage<Msg> {
        try db.read { conn, caps in
            let resolved = clause
                .replacingOccurrences(of: "%date_edited%", with: caps.m("date_edited"))
                .replacingOccurrences(of: "%date_retracted%", with: caps.m("date_retracted"))
            let sql = Self.messageSelect(caps) + "\nWHERE " + resolved + "\nORDER BY m.ROWID\nLIMIT ?"
            var rows = try conn.query(sql, binds + [.int(Int64(limit + 1))], map: Self.decodeMessageRow)
            let hasMore = rows.count > limit
            if hasMore { rows.removeLast(rows.count - limit) }
            let withAttachments = rows.filter(\.hasAttachments).map(\.msg.rowid)
            let attachments = try Self.attachments(conn, rowids: withAttachments)
            let items = rows.map { row -> Msg in
                var msg = row.msg
                msg.attachments = attachments[msg.rowid] ?? []
                return msg
            }
            let maxRowID = try conn.scalarInt("SELECT MAX(ROWID) FROM message") ?? 0
            return RowPage(items: items, nextAfterRowID: items.last?.rowid ?? after, hasMore: hasMore, maxRowID: maxRowID)
        }
    }

    private static func messageSelect(_ caps: ChatDBCapabilities) -> String {
        """
        SELECT m.ROWID, m.guid, \(caps.m("text")), \(caps.m("attributedBody")), \(caps.m("service")),
               \(caps.m("is_from_me")), h.id, \(caps.m("date")), \(caps.m("date_edited")), \(caps.m("date_retracted")),
               \(caps.m("item_type")), \(caps.m("group_action_type")), oh.id, \(caps.m("group_title")),
               \(caps.m("associated_message_type")), \(caps.m("associated_message_guid")), \(caps.m("associated_message_emoji")),
               \(caps.m("reply_to_guid")), \(caps.m("thread_originator_guid")), \(caps.m("balloon_bundle_id")),
               \(caps.m("is_spam")), \(caps.m("is_delivered")), \(caps.m("error")), \(caps.m("cache_has_attachments")),
               c.guid, c.style, c.chat_identifier, c.display_name
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        LEFT JOIN handle oh ON oh.ROWID = \(caps.m("other_handle"))
        LEFT JOIN chat c ON c.ROWID = (SELECT j.chat_id FROM chat_message_join j
                                       WHERE j.message_id = m.ROWID ORDER BY j.chat_id LIMIT 1)
        """
    }

    private struct DecodedRow {
        var msg: Msg
        let hasAttachments: Bool
    }

    private static func decodeMessageRow(_ r: SQLiteRow) -> DecodedRow {
        let isFromMe = r.bool(5)
        let (text, source) = MessageText.resolve(text: r.text(2), attributedBody: r.blob(3))
        let assocType = r.int(14)
        let assocGUID = r.text(15)
        let assoc: MsgAssoc? = (assocType != 0 || assocGUID != nil)
            ? MsgAssoc(type: Int(assocType), targetGUID: MsgAssoc.targetGUID(from: assocGUID),
                       emoji: MsgAssoc.emoji(type: Int(assocType), column: r.text(16)))
            : nil
        let msg = Msg(
            rowid: r.int(0),
            guid: r.text(1) ?? "",
            chatGUID: r.text(24),
            chatStyle: r.intOrNil(25),
            chatIdentifier: nonEmpty(r.text(26)),
            chatDisplayName: nonEmpty(r.text(27)),
            service: nonEmpty(r.text(4)),
            senderHandle: isFromMe ? nil : nonEmpty(r.text(6)),
            isFromMe: isFromMe,
            // 0 is the chat.db epoch itself; `date` is never null on the wire.
            date: r.intOrNil(7).flatMap(AppleTime.date(fromChatDB:)) ?? Date(timeIntervalSinceReferenceDate: 0),
            dateEdited: r.intOrNil(8).flatMap(AppleTime.date(fromChatDB:)),
            dateRetracted: r.intOrNil(9).flatMap(AppleTime.date(fromChatDB:)),
            text: text,
            textSource: source,
            itemType: r.int(10),
            groupActionType: r.int(11),
            otherHandle: nonEmpty(r.text(12)),
            groupTitle: nonEmpty(r.text(13)),
            assoc: assoc,
            replyToGUID: nonEmpty(r.text(17)),
            threadOriginatorGUID: nonEmpty(r.text(18)),
            balloonBundleID: nonEmpty(r.text(19)),
            isSpam: r.bool(20),
            isDelivered: r.bool(21),
            error: r.int(22),
            attachments: []
        )
        return DecodedRow(msg: msg, hasAttachments: r.bool(23))
    }

    private static func attachments(_ conn: SQLiteConnection, rowids: [Int64]) throws -> [Int64: [MsgAttachment]] {
        guard !rowids.isEmpty else { return [:] }
        let list = rowids.map(String.init).joined(separator: ",")
        let sql = """
            SELECT j.message_id, a.mime_type, a.uti, a.transfer_name, a.total_bytes, a.is_sticker
            FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id
            WHERE j.message_id IN (\(list))
            ORDER BY j.message_id, a.ROWID
            """
        var out: [Int64: [MsgAttachment]] = [:]
        for (id, att) in try conn.query(sql, map: { r in
            (r.int(0), MsgAttachment(mime: nonEmpty(r.text(1)), uti: nonEmpty(r.text(2)), name: nonEmpty(r.text(3)),
                                     bytes: max(0, r.int(4)), isSticker: r.bool(5)))
        }) {
            out[id, default: []].append(att)
        }
        return out
    }

    // MARK: Attachment files

    /// The `index`th attachment of message `guid` (chat.db order, the same order as `Msg.attachments`) and the
    /// identifiers of the chats the message is in. Nil when either doesn't exist.
    func attachment(messageGUID: String, index: Int) throws -> AttachmentLocation? {
        try db.read { conn, _ in
            let rows = try conn.query("""
                SELECT m.ROWID, a.filename, a.mime_type, a.uti, a.total_bytes, a.is_sticker
                FROM message m
                JOIN message_attachment_join j ON j.message_id = m.ROWID
                JOIN attachment a ON a.ROWID = j.attachment_id
                WHERE m.guid = ?
                ORDER BY a.ROWID LIMIT 1 OFFSET ?
                """, [.text(messageGUID), .int(Int64(index))]) { r in
                (rowid: r.int(0), filename: nonEmpty(r.text(1)), mime: nonEmpty(r.text(2)), uti: nonEmpty(r.text(3)),
                 bytes: max(0, r.int(4)), sticker: r.bool(5))
            }
            guard let row = rows.first else { return nil }
            let chats = try conn.query("""
                SELECT c.chat_identifier FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id
                WHERE j.message_id = ?
                """, [.int(row.rowid)]) { nonEmpty($0.text(0)) }
            return AttachmentLocation(filename: row.filename, mime: row.mime, uti: row.uti, bytes: row.bytes,
                                      isSticker: row.sticker, chatIdentifiers: chats.compactMap { $0 })
        }
    }

    // MARK: Chats and handles

    func chats(afterRowID: Int64, limit: Int) throws -> RowPage<ChatRow> {
        try db.read { conn, caps in
            let sql = """
                SELECT c.ROWID, c.guid, c.style, c.chat_identifier, c.display_name, \(caps.c("service_name")),
                       (SELECT MAX(j.message_date) FROM chat_message_join j WHERE j.chat_id = c.ROWID)
                FROM chat c WHERE c.ROWID > ? ORDER BY c.ROWID LIMIT ?
                """
            var rows = try conn.query(sql, [.int(afterRowID), .int(Int64(limit + 1))]) { r in
                (rowid: r.int(0), guid: r.text(1) ?? "", style: r.intOrNil(2), identifier: nonEmpty(r.text(3)),
                 display: nonEmpty(r.text(4)), service: nonEmpty(r.text(5)), last: r.intOrNil(6))
            }
            let hasMore = rows.count > limit
            if hasMore { rows.removeLast(rows.count - limit) }
            var members: [Int64: [String]] = [:]
            if !rows.isEmpty {
                let list = rows.map { String($0.rowid) }.joined(separator: ",")
                let memberSQL = """
                    SELECT j.chat_id, h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
                    WHERE j.chat_id IN (\(list)) ORDER BY j.chat_id, h.ROWID
                    """
                for (chat, id) in try conn.query(memberSQL, map: { ($0.int(0), $0.text(1) ?? "") }) where !id.isEmpty {
                    if !(members[chat]?.contains(id) ?? false) { members[chat, default: []].append(id) }
                }
            }
            let items = rows.map {
                ChatRow(rowid: $0.rowid, guid: $0.guid, style: $0.style, identifier: $0.identifier,
                        displayName: $0.display, service: $0.service, members: members[$0.rowid] ?? [],
                        lastMessageAt: $0.last.flatMap(AppleTime.date(fromChatDB:)))
            }
            let maxRowID = try conn.scalarInt("SELECT MAX(ROWID) FROM chat") ?? 0
            return RowPage(items: items, nextAfterRowID: items.last?.rowid ?? afterRowID, hasMore: hasMore, maxRowID: maxRowID)
        }
    }

    func handles() throws -> [HandleRow] {
        try db.read { conn, _ in
            try conn.query("SELECT ROWID, id, service FROM handle ORDER BY ROWID") {
                HandleRow(rowid: $0.int(0), id: $0.text(1) ?? "", service: nonEmpty($0.text(2)))
            }
        }
    }

    // MARK: Health and send support

    func maxRowID() throws -> Int64 {
        try db.read { conn, _ in try conn.scalarInt("SELECT MAX(ROWID) FROM message") ?? 0 }
    }

    func newestMessageDate() throws -> Date? {
        try db.read { conn, _ in
            try conn.scalarInt("SELECT date FROM message WHERE ROWID = (SELECT MAX(ROWID) FROM message)")
                .flatMap(AppleTime.date(fromChatDB:))
        }
    }

    /// Addresses this Mac's Messages accounts send from: `chat.account_login`, outgoing
    /// `message.account` and `destination_caller_id`. Prefixes like `E:`/`p:` are stripped and
    /// values canonicalized for comparison with the compiled self-handle list.
    func ownAccountAddresses() throws -> Set<String> {
        try db.read { conn, caps in
            var raw: [String] = []
            if caps.chatColumns.contains("account_login") {
                raw += try conn.query("SELECT DISTINCT account_login FROM chat WHERE account_login IS NOT NULL") { $0.text(0) ?? "" }
            }
            if caps.messageColumns.contains("account") {
                raw += try conn.query("SELECT DISTINCT account FROM message WHERE is_from_me = 1 AND account IS NOT NULL") { $0.text(0) ?? "" }
            }
            if caps.messageColumns.contains("destination_caller_id") {
                raw += try conn.query("""
                    SELECT DISTINCT destination_caller_id FROM message
                    WHERE is_from_me = 1 AND destination_caller_id IS NOT NULL
                    """) { $0.text(0) ?? "" }
            }
            var out = Set<String>()
            for value in raw {
                var v = value
                if v.count > 2, v.dropFirst().first == ":", let p = v.first, "EePp".contains(p) {
                    v.removeFirst(2)
                }
                let canon = HandleCanonical.canonical(v)
                if !canon.isEmpty { out.insert(canon) }
            }
            return out
        }
    }

    /// Outgoing rows after `afterRowID`, for the send verifier.
    func sentRows(afterRowID: Int64, limit: Int) throws -> [SentRow] {
        try db.read { conn, caps in
            let sql = """
                SELECT m.ROWID, m.guid, \(caps.m("text")), \(caps.m("attributedBody")), c.chat_identifier, h.id,
                       \(caps.m("is_delivered")), \(caps.m("is_sent")), \(caps.m("error")),
                       \(caps.m("cache_has_attachments")), \(caps.m("balloon_bundle_id"))
                FROM message m
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                LEFT JOIN chat c ON c.ROWID = (SELECT j.chat_id FROM chat_message_join j
                                               WHERE j.message_id = m.ROWID ORDER BY j.chat_id LIMIT 1)
                WHERE m.ROWID > ? AND m.is_from_me = 1
                ORDER BY m.ROWID LIMIT ?
                """
            return try conn.query(sql, [.int(afterRowID), .int(Int64(limit))]) { r in
                SentRow(rowid: r.int(0), guid: r.text(1) ?? "",
                        text: MessageText.resolve(text: r.text(2), attributedBody: r.blob(3)).text,
                        chatIdentifier: nonEmpty(r.text(4)), handleID: nonEmpty(r.text(5)),
                        isDelivered: r.bool(6), isSent: r.bool(7), error: r.int(8),
                        hasAttachments: r.bool(9), balloonBundleID: nonEmpty(r.text(10)))
            }
        }
    }
}

private func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

/// Canonical handle form used only for allowlist/self-chat comparison (Node owns real
/// normalization): emails lowercased; phones reduced to an optional leading `+` and digits.
enum HandleCanonical {
    static func canonical(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["mailto:", "tel:", "sms:", "imessage:"] where s.lowercased().hasPrefix(prefix) {
            s = String(s.dropFirst(prefix.count))
        }
        if s.contains("@") {
            return s.lowercased()
        }
        let plus = s.hasPrefix("+")
        let digits = s.filter { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty else { return "" }
        let allowed = Set("+0123456789 ()-.\u{00A0}")
        guard s.allSatisfy({ allowed.contains($0) }) else { return "" }
        return (plus ? "+" : "") + digits
    }
}
