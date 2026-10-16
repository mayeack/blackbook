import Foundation
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

/// A small synthetic world covering every row shape the collector must emit.
final class SyntheticWorld {
    let fx: ChatDBFixture
    var ids: [String: Int64] = [:]
    let dm, group, selfChat: Int64
    let alice, bob, carol, me: Int64

    static let urlBalloon = "com.apple.messages.URLBalloonProvider"

    init() throws {
        fx = try ChatDBFixture()
        alice = try fx.handle("+15555550101")
        bob = try fx.handle("+15555550102")
        carol = try fx.handle("carol@example.com")
        me = try fx.handle("+15555550100")
        let bobSMS = try fx.handle("+15555550102", service: "SMS")
        dm = try fx.chat(guid: "any;-;+15555550101", style: 45, identifier: "+15555550101",
                         accountLogin: "E:owner@example.com", members: [alice])
        group = try fx.chat(guid: "any;+;chat100200300", style: 43, identifier: "chat100200300",
                            displayName: "Trail Crew", accountLogin: "E:owner@example.com", members: [alice, bob, carol, bobSMS])
        selfChat = try fx.chat(guid: "any;-;+15555550100", style: 45, identifier: "+15555550100",
                               accountLogin: "P:+15555550100", members: [me])

        func t(_ minutes: Double) -> Date { refDate.addingTimeInterval(minutes * 60) }
        func add(_ key: String, _ spec: MessageSpec) throws { ids[key] = try fx.message(spec) }

        try add("plain", MessageSpec(guid: "G-PLAIN", text: "Hey, still on for Saturday?", handle: alice, date: t(0), chat: dm))
        try add("body_only", MessageSpec(guid: "G-BODY", body: AttributedBody.blob("Yes! 10am at the trailhead"),
                                         handle: alice, fromMe: true, date: t(1), chat: dm,
                                         account: "E:owner@example.com", destinationCallerID: "+15555550100"))
        try add("group_send", MessageSpec(guid: "G-GROUPSEND", body: AttributedBody.blob("I'll bring snacks"),
                                          handle: 0, fromMe: true, date: t(2), chat: group))
        try add("group_recv", MessageSpec(guid: "G-GROUPRECV", text: "Count me in", handle: bob, date: t(3), chat: group))
        try add("tapback_love", MessageSpec(guid: "G-TB1", text: "Loved “Count me in”", handle: carol, date: t(4), chat: group,
                                            assocType: 2000, assocGUID: "p:0/G-GROUPRECV"))
        try add("tapback_custom", MessageSpec(guid: "G-TB2", text: "Reacted 🔥 to “Count me in”", handle: alice, date: t(5),
                                              chat: group, assocType: 2006, assocGUID: "bp:G-GROUPRECV", assocEmoji: "🔥"))
        try add("tapback_remove", MessageSpec(guid: "G-TB3", text: "Removed a like", handle: bob, date: t(6), chat: group,
                                              assocType: 3001, assocGUID: "p:1/G-GROUPSEND"))
        try add("sticker_tapback", MessageSpec(guid: "G-TB4", handle: bob, date: t(6.5), chat: group,
                                               assocType: 2007, assocGUID: "p:0/G-GROUPSEND"))
        try add("edited", MessageSpec(guid: "G-EDIT", body: AttributedBody.blob("Actually 10:30"), handle: alice, date: t(7),
                                      chat: dm, dateEdited: t(30)))
        try add("url_text", MessageSpec(guid: "G-URL1", text: "https://example.com/plan", handle: alice, date: t(8), chat: dm))
        try add("url_balloon", MessageSpec(guid: "G-URL2", text: "https://example.com/plan", handle: alice, date: t(8.01),
                                           chat: dm, balloon: Self.urlBalloon))
        try add("added", MessageSpec(guid: "G-EV1", handle: bob, date: t(9), chat: group, itemType: 1, groupActionType: 0,
                                     otherHandle: carol))
        try add("removed", MessageSpec(guid: "G-EV2", handle: 0, fromMe: true, date: t(10), chat: group, itemType: 1,
                                       groupActionType: 1, otherHandle: bob))
        try add("left", MessageSpec(guid: "G-EV3", handle: carol, date: t(11), chat: group, itemType: 3, groupActionType: 0))
        try add("renamed", MessageSpec(guid: "G-EV4", handle: alice, date: t(12), chat: group, itemType: 2,
                                       groupTitle: "Trail Crew 2026"))
        try add("attachment", MessageSpec(guid: "G-ATT", body: AttributedBody.blob("\u{FFFC}"), handle: alice, date: t(13),
                                          chat: dm, attachments: [AttachmentSpec(), AttachmentSpec(mime: "image/png", uti: "public.png",
                                                                                                      name: "sticker.png", bytes: 999, sticker: true)]))
        try add("spam", MessageSpec(guid: "G-SPAM", text: "You won a prize", handle: bob, date: t(14), chat: dm, isSpam: true))
        try add("orphan", MessageSpec(guid: "G-ORPHAN", text: "no chat join", handle: alice, date: t(15)))
        try add("retracted", MessageSpec(guid: "G-UNSENT", handle: alice, date: t(16), chat: dm, dateRetracted: t(17)))
        try add("reply", MessageSpec(guid: "G-REPLY", text: "+1", handle: bob, date: t(18), chat: group,
                                     replyTo: "G-GROUPSEND", threadOriginator: "G-GROUPSEND"))
        try add("failed", MessageSpec(guid: "G-FAIL", text: "did not send", handle: alice, fromMe: true, date: t(19), chat: dm,
                                      isDelivered: false, error: 22))
        let summary = try PropertyListSerialization.data(fromPropertyList: ["rp": [1], "ep": [0]], format: .binary, options: 0)
        try add("unsent_part", MessageSpec(guid: "G-PARTUNSENT", body: AttributedBody.blob("first part kept"), handle: bob,
                                           date: t(19.5), chat: group, dateEdited: t(40), summaryInfo: summary))
        try add("note_to_self", MessageSpec(guid: "G-SELF", text: "remember the tent", handle: me, fromMe: true, date: t(20),
                                            chat: selfChat, account: "p:+15555550100", destinationCallerID: "+15555550100"))
    }

