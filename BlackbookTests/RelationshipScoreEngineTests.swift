import XCTest
import SwiftData
@testable import Blackbook

@MainActor
final class RelationshipScoreEngineTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private let engine = RelationshipScoreEngine()

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([Contact.self, Interaction.self, Note.self, Tag.self, Group.self, Location.self, ContactRelationship.self, Reminder.self, Activity.self, RejectedCalendarEvent.self])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    override func setUpWithError() throws {
        container = try makeContainer()
        context = container.mainContext
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    // MARK: - Helpers

    private func makeContact(firstName: String = "Test", lastName: String = "User", isPriority: Bool = false) -> Contact {
        let contact = Contact(firstName: firstName, lastName: lastName)
        contact.isPriority = isPriority
        contact.relationshipScore = 0
        context.insert(contact)
        return contact
    }

    private func addInteraction(
        to contact: Contact,
        type: InteractionType = .call,
        date: Date = Date(),
        sentiment: Sentiment? = nil
    ) {
        let interaction = Interaction(contact: contact, type: type, date: date, sentiment: sentiment)
        context.insert(interaction)
        contact.lastInteractionDate = max(contact.lastInteractionDate ?? .distantPast, date)
    }

    /// Recalculates all scores and returns the score for the given contact.
    private func recalculateAndGetScore(for contact: Contact) -> Double {
        engine.recalculateAll(context: context)
        return contact.relationshipScore
    }

    // MARK: - 1. Zero Interactions

    func testZeroInteractionsScore() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        try context.save()

        let score = recalculateAndGetScore(for: contact)

        // No interactions, not priority: recency=0, no boost
        // Expected: 0
        XCTAssertLessThanOrEqual(score, 5.0, "Zero-interaction non-priority contact should have a very low score")
    }

    // MARK: - 2. Recent Interaction High Recency

    func testRecentInteractionHighRecency() throws {
        let contact = makeContact()
        addInteraction(to: contact, date: Date())
        try context.save()

        let score = recalculateAndGetScore(for: contact)

        // recency: 100 * pow(0.5, 0/14) = 100
        XCTAssertGreaterThan(score, 90.0, "Contact with interaction today should have high recency score (~100)")
    }

    // MARK: - 3. Old Interaction Low Recency

    func testOldInteractionLowRecency() throws {
        let contact = makeContact()
        let sixtyDaysAgo = Calendar.current.date(byAdding: .day, value: -60, to: Date())!
        addInteraction(to: contact, date: sixtyDaysAgo)
        try context.save()

        let score = recalculateAndGetScore(for: contact)

        // recency: 100 * pow(0.5, 60/14) ~ 5.4
        XCTAssertLessThan(score, 15.0, "Contact with interaction 60 days ago should have low score")
    }

    // MARK: - 4. Multiple Interactions Use Most Recent

    func testMultipleInteractionsUseMostRecent() throws {
        let contact = makeContact()
        let thirtyDaysAgo = Calendar.current.date(byAdding: .day, value: -30, to: Date())!
        addInteraction(to: contact, type: .call, date: thirtyDaysAgo)
        addInteraction(to: contact, type: .meeting, date: Date())
        try context.save()

        let score = recalculateAndGetScore(for: contact)

        // lastInteractionDate should be today, so score should be high
        XCTAssertGreaterThan(score, 90.0, "Score should use most recent interaction date")
    }

    // MARK: - 5. Priority Boost

    func testPriorityBoost() throws {
        // Use interactions from 14 days ago so base score is ~50, leaving room for the priority boost
        let fourteenDaysAgo = Calendar.current.date(byAdding: .day, value: -14, to: Date())!

        let normalContact = makeContact(firstName: "Normal", isPriority: false)
        addInteraction(to: normalContact, type: .call, date: fourteenDaysAgo)

        let priorityContact = makeContact(firstName: "Priority", isPriority: true)
        addInteraction(to: priorityContact, type: .call, date: fourteenDaysAgo)

        try context.save()

        engine.recalculateAll(context: context)

        let normalScore = normalContact.relationshipScore
        let priorityScore = priorityContact.relationshipScore

        XCTAssertEqual(priorityScore - normalScore, AppConstants.Scoring.priorityBoost, accuracy: 1.0, "Priority boost should add \(AppConstants.Scoring.priorityBoost) points")
    }

    // MARK: - 6. Score Clamped to Max 100

    func testScoreClampedToMax100() throws {
        let contact = makeContact(isPriority: true)
        // Interaction today: base recency = 100, plus priority boost = 120 → clamped to 100
        addInteraction(to: contact, type: .call, date: Date())
        try context.save()

        let score = recalculateAndGetScore(for: contact)

        XCTAssertLessThanOrEqual(score, 100.0, "Score should never exceed 100")
    }

    // MARK: - 7. Score Clamped to Min 0

    func testScoreClampedToMin0() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        contact.isPriority = false
        try context.save()

        let score = recalculateAndGetScore(for: contact)

        XCTAssertGreaterThanOrEqual(score, 0.0, "Score should never go below 0")
    }

    // MARK: - 8. Trend Up For Recent Interaction

    func testTrendUpForRecentInteraction() throws {
        let contact = makeContact()
        addInteraction(to: contact, date: Date())
        try context.save()

        engine.recalculateAll(context: context)

        XCTAssertEqual(contact.scoreTrend, .up, "Contact with interaction today should have upward trend")
    }

    // MARK: - 9. Trend Stable For Mid-Recent Interaction

    func testTrendStableForMidRecentInteraction() throws {
        let contact = makeContact()
        let tenDaysAgo = Calendar.current.date(byAdding: .day, value: -10, to: Date())!
        addInteraction(to: contact, date: tenDaysAgo)
        try context.save()

        engine.recalculateAll(context: context)

        XCTAssertEqual(contact.scoreTrend, .stable, "Contact with interaction 10 days ago should have stable trend")
    }

    // MARK: - 10. Trend Down For Old Interaction

    func testTrendDownForOldInteraction() throws {
        let contact = makeContact()
        let thirtyDaysAgo = Calendar.current.date(byAdding: .day, value: -30, to: Date())!
        addInteraction(to: contact, date: thirtyDaysAgo)
        try context.save()

        engine.recalculateAll(context: context)

        XCTAssertEqual(contact.scoreTrend, .down, "Contact with interaction 30 days ago should have downward trend")
    }

    // MARK: - 11. Trend Stable With No Interactions

    func testTrendStableWithNoInteractions() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        try context.save()

        engine.recalculateAll(context: context)

        XCTAssertEqual(contact.scoreTrend, .stable, "Contact with no interactions should have stable trend")
    }

    // MARK: - 12. Score With No Data (Brand New Contact)

    func testScoreWithNoData() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        try context.save()

        let score = recalculateAndGetScore(for: contact)

        XCTAssertGreaterThanOrEqual(score, 0.0)
        XCTAssertLessThanOrEqual(score, 5.0, "Brand new contact with no data should have ~0 score")
    }

    // MARK: - 13. Recalculate All Updates Multiple Contacts

    func testRecalculateAllUpdatesMultipleContacts() throws {
        let contact1 = makeContact(firstName: "Recent")
        addInteraction(to: contact1, date: Date())

        let contact2 = makeContact(firstName: "Old")
        let sixtyDaysAgo = Calendar.current.date(byAdding: .day, value: -60, to: Date())!
        addInteraction(to: contact2, date: sixtyDaysAgo)

        let contact3 = makeContact(firstName: "None")
        contact3.lastInteractionDate = nil

        try context.save()

        engine.recalculateAll(context: context)

        XCTAssertGreaterThan(contact1.relationshipScore, contact2.relationshipScore, "Recent contact should score higher than old")
        XCTAssertGreaterThan(contact2.relationshipScore, contact3.relationshipScore, "Old contact should score higher than no-interaction")
    }
}
