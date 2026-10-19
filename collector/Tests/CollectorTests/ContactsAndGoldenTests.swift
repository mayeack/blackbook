import Foundation
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

@Suite("contacts payload")
struct ContactsTests {
    static let sampleCards: [ContactCard] = {
        var b = ContactCard(id: "B-0002", given: "Jordan", family: "Example", nickname: "Jo", org: "Acme Rentals", job: "Guide")
        b.phones = [LabeledValue(label: "mobile", value: "(555) 555-0102")]
        b.emails = [LabeledValue(label: "home", value: "jordan@example.com")]
        b.postal = [PostalItem(label: "home", street: "1 Sample St", city: "Springfield", state: "CA", postalCode: "90000",
                               country: "United States", isoCountryCode: "US")]
        b.birthday = (y: nil, m: 7, d: 4)
        b.social = [SocialItem(service: "Instagram", username: "jordan.example", url: nil)]
        b.urls = [LabeledValue(label: "homepage", value: "https://example.com/jordan")]
        var a = ContactCard(id: "A-0001", given: "Avery", family: "Sample")
        a.phones = [LabeledValue(label: nil, value: "+15555550101")]
        a.birthday = (y: 1990, m: 1, d: 31)
        return [b, a]
    }()

    @Test func sortedByIdWithStableHash() {
        let p1 = ContactsExport.payload(Self.sampleCards)
        let p2 = ContactsExport.payload(Self.sampleCards.reversed())
        #expect(p1.hash == p2.hash)
        #expect(p1.items.first?["id"] == .string("A-0001"))
        var changed = Self.sampleCards
        changed[0].job = "Lead Guide"
        #expect(ContactsExport.payload(changed).hash != p1.hash)
    }

    @Test func birthdayYearIsOptionalAndSocialUsesService() {
        let b = Self.sampleCards[0].json
        #expect(b["birthday"] == .object([("m", .int(7)), ("d", .int(4))]))
        #expect(b["social"] == .array([.object([("service", .string("Instagram")), ("username", .string("jordan.example")), ("url", .null)])]))
    }
}

/// Golden wire samples for the TypeScript zod contract (packages/shared collector v1). Built
/// only from synthetic data. Regenerate with `YB_UPDATE_GOLDEN=1`; any drift fails here.
@Suite("collector v1 golden contract")
struct GoldenContractTests {
    @Test func listRoutes() throws {
        let h = try APIHarness()
        for (name, target) in [
            ("imessage-messages", "/v1/imessage/messages?after_rowid=0&limit=1000"),
            ("imessage-messages-page", "/v1/imessage/messages?after_rowid=0&limit=3"),
            ("imessage-chats", "/v1/imessage/chats?after_rowid=0"),
            ("imessage-edited", "/v1/imessage/edited?since=2026-10-01T12:10:00.000Z"),
            ("imessage-messages-by-date", "/v1/imessage/messages/by-date?since=2026-10-01T12:01:00.000Z&until=2026-10-01T12:04:00.000Z"),
            ("imessage-handles", "/v1/imessage/handles"),
            ("health", "/v1/health"),
        ] {
            let r = h.reply(target)
            #expect(r.status == 200, "\(name)")
            #expect(try checkGolden(name, r.body), "golden drift: \(name)")
        }
    }

    @Test func objectRoutesAndErrors() throws {
        let h = try APIHarness()
        h.contacts.cards = ContactsTests.sampleCards
        #expect(try checkGolden("contacts", h.reply("/v1/contacts").body))

        let send = SendResult(status: .delivered, messageGUIDs: ["SENT-GUID-1", "SENT-GUID-2"], rowIDs: [9001, 9002], errorCode: nil)
        #expect(try checkGolden("imessage-send", Self.wrap(send.json)))
        let failed = SendResult(status: .failed, messageGUIDs: [], rowIDs: [], errorCode: "automation_denied")
        #expect(try checkGolden("imessage-send-failed", Self.wrap(failed.json)))

        // Fixed bytes (a real encode differs across macOS versions); the route test covers the actual JPEG.
        let image = AttachmentImage(data: Data([0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xD9]), width: 4, height: 3)
        #expect(try checkGolden("imessage-attachment", Self.wrap(.object(image.fields))))

        let dir = "/Users/owner/Library/Application Support/Yeackbot/snapshots/whatsapp/20261001T120000.000Z"
        let files: [String: String?] = ["chat": "\(dir)/ChatStorage.sqlite", "contacts": "\(dir)/ContactsV2.sqlite", "lid": nil]
        let snapshot = WhatsAppSnapshotResult(
            unchanged: false, snapshotDir: dir, files: files,
            sourceMtime: refDate, maxPK: 4242, bytes: 1_048_576)
        #expect(try checkGolden("whatsapp-snapshot", Self.wrap(snapshot.json)))

        let refused = h.api.evaluate(h.loopbackRequest("POST", "/v1/imessage/send",
            body: Data("{\"to\":\"+15555550101\",\"text\":\"🅨 hi\",\"client_ref\":\"6f9619ff-8b86-d011-b42d-00c04fc964ff\"}".utf8)))
        #expect(refused.status == 403)
        #expect(try checkGolden("error-recipient-not-allowed", refused.body))
    }

    private static func wrap(_ value: JSON) -> JSON {
        guard case let .object(fields) = value else { return value }
        return .object([("api", .string("v1")), ("generated_at", .iso(refDate))] + fields)
    }
}
