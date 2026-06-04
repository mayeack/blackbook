import XCTest
import SwiftData
@testable import Blackbook

/// Tests for `ContactSuggestionEngine` — the per-field "3 suggested records" ranking used by the
/// Introduced-to / Met-via pickers. Suggestions are ranked by contextual similarity (shared tags,
/// groups, locations) and fall back to relationship score so suggestions are always available.
@MainActor
final class ContactSuggestionEngineTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    override func setUpWithError() throws {
        container = try TestHelpers.makeContainer()
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    @discardableResult
    private func contact(_ first: String, score: Double = 0, hidden: Bool = false) -> Contact {
        let c = TestHelpers.makeContact(firstName: first, lastName: "X", score: score, isHidden: hidden, in: context)
        return c
    }

    private func tag(_ name: String) -> Tag { let t = Tag(name: name); context.insert(t); return t }
    private func group(_ name: String) -> Group { let g = Group(name: name); context.insert(g); return g }

    func testRanksBySharedTagsAndGroups() {
        let subject = contact("Subject")
        let climbing = tag("Climbing")
        let work = group("Work")
        subject.tags = [climbing]
        subject.groups = [work]

        let strong = contact("Strong")      // shares tag (×3) + group (×2) = 5
        strong.tags = [climbing]; strong.groups = [work]
        let weak = contact("Weak")          // shares group only (×2) = 2
        weak.groups = [work]
        let none = contact("None", score: 99) // no overlap; high score but should rank last

        let result = ContactSuggestionEngine.suggestions(for: subject, field: .introducedTo, from: [strong, weak, none])

        XCTAssertEqual(result.map(\.firstName), ["Strong", "Weak", "None"])
    }

    func testExcludesSubjectHiddenAndExcludedIDs() {
        let subject = contact("Subject")
        let hidden = contact("Hidden", hidden: true)
        let excluded = contact("Excluded")
        let ok = contact("Ok")

        let result = ContactSuggestionEngine.suggestions(
            for: subject, field: .introducedTo,
            from: [subject, hidden, excluded, ok],
            excluding: [excluded.id]
        )

        XCTAssertEqual(result.map(\.firstName), ["Ok"])
        XCTAssertFalse(result.contains { $0.id == subject.id })
        XCTAssertFalse(result.contains { $0.isHidden })
    }

    func testAlwaysReturnsUpToThreeWithScoreFallback() {
        let subject = contact("Subject") // no tags/groups → no similarity for anyone
        let a = contact("A", score: 10)
        let b = contact("B", score: 90)
        let c = contact("C", score: 50)
        let d = contact("D", score: 70)

        let result = ContactSuggestionEngine.suggestions(for: subject, field: .metVia, from: [a, b, c, d])

        // With zero overlap, falls back to highest relationship score, capped at 3.
        XCTAssertEqual(result.map(\.firstName), ["B", "D", "C"])
    }
}