    var reader: MessageReader { MessageReader(db: ChatDB(path: fx.path)) }

    func all() throws -> [Msg] {
        try reader.messages(afterRowID: 0, limit: 1000).items
    }

    func msg(_ key: String) throws -> Msg {
        let id = try #require(ids[key])
        return try #require(try all().first { $0.rowid == id })
    }
}

@Suite("chat.db reader")
struct MessageReaderTests {
    @Test func plainAndAttributedBodyText() throws {
        let w = try SyntheticWorld()
        let plain = try w.msg("plain")
        #expect(plain.text == "Hey, still on for Saturday?")
        #expect(plain.textSource == .text)
        #expect(plain.senderHandle == "+15555550101")
        #expect(plain.isFromMe == false)
        #expect(plain.chatGUID == "any;-;+15555550101")
        #expect(plain.chatStyle == 45)
        #expect(plain.date == refDate)

        let body = try w.msg("body_only")
        #expect(body.text == "Yes! 10am at the trailhead")
        #expect(body.textSource == .attributedBody)
        #expect(body.isFromMe)
        #expect(body.senderHandle == nil, "sender is null when the message is mine")
    }

    @Test func groupSendsWithHandleZeroAreIncluded() throws {
        let w = try SyntheticWorld()
        let send = try w.msg("group_send")
        #expect(send.isFromMe)
        #expect(send.senderHandle == nil)
        #expect(send.chatGUID == "any;+;chat100200300")
        #expect(send.chatStyle == 43)
        #expect(send.chatDisplayName == "Trail Crew")
        #expect(send.text == "I'll bring snacks")
    }

    @Test func tapbacksCarryAssocWithStrippedTargets() throws {
        let w = try SyntheticWorld()
        let love = try w.msg("tapback_love")
        #expect(love.assoc == MsgAssoc(type: 2000, targetGUID: "G-GROUPRECV", emoji: "❤️"))
        let custom = try w.msg("tapback_custom")
        #expect(custom.assoc == MsgAssoc(type: 2006, targetGUID: "G-GROUPRECV", emoji: "🔥"))
        let removal = try w.msg("tapback_remove")
        #expect(removal.assoc == MsgAssoc(type: 3001, targetGUID: "G-GROUPSEND", emoji: "👍"))
        let sticker = try w.msg("sticker_tapback")
        #expect(sticker.assoc == MsgAssoc(type: 2007, targetGUID: "G-GROUPSEND", emoji: nil))
        #expect(try w.msg("plain").assoc == nil)
    }

