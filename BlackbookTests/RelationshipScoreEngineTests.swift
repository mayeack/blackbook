import XCTest
import SwiftData
@testable import Blackbook

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
        context = ModelContext(container)
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

    private func addActivity(to contact: Contact, date: Date = Date()) {
        let activity = Activity(name: "Event", date: date)
        context.insert(activity)
        contact.activities.append(activity)
    }

    // MARK: - 1. Zero Interactions

    func testZeroInteractionsScore() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        try context.save()

        let score = engine.calculateScore(for: contact)

        // No interactions, not priority: recency=0, frequency=0, variety=0, sentiment=50 (default)
        // Expected: 0.35*0 + 0.30*0 + 0.15*0 + 0.20*50 + 0 + 0 = 10
        XCTAssertEqual(score, 10.0, accuracy: 1.0, "Zero-interaction non-priority contact should have a low score")
    }

    // MARK: - 2. Recent Interaction High Recency

    func testRecentInteractionHighRecency() throws {
        let contact = makeContact()
        addInteraction(to: contact, date: Date())
        try context.save()

        let score = engine.calculateScore(for: contact)

        // recency: 100 * pow(0.5, 0/14) = 100
        // recencyContribution = 0.35 * 100 = 35
        XCTAssertGreaterThan(score, 30.0, "Contact with interaction today should have high recency contribution")
    }

    // MARK: - 3. Old Interaction Low Recency

    func testOldInteractionLowRecency() throws {
        let contact = makeContact()
        let sixtyDaysAgo = Calendar.current.date(byAdding: .day, value: -60, to: Date())!
        addInteraction(to: contact, date: sixtyDaysAgo)
        try context.save()

        let score = engine.calculateScore(for: contact)

        // recency: 100 * pow(0.5, 60/14) ~ 100 * 0.054 ~ 5.4
        // recencyContribution = 0.35 * 5.4 ~ 1.9
        XCTAssertLessThan(score, 25.0, "Contact with interaction 60 days ago should have low recency")
    }

    // MARK: - 4. Frequency Score With Multiple Interactions

    func testFrequencyScoreWithMultipleInteractions() throws {
        let contact = makeContact()
        for i in 0..<6 {
            let date = Calendar.current.date(byAdding: .day, value: -i * 10, to: Date())!
            addInteraction(to: contact, type: .call, date: date)
        }
        try context.save()

        let score = engine.calculateScore(for: contact)

        // frequency: min(100, 6/3 * 12.5) = min(100, 25) = 25
        // frequencyContribution = 0.30 * 25 = 7.5
        XCTAssertGreaterThan(score, 15.0, "Contact with 6 interactions in 90 days should have meaningful frequency contribution")
    }

    // MARK: - 5. Frequency Score Zero Interactions

    func testFrequencyScoreZeroInteractions() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        try context.save()

        let score = engine.calculateScore(for: contact)

        // frequency: min(100, 0/3 * 12.5) = 0
        // Only sentiment default (50) contributes: 0.20 * 50 = 10
        XCTAssertLessThanOrEqual(score, 15.0, "Contact with zero interactions should have minimal score")
    }

    // MARK: - 6. Variety Score All Types

    func testVarietyScoreAllTypes() throws {
        let contact = makeContact()
        for type in InteractionType.allCases {
            addInteraction(to: contact, type: type, date: Date())
        }
        try context.save()

        let score = engine.calculateScore(for: contact)

        // variety: (6/6) * 100 = 100
        // varietyContribution = 0.15 * 100 = 15
        XCTAssertGreaterThan(score, 50.0, "Contact with all 6 interaction types should have high variety contribution")
    }

    // MARK: - 7. Variety Score Single Type

    func testVarietyScoreSingleType() throws {
        let contact = makeContact()
        addInteraction(to: contact, type: .call, date: Date())
        try context.save()

        let score = engine.calculateScore(for: contact)

        // variety: (1/6) * 100 ~ 16.67
        // varietyContribution = 0.15 * 16.67 ~ 2.5
        let allTypesContact = makeContact(firstName: "AllTypes")
        for type in InteractionType.allCases {
            addInteraction(to: allTypesContact, type: type, date: Date())
        }
        try context.save()

        let singleTypeScore = engine.calculateScore(for: contact)
        let allTypesScore = engine.calculateScore(for: allTypesContact)
        XCTAssertLessThan(singleTypeScore, allTypesScore, "Single type variety should score lower than all types")
    }

    // MARK: - 8. Sentiment All Positive

    func testSentimentAllPositive() throws {
        let contact = makeContact()
        for i in 0..<5 {
            let date = Calendar.current.date(byAdding: .day, value: -i, to: Date())!
            addInteraction(to: contact, type: .call, date: date, sentiment: .positive)
        }
        try context.save()

        let score = engine.calculateScore(for: contact)

        // sentiment: all positive weights = 1.0, so sentimentScore = 100
        // sentimentContribution = 0.20 * 100 = 20
        XCTAssertGreaterThan(score, 40.0, "All-positive sentiment should yield high sentiment contribution")
    }

    // MARK: - 9. Sentiment All Negative

    func testSentimentAllNegative() throws {
        let contact = makeContact()
        for i in 0..<5 {
            let date = Calendar.current.date(byAdding: .day, value: -i, to: Date())!
            addInteraction(to: contact, type: .call, date: date, sentiment: .negative)
        }
        try context.save()

        let score = engine.calculateScore(for: contact)

        // sentiment: all negative weights = 0.0, so sentimentScore = 0
        // sentimentContribution = 0.20 * 0 = 0
        let positiveContact = makeContact(firstName: "Positive")
        for i in 0..<5 {
            let date = Calendar.current.date(byAdding: .day, value: -i, to: Date())!
            addInteraction(to: positiveContact, type: .call, date: date, sentiment: .positive)
        }
        try context.save()

        let negativeScore = engine.calculateScore(for: contact)
        let positiveScore = engine.calculateScore(for: positiveContact)
        XCTAssertLessThan(negativeScore, positiveScore, "All-negative sentiment should score lower than all-positive")
    }

    // MARK: - 10. Sentiment Mixed

    func testSentimentMixed() throws {
        let contact = makeContact()
        let today = Date()
        addInteraction(to: contact, type: .call, date: today, sentiment: .positive)
        addInteraction(to: contact, type: .meeting, date: Calendar.current.date(byAdding: .day, value: -1, to: today)!, sentiment: .negative)
        addInteraction(to: contact, type: .text, date: Calendar.current.date(byAdding: .day, value: -2, to: today)!, sentiment: .neutral)
        try context.save()

        let score = engine.calculateScore(for: contact)

        // Mixed sentiment should produce a middle-range sentiment contribution
        // Between all-positive and all-negative
        XCTAssertGreaterThan(score, 0.0)
        XCTAssertLessThan(score, 100.0)
    }

    // MARK: - 11. Sentiment Default (No Sentiment Data)

    func testSentimentDefault() throws {
        let contact = makeContact()
        addInteraction(to: contact, type: .call, date: Date(), sentiment: nil)
        try context.save()

        let scoreWithNilSentiment = engine.calculateScore(for: contact)

        // When no sentiment data: sentimentScore defaults to 50
        // sentimentContribution = 0.20 * 50 = 10
        // Compare with a contact that has explicit positive sentiment
        let positiveContact = makeContact(firstName: "Pos")
        addInteraction(to: positiveContact, type: .call, date: Date(), sentiment: .positive)
        try context.save()

        let positiveScore = engine.calculateScore(for: positiveContact)
        XCTAssertLessThan(scoreWithNilSentiment, positiveScore, "Default sentiment (50) should produce lower contribution than positive (100)")
    }

    // MARK: - 12. Priority Boost

    func testPriorityBoost() throws {
        let normalContact = makeContact(firstName: "Normal", isPriority: false)
        addInteraction(to: normalContact, type: .call, date: Date())

        let priorityContact = makeContact(firstName: "Priority", isPriority: true)
        addInteraction(to: priorityContact, type: .call, date: Date())

        try context.save()

        let normalScore = engine.calculateScore(for: normalContact)
        let priorityScore = engine.calculateScore(for: priorityContact)

        XCTAssertEqual(priorityScore - normalScore, AppConstants.Scoring.priorityBoost, accuracy: 0.01, "Priority boost should add exactly \(AppConstants.Scoring.priorityBoost) points")
    }

    // MARK: - 13. Score Clamped to Max 100

    func testScoreClampedToMax100() throws {
        let contact = makeContact(isPriority: true)
        // Add many recent interactions of all types with positive sentiment to maximize score
        for type in InteractionType.allCases {
            for i in 0..<5 {
                let date = Calendar.current.date(byAdding: .day, value: -i, to: Date())!
                addInteraction(to: contact, type: type, date: date, sentiment: .positive)
            }
        }
        // Add activities to max out activity boost
        for i in 0..<10 {
            let date = Calendar.current.date(byAdding: .day, value: -i, to: Date())!
            addActivity(to: contact, date: date)
        }
        try context.save()

        let score = engine.calculateScore(for: contact)

        XCTAssertLessThanOrEqual(score, 100.0, "Score should never exceed 100")
    }

    // MARK: - 14. Score Clamped to Min 0

    func testScoreClampedToMin0() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        contact.isPriority = false
        try context.save()

        let score = engine.calculateScore(for: contact)

        XCTAssertGreaterThanOrEqual(score, 0.0, "Score should never go below 0")
    }

    // MARK: - 15. Score With No Data (Brand New Contact)

    func testScoreWithNoData() throws {
        let contact = makeContact()
        contact.lastInteractionDate = nil
        try context.save()

        let score = engine.calculateScore(for: contact)

        // Brand new: recency=0, frequency=0, variety=0, sentiment=50 (default), no priority, no activity
        // Expected: 0 + 0 + 0 + 0.20*50 + 0 + 0 = 10
        XCTAssertGreaterThanOrEqual(score, 0.0)
        XCTAssertLessThanOrEqual(score, 15.0, "Brand new contact with no data should have a low score from default sentiment only")
    }
}
