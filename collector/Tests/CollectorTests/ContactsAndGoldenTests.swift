import Contacts
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
        a.createdAt = ISOTime.parse("2026-03-03T18:04:05.250Z")
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

    @Test func createdAtIsOnTheWireButOutsideTheHash() throws {
        let p = ContactsExport.payload(Self.sampleCards)
        #expect(p.items.first?["created_at"] == .string("2026-03-03T18:04:05.250Z"))
        #expect(p.items.last?["created_at"] == .null, "unknown creation date is an explicit null")
        var undated = Self.sampleCards
        undated[1].createdAt = nil
        var moved = Self.sampleCards
        moved[0].createdAt = refDate
        #expect(ContactsExport.payload(undated).hash == p.hash)
        #expect(ContactsExport.payload(moved).hash == p.hash)
        #expect(undated[1] != Self.sampleCards[1], "equality still sees created_at")
    }

    @Test func systemCardCarriesTheCreationDate() {
        let contact = CNMutableContact()
        contact.givenName = "Robin"
        contact.familyName = "Example"
        let created = ISOTime.parse("2025-06-01T09:30:00.000Z")!
        let card = SystemContactsSource.card(from: contact, createdAt: created)
        #expect(card.id == contact.identifier)
        #expect(card.json["created_at"] == .string("2025-06-01T09:30:00.000Z"))
        #expect(SystemContactsSource.card(from: contact).json["created_at"] == .null)
    }

    @Test func contactsRouteEmitsCreatedAt() throws {
        let h = try APIHarness()
        h.contacts.cards = Self.sampleCards
        let items = APIHarness.json(h.request("/v1/contacts"))["items"] as? [[String: Any]] ?? []
        #expect(items.first?["created_at"] as? String == "2026-03-03T18:04:05.250Z")
        #expect(items.last?["created_at"] is NSNull)
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

        // Fixed lines through the real route and envelope (a fake recognizer: real recognition varies across macOS
        // versions; the route tests cover actual Vision output).
        let recognizer = FakeRecognizer()
        recognizer.result = OCRResult(width: 1179, height: 2556, lines: [
            OCRLine(text: "Ada Example", confidence: 1, x: 0.2104, y: 0.1187, w: 0.5791, h: 0.0213),
            OCRLine(text: "+1 212 555 0142", confidence: 0.5, x: 0.0712, y: 0.2484, w: 0.4402, h: 0.0151),
            OCRLine(text: "ada@example.com", confidence: 0.3, x: 0.0712, y: 0.2873, w: 0.3896, h: 0.0151),
        ])
        let oh = try APIHarness(ocr: recognizer)
        let ocr = oh.api.evaluate(oh.loopbackRequest("POST", "/v1/vision/ocr",
            body: Data("{\"data_base64\":\"\(Data("synthetic".utf8).base64EncodedString())\"}".utf8)))
        #expect(ocr.status == 200)
        #expect(try checkGolden("vision-ocr", ocr.body))
        let unreadable = h.api.evaluate(h.loopbackRequest("POST", "/v1/vision/ocr",
            body: Data("{\"data_base64\":\"\(Data("not an image".utf8).base64EncodedString())\"}".utf8)))
        #expect(unreadable.status == 422)
        #expect(try checkGolden("error-image-unreadable", unreadable.body))
    }

    private static func wrap(_ value: JSON) -> JSON {
        guard case let .object(fields) = value else { return value }
        return .object([("api", .string("v1")), ("generated_at", .iso(refDate))] + fields)
    }
}