    @Test("every tapback type 2000-2007 and 3000-3007 maps to an assoc", arguments: Array(2000...2007) + Array(3000...3007))
    func allTapbackTypes(_ type: Int) throws {
        let fx = try ChatDBFixture()
        let h = try fx.handle("+15555550103")
        let c = try fx.chat(guid: "any;-;+15555550103", style: 45, identifier: "+15555550103", members: [h])
        try fx.message(MessageSpec(guid: "TARGET", text: "target", handle: h, chat: c))
        try fx.message(MessageSpec(guid: "TB", text: "reaction", handle: h, chat: c, assocType: type, assocGUID: "p:0/TARGET",
                                   assocEmoji: type % 1000 == 6 ? "🎉" : nil))
        let items = try MessageReader(db: ChatDB(path: fx.path)).messages(afterRowID: 0, limit: 10).items
        let tb = try #require(items.last)
        #expect(tb.assoc?.type == type)
        #expect(tb.assoc?.targetGUID == "TARGET")
        if type % 1000 <= 5 { #expect(tb.assoc?.emoji != nil) }
        if type % 1000 == 6 { #expect(tb.assoc?.emoji == "🎉") }
        if type % 1000 == 7 { #expect(tb.assoc?.emoji == nil) }
    }

    @Test func groupEvents() throws {
        let w = try SyntheticWorld()
        let added = try w.msg("added")
        #expect((added.itemType, added.groupActionType) == (1, 0))
        #expect(added.otherHandle == "carol@example.com")
        let removed = try w.msg("removed")
        #expect((removed.itemType, removed.groupActionType) == (1, 1))
        #expect(removed.otherHandle == "+15555550102")
        #expect(removed.isFromMe)
        let left = try w.msg("left")
        #expect((left.itemType, left.groupActionType) == (3, 0))
        #expect(left.otherHandle == nil)
        let renamed = try w.msg("renamed")
        #expect(renamed.itemType == 2)
        #expect(renamed.groupTitle == "Trail Crew 2026")
    }

    @Test func urlBalloonDuplicatesAreReportedForNodeToMerge() throws {
        let w = try SyntheticWorld()
        let text = try w.msg("url_text")
        let balloon = try w.msg("url_balloon")
        #expect(text.balloonBundleID == nil)
        #expect(balloon.balloonBundleID == SyntheticWorld.urlBalloon)
        #expect(text.text == balloon.text)
    }

    @Test func attachmentsSpamOrphansRetractionsReplies() throws {
        let w = try SyntheticWorld()
        let att = try w.msg("attachment")
        #expect(att.text == nil)
        #expect(att.textSource == .none)
        #expect(att.attachments == [
            MsgAttachment(mime: "image/jpeg", uti: "public.jpeg", name: "IMG_0001.jpeg", bytes: 12345, isSticker: false),
            MsgAttachment(mime: "image/png", uti: "public.png", name: "sticker.png", bytes: 999, isSticker: true),
        ])
        #expect(try w.msg("spam").isSpam)
        let orphan = try w.msg("orphan")
        #expect(orphan.chatGUID == nil)
        #expect(orphan.chatStyle == nil)
        let unsent = try w.msg("retracted")
        #expect(unsent.dateRetracted == refDate.addingTimeInterval(17 * 60))
        #expect(unsent.textSource == .none)
        let reply = try w.msg("reply")
        #expect(reply.replyToGUID == "G-GROUPSEND")
        #expect(reply.threadOriginatorGUID == "G-GROUPSEND")
        let failed = try w.msg("failed")
        #expect(failed.error == 22)
        #expect(failed.isDelivered == false)
    }

    @Test func paginationEdges() throws {
        let w = try SyntheticWorld()
        let reader = w.reader
        let total = try reader.messages(afterRowID: 0, limit: 1000)
        #expect(total.hasMore == false)
        #expect(total.maxRowID == total.items.last?.rowid)

        var seen: [Int64] = []
        var after: Int64 = 0
        var pages = 0
        while true {
            let page = try reader.messages(afterRowID: after, limit: 5)
            pages += 1
            #expect(page.items.count <= 5)
            #expect(page.items.allSatisfy { $0.rowid > after })
            seen += page.items.map(\.rowid)
            after = page.nextAfterRowID
            if !page.hasMore { break }
        }
        #expect(seen == total.items.map(\.rowid))
        #expect(pages == (total.items.count + 4) / 5)

        let empty = try reader.messages(afterRowID: total.maxRowID, limit: 5)
        #expect(empty.items.isEmpty)
        #expect(empty.hasMore == false)
        #expect(empty.nextAfterRowID == total.maxRowID)

        let exact = try reader.messages(afterRowID: 0, limit: total.items.count)
        #expect(exact.hasMore == false)
    }

    @Test func chatFilterDateWindowAndEdits() throws {
        let w = try SyntheticWorld()
        let reader = w.reader
        let group = try reader.messages(afterRowID: 0, limit: 100, chatGUID: "any;+;chat100200300").items
        #expect(!group.isEmpty)
        #expect(group.allSatisfy { $0.chatGUID == "any;+;chat100200300" })

        let window = try reader.messages(since: refDate.addingTimeInterval(60), until: refDate.addingTimeInterval(4 * 60),
                                         afterRowID: 0, limit: 100).items
        #expect(window.map(\.guid) == ["G-BODY", "G-GROUPSEND", "G-GROUPRECV"])

        let edited = try reader.edited(since: refDate.addingTimeInterval(10 * 60), afterRowID: 0, limit: 100).items
        #expect(Set(edited.map(\.msg.guid)) == ["G-EDIT", "G-UNSENT", "G-PARTUNSENT"])
        #expect(edited.first { $0.msg.guid == "G-EDIT" }?.msg.dateEdited == refDate.addingTimeInterval(30 * 60))
        #expect(edited.first { $0.msg.guid == "G-EDIT" }?.retractedParts == [])
        #expect(edited.first { $0.msg.guid == "G-PARTUNSENT" }?.retractedParts == [1])
        #expect(edited.first { $0.msg.guid == "G-PARTUNSENT" }?.json["retracted_parts"] == .array([.int(1)]))
        let late = try reader.edited(since: refDate.addingTimeInterval(31 * 60), afterRowID: 0, limit: 100).items
        #expect(late.map(\.msg.guid) == ["G-PARTUNSENT"])
        #expect(EditedMsg.retractedParts(fromSummaryInfo: Data("not a plist".utf8)) == [])
    }

    @Test func chatsAndHandles() throws {
        let w = try SyntheticWorld()
        let chats = try w.reader.chats(afterRowID: 0, limit: 2)
        #expect(chats.items.count == 2)
        #expect(chats.hasMore)
        let group = try #require(chats.items.first { $0.style == 43 })
        #expect(group.members == ["+15555550101", "+15555550102", "carol@example.com"])
        #expect(group.displayName == "Trail Crew")
        #expect(group.lastMessageAt == refDate.addingTimeInterval(19.5 * 60))
        let rest = try w.reader.chats(afterRowID: chats.nextAfterRowID, limit: 2)
        #expect(rest.items.count == 1)
        #expect(rest.hasMore == false)

        let handles = try w.reader.handles()
        #expect(handles.map(\.id) == ["+15555550101", "+15555550102", "carol@example.com", "+15555550100", "+15555550102"])
        #expect(handles.last?.service == "SMS")
    }

    @Test func persistentReadOnlyConnectionSeesNewWALCommits() throws {
        let w = try SyntheticWorld()
        let reader = w.reader
        let before = try reader.maxRowID()
        let id = try w.fx.message(MessageSpec(guid: "G-LATE", text: "late arrival", handle: w.alice, chat: w.dm))
        #expect(id == before + 1)
        #expect(try reader.maxRowID() == id)
        #expect(try reader.messages(afterRowID: before, limit: 10).items.map(\.guid) == ["G-LATE"])
    }

    @Test func ownAccountAddressesStripPrefixes() throws {
        let w = try SyntheticWorld()
        #expect(try w.reader.ownAccountAddresses() == ["owner@example.com", "+15555550100"])
    }

    @Test func missingDatabaseMapsToChatdbUnavailable() {
        let reader = MessageReader(db: ChatDB(path: "/nonexistent/\(UUID().uuidString)/chat.db"))
        #expect(throws: ChatDBError.self) { try reader.messages(afterRowID: 0, limit: 1) }
        if case .failure(.notFound) = reader.db.probe() {} else { Issue.record("expected notFound") }
        #expect(APIError.from(.notFound).code == "chatdb_unavailable")
        #expect(APIError.from(.accessDenied).code == "fda_missing")
    }
}
