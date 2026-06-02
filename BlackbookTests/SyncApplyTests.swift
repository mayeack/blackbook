import XCTest
import SwiftData
@testable import Blackbook

/// Tests for the sync **apply / conflict-resolution** layer — the pure functions
/// `ContactSyncApply.applyRemoteContact` and `ModelSyncApply.applyRemoteInteraction`.
///
/// This is the exact code surface behind the 2026-06-02 sync incidents (drift in #44, crash in
/// #43) and previously had **zero** unit coverage. These tests need no network or protocol seam:
/// the apply functions take a `[String: Any]` payload + a `ModelContext`. "Remote" payloads are
/// built with the real `contactToDict` / `interactionToDict` serializers so timestamp formatting
/// matches the parser exactly (`ISO8601DateFormatter`, whole-second precision — timestamps in
/// these tests are deliberately ≥1s apart).
///
/// Network-path integration (URLSession injection into `LocalServerSyncService`) remains a
/// further step; see docs/CODE_REVIEW_2026-06-02.md finding #6.
@MainActor
final class SyncApplyTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    private let t1 = Date(timeIntervalSince1970: 1_000_000) // older
    private let t2 = Date(timeIntervalSince1970: 1_000_500) // newer (+500s)

    override func setUpWithError() throws {
        container = try TestHelpers.makeContainer()
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    // MARK: - Builders

    /// A detached Contact serialized to a remote payload. Not inserted into `context`.
    private func remoteContactDict(
        id: UUID,
        first: String,
        last: String = "X",
        updatedAt: Date,
        isPriority: Bool = false,
        emails: [String] = []
    ) -> [String: Any] {
        let tmp = Contact(firstName: first, lastName: last)
        tmp.id = id
        tmp.updatedAt = updatedAt
        tmp.isPriority = isPriority
        tmp.emails = emails
        return ContactSyncApply.contactToDict(tmp)
    }

    private func fetchContact(_ id: UUID) throws -> Contact? {
        try context.fetch(FetchDescriptor<Contact>(predicate: #Predicate { $0.id == id })).first
    }

    private func fetchInteraction(_ id: UUID) throws -> Interaction? {
        try context.fetch(FetchDescriptor<Interaction>(predicate: #Predicate { $0.id == id })).first
    }

    @discardableResult
    private func insertLocalContact(
        id: UUID = UUID(),
        first: String,
        updatedAt: Date,
        status: SyncStatus,
        isPriority: Bool = false
    ) -> Contact {
        let c = Contact(firstName: first, lastName: "X")
        c.id = id
        c.updatedAt = updatedAt
        c.syncStatus = status.rawValue
        c.isPriority = isPriority
        context.insert(c)
        return c
    }

    // MARK: - applyRemoteContact: insert path

    func testRemoteContactInsertedWhenAbsent() throws {
        let id = UUID()
        let dict = remoteContactDict(id: id, first: "Ada", updatedAt: t2, isPriority: true, emails: ["ada@x.com"])
        try ContactSyncApply.applyRemoteContact(dict, to: context)

        let c = try XCTUnwrap(try fetchContact(id))
        XCTAssertEqual(c.firstName, "Ada")
        XCTAssertTrue(c.isPriority)
        XCTAssertEqual(c.emails, ["ada@x.com"])
        XCTAssertEqual(c.syncStatus, SyncStatus.synced.rawValue, "inserted remote record is marked synced")
    }

    func testRoundTripPreservesCoreFields() throws {
        let source = Contact(firstName: "Grace", lastName: "Hopper")
        source.id = UUID()
        source.updatedAt = t2
        source.emails = ["grace@navy.mil"]
        source.phones = ["5550100"]
        source.relationshipScore = 73
        source.isPriority = true
        let dict = ContactSyncApply.contactToDict(source)

        try ContactSyncApply.applyRemoteContact(dict, to: context)

        let c = try XCTUnwrap(try fetchContact(source.id))
        XCTAssertEqual(c.firstName, "Grace")
        XCTAssertEqual(c.lastName, "Hopper")
        XCTAssertEqual(c.emails, ["grace@navy.mil"])
        XCTAssertEqual(c.phones, ["5550100"])
        XCTAssertEqual(c.relationshipScore, 73, accuracy: 0.0001)
        XCTAssertTrue(c.isPriority)
    }

    // MARK: - applyRemoteContact: conflict resolution

    func testRemoteNewerOverwritesLocal() throws {
        let id = UUID()
        let local = insertLocalContact(id: id, first: "OldName", updatedAt: t1, status: .synced)
        try context.save()

        let dict = remoteContactDict(id: id, first: "NewName", updatedAt: t2, isPriority: true)
        try ContactSyncApply.applyRemoteContact(dict, to: context)

        XCTAssertEqual(local.firstName, "NewName", "newer remote should win")
        XCTAssertTrue(local.isPriority)
        XCTAssertEqual(local.syncStatus, SyncStatus.synced.rawValue)
    }

    func testLocalNewerAndPendingIsProtectedFromStaleRemote() throws {
        // The key guard: an unsynced local edit that is NEWER than the incoming remote must NOT be
        // clobbered. This is what keeps a fresh local edit from being lost on the next pull.
        let id = UUID()
        let local = insertLocalContact(id: id, first: "LocalEdit", updatedAt: t2, status: .pending, isPriority: true)
        try context.save()

        let dict = remoteContactDict(id: id, first: "StaleRemote", updatedAt: t1, isPriority: false)
        try ContactSyncApply.applyRemoteContact(dict, to: context)

        XCTAssertEqual(local.firstName, "LocalEdit", "newer pending local edit must survive")
        XCTAssertTrue(local.isPriority)
        XCTAssertEqual(local.syncStatus, SyncStatus.pending.rawValue, "still pending — not marked synced")
    }

    func testLocalNewerButSyncedIsOverwrittenByStaleRemote() throws {
        // Documents the subtle (and historically dangerous) branch: when local is NEWER but already
        // marked `.synced`, the guard `local.syncStatus != .synced` is false, so the older remote is
        // applied anyway. This is precisely why edits must flip syncStatus to `.pending`
        // (markLocallyEdited) — a "synced but newer" record is treated as stale and clobbered.
        // Regression guard for the #44 drift class.
        let id = UUID()
        let local = insertLocalContact(id: id, first: "NewerButSynced", updatedAt: t2, status: .synced, isPriority: true)
        try context.save()

        let dict = remoteContactDict(id: id, first: "OlderRemote", updatedAt: t1, isPriority: false)
        try ContactSyncApply.applyRemoteContact(dict, to: context)

        XCTAssertEqual(local.firstName, "OlderRemote",
                       "a 'synced' local is treated as not-locally-edited and yields to remote")
        XCTAssertFalse(local.isPriority)
    }

    // MARK: - applyRemoteContact: malformed payloads

    func testMissingIdIsIgnored() throws {
        var dict = remoteContactDict(id: UUID(), first: "NoId", updatedAt: t2)
        dict.removeValue(forKey: "id")
        XCTAssertNoThrow(try ContactSyncApply.applyRemoteContact(dict, to: context))
        XCTAssertEqual(try context.fetch(FetchDescriptor<Contact>()).count, 0)
    }

    func testMissingUpdatedAtIsIgnored() throws {
        var dict = remoteContactDict(id: UUID(), first: "NoTimestamp", updatedAt: t2)
        dict.removeValue(forKey: "updatedAt")
        XCTAssertNoThrow(try ContactSyncApply.applyRemoteContact(dict, to: context))
        XCTAssertEqual(try context.fetch(FetchDescriptor<Contact>()).count, 0)
    }

    func testIdempotentReapplyIsNoOp() throws {
        let id = UUID()
        let dict = remoteContactDict(id: id, first: "Once", updatedAt: t2)
        try ContactSyncApply.applyRemoteContact(dict, to: context)
        try ContactSyncApply.applyRemoteContact(dict, to: context) // re-apply same payload
        XCTAssertEqual(try context.fetch(FetchDescriptor<Contact>()).count, 1, "UUID upsert must not duplicate")
    }

    // MARK: - applyRemoteInteraction

    func testRemoteInteractionLinksToExistingContact() throws {
        let contact = TestHelpers.makeContact(firstName: "Linked", in: context)
        try context.save()

        let interactionId = UUID()
        let tmp = Interaction(contact: contact, type: .text, date: t1)
        tmp.id = interactionId
        tmp.updatedAt = t2
        tmp.summary = "hello"
        let dict = ModelSyncApply.interactionToDict(tmp)

        try ModelSyncApply.applyRemoteInteraction(dict, to: context)

        let saved = try XCTUnwrap(try fetchInteraction(interactionId))
        XCTAssertEqual(saved.contact?.id, contact.id, "interaction should link to the resolved contact")
        XCTAssertEqual(saved.summary, "hello")
        XCTAssertEqual(saved.type, .text)
    }

    func testRemoteInteractionWithUnknownContactIsInsertedWithNilContact() throws {
        // A child record whose contactId isn't present locally must still persist (contact = nil),
        // not crash or get dropped — it heals when the contact arrives on a later pull.
        let interactionId = UUID()
        let tmp = Interaction(contact: Contact(firstName: "Ghost", lastName: "X"), type: .call, date: t1)
        tmp.id = interactionId
        tmp.updatedAt = t2
        var dict = ModelSyncApply.interactionToDict(tmp)
        dict["contactId"] = UUID().uuidString // a contact id that doesn't exist in this context

        try ModelSyncApply.applyRemoteInteraction(dict, to: context)

        let saved = try XCTUnwrap(try fetchInteraction(interactionId))
        XCTAssertNil(saved.contact, "unresolved contact id yields a nil-contact interaction, not a crash")
    }

    func testRemoteInteractionConflictGuardProtectsNewerPendingLocal() throws {
        let contact = TestHelpers.makeContact(firstName: "C", in: context)
        let local = Interaction(contact: contact, type: .text, date: t1)
        local.id = UUID()
        local.summary = "local-newer"
        local.updatedAt = t2
        local.syncStatus = SyncStatus.pending.rawValue
        context.insert(local)
        try context.save()

        let stale = Interaction(contact: contact, type: .text, date: t1)
        stale.id = local.id
        stale.summary = "stale-remote"
        stale.updatedAt = t1
        let dict = ModelSyncApply.interactionToDict(stale)

        try ModelSyncApply.applyRemoteInteraction(dict, to: context)

        XCTAssertEqual(local.summary, "local-newer", "newer pending local interaction must survive a stale remote")
    }
}
