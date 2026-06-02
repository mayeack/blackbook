import XCTest
import SwiftData
@testable import Blackbook

/// Tests for `ContactDeduplicationService` — the union-find duplicate detector that auto-merges
/// contacts. This service is safety-critical (it mutates the contact graph via
/// `ContactMergeService`) and was previously untested. These tests exercise the pure `findGroups`
/// scan and the `mergeAll` mutation path.
@MainActor
final class ContactDeduplicationServiceTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private let dedup = ContactDeduplicationService()
    private let merger = ContactMergeService()

    override func setUpWithError() throws {
        container = try TestHelpers.makeContainer()
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    // MARK: - Helpers

    @discardableResult
    private func makeContact(
        _ first: String,
        _ last: String,
        emails: [String] = [],
        phones: [String] = []
    ) -> Contact {
        let c = Contact(firstName: first, lastName: last)
        c.emails = emails
        c.phones = phones
        context.insert(c)
        return c
    }

    // MARK: - findGroups: negative cases

    func testNoContactsYieldsNoGroups() throws {
        XCTAssertTrue(try dedup.findGroups(in: context).isEmpty)
    }

    func testSingleContactYieldsNoGroups() throws {
        makeContact("Ada", "Lovelace", emails: ["ada@x.com"])
        try context.save()
        XCTAssertTrue(try dedup.findGroups(in: context).isEmpty)
    }

    func testDistinctContactsAreNotGrouped() throws {
        makeContact("Ada", "Lovelace", emails: ["ada@x.com"], phones: ["111-111-1111"])
        makeContact("Alan", "Turing", emails: ["alan@x.com"], phones: ["222-222-2222"])
        try context.save()
        XCTAssertTrue(try dedup.findGroups(in: context).isEmpty)
    }

    // MARK: - findGroups: linking by each key

    func testLinkBySameName() throws {
        // nameKey folds case and diacritics (but does NOT trim per-component whitespace —
        // see testNameKeyDoesNotTrimInnerWhitespace below).
        makeContact("José", "García")
        makeContact("JOSE", "garcia")
        try context.save()
        let groups = try dedup.findGroups(in: context)
        XCTAssertEqual(groups.count, 1)
        guard groups.count == 1 else { return }
        XCTAssertEqual(groups[0].duplicates.count, 1)
        XCTAssertTrue(groups[0].matchReason.contains("Same name"))
    }

    /// Documents a known limitation: `ContactSyncService.nameKey` trims only the *combined*
    /// string's outer whitespace, not each component, so a stray inner space prevents a name
    /// match. Captured as a regression guard; see review report for the proposed hardening.
    func testNameKeyDoesNotTrimInnerWhitespace() throws {
        makeContact("Grace", "Hopper")
        makeContact("Grace", " Hopper") // leading space on last name → different key today
        try context.save()
        XCTAssertTrue(try dedup.findGroups(in: context).isEmpty,
                      "current behavior: inner whitespace is not normalized away")
    }

    func testLinkBySharedEmailDespiteDifferentNames() throws {
        makeContact("Robert", "Smith", emails: ["shared@x.com"])
        makeContact("Bob", "Smithe", emails: ["SHARED@x.com"]) // case-insensitive email match
        try context.save()
        let groups = try dedup.findGroups(in: context)
        XCTAssertEqual(groups.count, 1)
        XCTAssertTrue(groups[0].matchReason.contains("Shared email"))
    }

    func testLinkBySharedPhoneIgnoresFormatting() throws {
        makeContact("Jenny", "A", phones: ["(415) 867-5309"])
        makeContact("Jen", "B", phones: ["4158675309"]) // formatting stripped to same digits
        try context.save()
        let groups = try dedup.findGroups(in: context)
        XCTAssertEqual(groups.count, 1)
        XCTAssertTrue(groups[0].matchReason.contains("Shared phone"))
    }

    func testEmptyNameKeyDoesNotLink() throws {
        // Two contacts with blank names must NOT be grouped on an empty name key.
        makeContact("", "", emails: ["a@x.com"])
        makeContact("", "", emails: ["b@x.com"])
        try context.save()
        XCTAssertTrue(try dedup.findGroups(in: context).isEmpty)
    }

    // MARK: - findGroups: transitive union-find correctness

    func testTransitiveLinkingFormsSingleComponent() throws {
        // A~B by name, B~C by email, C~D by phone → all four collapse into one group.
        let a = makeContact("Sam", "Vimes")
        let b = makeContact("Sam", "Vimes", emails: ["sv@watch.gov"])
        let c = makeContact("Samuel", "V", emails: ["sv@watch.gov"], phones: ["555-0100"])
        let d = makeContact("S", "Vimes2", phones: ["5550100"])
        _ = (a, b, c, d)
        try context.save()
        let groups = try dedup.findGroups(in: context)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].duplicates.count + 1, 4, "all four contacts should be one component")
    }

    func testTwoSeparateDuplicatePairsYieldTwoGroups() throws {
        makeContact("Pair", "One")
        makeContact("Pair", "One")
        makeContact("Pair", "Two")
        makeContact("Pair", "Two")
        try context.save()
        let groups = try dedup.findGroups(in: context)
        XCTAssertEqual(groups.count, 2)
        XCTAssertTrue(groups.allSatisfy { $0.duplicates.count == 1 })
    }

    // MARK: - findGroups: exclusions & primary selection

    func testMergedAwayContactsAreExcludedFromScan() throws {
        makeContact("Dup", "Erson")
        let gone = makeContact("Dup", "Erson")
        gone.isMergedAway = true
        try context.save()
        // Only one live contact with that name remains → no group.
        XCTAssertTrue(try dedup.findGroups(in: context).isEmpty)
    }

    func testPrimaryIsRichestContact() throws {
        let sparse = makeContact("Rich", "Card")
        let rich = makeContact("Rich", "Card")
        // Give `rich` more data so its dataRichness wins.
        TestHelpers.makeInteraction(contact: rich, in: context)
        TestHelpers.makeInteraction(contact: rich, in: context)
        TestHelpers.makeNote(contact: rich, in: context)
        rich.emails = ["rich@x.com"]
        try context.save()
        let groups = try dedup.findGroups(in: context)
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].primary.id, rich.id, "the data-richer contact must be primary")
        XCTAssertEqual(groups[0].duplicates.first?.id, sparse.id)
    }

    // MARK: - mergeAll mutation path

    func testMergeAllSuppressesSecondariesAndReturnsCount() throws {
        let keep = makeContact("Merge", "Target")
        TestHelpers.makeNote(contact: keep, in: context) // make `keep` the richer primary
        let dupe = makeContact("Merge", "Target")
        try context.save()

        let merged = try dedup.mergeAll(using: merger, in: context)

        XCTAssertEqual(merged, 1)
        XCTAssertEqual(dedup.lastMergeCount, 1)
        XCTAssertEqual(dedup.lastGroupCount, 1)
        XCTAssertTrue(dupe.isMergedAway, "secondary should be suppressed, not deleted")
        XCTAssertEqual(dupe.mergedIntoContact?.id, keep.id)
        // A second pass finds nothing because the duplicate is now merged away.
        XCTAssertTrue(try dedup.findGroups(in: context).isEmpty)
    }

    func testMergeAllOnCleanStoreIsNoOp() throws {
        makeContact("Solo", "Contact", emails: ["solo@x.com"])
        try context.save()
        let merged = try dedup.mergeAll(using: merger, in: context)
        XCTAssertEqual(merged, 0)
        XCTAssertEqual(dedup.lastGroupCount, 0)
    }
}
