import Foundation

/// Tapback / associated-message metadata (`associated_message_type` != 0).
struct MsgAssoc: Equatable {
    let type: Int
    let targetGUID: String?
    let emoji: String?

    /// `p:0/GUID` and `bp:GUID` both point at GUID.
    static func targetGUID(from raw: String?) -> String? {
        guard var guid = raw, !guid.isEmpty else { return nil }
        if guid.hasPrefix("bp:") {
            guid.removeFirst(3)
        } else if guid.hasPrefix("p:"), let slash = guid.firstIndex(of: "/") {
            guid = String(guid[guid.index(after: slash)...])
        }
        return guid.isEmpty ? nil : guid
    }

    /// Emoji for standard tapbacks 2000-2005 (adds) and 3000-3005 (removes); 2006/3006 carry
    /// a custom emoji in `associated_message_emoji`; 2007/3007 are sticker tapbacks.
    static func emoji(type: Int, column: String?) -> String? {
        if let column, !column.isEmpty { return column }
        let base = (3000...3999).contains(type) ? type - 1000 : type
        switch base {
        case 2000: return "\u{2764}\u{FE0F}"
        case 2001: return "\u{1F44D}"
        case 2002: return "\u{1F44E}"
        case 2003: return "\u{1F602}"
        case 2004: return "\u{203C}\u{FE0F}"
        case 2005: return "\u{2753}"
        default: return nil
        }
    }

    var json: JSON {
        .object([("type", .num(type)), ("target_guid", .str(targetGUID)), ("emoji", .str(emoji))])
    }
}

struct MsgAttachment: Equatable {
    let mime: String?
    let uti: String?
    let name: String?
    let bytes: Int64
    let isSticker: Bool

    var json: JSON {
        .object([
            ("mime", .str(mime)), ("uti", .str(uti)), ("name", .str(name)),
            ("bytes", .int(bytes)), ("is_sticker", .bool(isSticker)),
        ])
    }
}

/// One chat.db message row in the collector v1 wire format (architecture.md §1a "Msg JSON fields").
struct Msg: Equatable {
    var rowid: Int64
    var guid: String
    var chatGUID: String?
    var chatStyle: Int64?
    var chatIdentifier: String?
    var chatDisplayName: String?
    var service: String?
    var senderHandle: String?
    var isFromMe: Bool
    var date: Date
    var dateEdited: Date?
    var dateRetracted: Date?
    var text: String?
    var textSource: TextSource
    var itemType: Int64
    var groupActionType: Int64
    var otherHandle: String?
    var groupTitle: String?
    var assoc: MsgAssoc?
    var replyToGUID: String?
    var threadOriginatorGUID: String?
    var balloonBundleID: String?
    var isSpam: Bool
    var isDelivered: Bool
    var error: Int64
    var attachments: [MsgAttachment]

    /// Keys and order are the contract; keep in sync with packages/shared collector v1 schema.
    var json: JSON {
        .object([
            ("rowid", .int(rowid)),
            ("guid", .string(guid)),
            ("chat_guid", .str(chatGUID)),
            ("chat_style", .num(chatStyle)),
            ("chat_identifier", .str(chatIdentifier)),
            ("chat_display_name", .str(chatDisplayName)),
            ("service", .str(service)),
            ("sender_handle", .str(senderHandle)),
            ("is_from_me", .bool(isFromMe)),
            ("date", .iso(date)),
            ("date_edited", .iso(dateEdited)),
            ("date_retracted", .iso(dateRetracted)),
            ("text", .str(text)),
            ("text_source", .string(textSource.rawValue)),
            ("item_type", .int(itemType)),
            ("group_action_type", .int(groupActionType)),
            ("other_handle", .str(otherHandle)),
            ("group_title", .str(groupTitle)),
            ("assoc", assoc?.json ?? .null),
            ("reply_to_guid", .str(replyToGUID)),
            ("thread_originator_guid", .str(threadOriginatorGUID)),
            ("balloon_bundle_id", .str(balloonBundleID)),
            ("is_spam", .bool(isSpam)),
            ("is_delivered", .bool(isDelivered)),
            ("error", .int(error)),
            ("attachments", .array(attachments.map(\.json))),
        ])
    }
}

/// `GET /v1/imessage/edited` item: a Msg plus the part indexes unsent with "Undo Send"
/// (`message_summary_info` plist key `rp`).
struct EditedMsg: Equatable {
    var msg: Msg
    var retractedParts: [Int]

    var json: JSON {
        guard case let .object(fields) = msg.json else { return msg.json }
        return .object(fields + [("retracted_parts", .array(retractedParts.map { .num($0) }))])
    }

    static func retractedParts(fromSummaryInfo data: Data?) -> [Int] {
        guard let data, !data.isEmpty,
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let rp = plist["rp"] as? [NSNumber] else { return [] }
        return rp.map(\.intValue).sorted()
    }
}

/// A page of rowid-ordered results.
struct RowPage<Item> {
    let items: [Item]
    /// Rowid of the last item, or the request's `after_rowid` when the page is empty.
    let nextAfterRowID: Int64
    let hasMore: Bool
    let maxRowID: Int64
}

struct ChatRow: Equatable {
    let rowid: Int64
    let guid: String
    let style: Int64?
    let identifier: String?
    let displayName: String?
    let service: String?
    let members: [String]
    let lastMessageAt: Date?

    var json: JSON {
        .object([
            ("chat_rowid", .int(rowid)),
            ("chat_guid", .string(guid)),
            ("style", .num(style)),
            ("chat_identifier", .str(identifier)),
            ("display_name", .str(displayName)),
            ("service", .str(service)),
            ("members", .array(members.map(JSON.string))),
            ("last_message_at", .iso(lastMessageAt)),
        ])
    }
}

struct HandleRow: Equatable {
    let rowid: Int64
    let id: String
    let service: String?

    var json: JSON {
        .object([("rowid", .int(rowid)), ("id", .string(id)), ("service", .str(service))])
    }
}

/// An outgoing row as seen by the send verifier.
struct SentRow: Equatable {
    let rowid: Int64
    let guid: String
    let text: String?
    let chatIdentifier: String?
    let handleID: String?
    let isDelivered: Bool
    let isSent: Bool
    let error: Int64
    let hasAttachments: Bool
    let balloonBundleID: String?
}
