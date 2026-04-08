import XCTest
@testable import Blackbook

final class InteractionModelTests: XCTestCase {

    // MARK: - InteractionType

    func testInteractionTypeRawValues() {
        XCTAssertEqual(InteractionType.call.rawValue, "Call")
        XCTAssertEqual(InteractionType.meeting.rawValue, "Meeting")
        XCTAssertEqual(InteractionType.text.rawValue, "Text")
        XCTAssertEqual(InteractionType.email.rawValue, "Email")
        XCTAssertEqual(InteractionType.social.rawValue, "Social")
        XCTAssertEqual(InteractionType.other.rawValue, "Other")
    }

    func testInteractionTypeAllCasesCount() {
        XCTAssertEqual(InteractionType.allCases.count, 6)
    }

    func testInteractionTypeIconsAreNonEmpty() {
        for type in InteractionType.allCases {
            XCTAssertFalse(type.icon.isEmpty, "\(type.rawValue) should have a non-empty icon")
        }
    }

    // MARK: - Sentiment

    func testSentimentRawValues() {
        XCTAssertEqual(Sentiment.positive.rawValue, "Positive")
        XCTAssertEqual(Sentiment.neutral.rawValue, "Neutral")
        XCTAssertEqual(Sentiment.negative.rawValue, "Negative")
    }

    func testSentimentWeights() {
        XCTAssertEqual(Sentiment.positive.weight, 1.0, accuracy: 0.001)
        XCTAssertEqual(Sentiment.neutral.weight, 0.5, accuracy: 0.001)
        XCTAssertEqual(Sentiment.negative.weight, 0.0, accuracy: 0.001)
    }

    func testSentimentAllCasesCount() {
        XCTAssertEqual(Sentiment.allCases.count, 3)
    }

    // MARK: - Additional Interaction Tests

    @MainActor
    func testInteractionTypeAllCases() throws {
        let allCases = InteractionType.allCases
        XCTAssertGreaterThanOrEqual(allCases.count, 6, "Should have at least 6 interaction types")
    }

    @MainActor
    func testSentimentAllCases() throws {
        let allCases = Sentiment.allCases
        XCTAssertGreaterThanOrEqual(allCases.count, 3, "Should have at least 3 sentiment values")
    }

    @MainActor
    func testInteractionContactRelationship() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext
        let contact = TestHelpers.makeContact(in: context)
        let interaction = TestHelpers.makeInteraction(contact: contact, in: context)
        try context.save()

        XCTAssertEqual(interaction.contact?.id, contact.id, "Interaction should be linked to the correct contact")
        XCTAssertTrue(contact.interactions.contains(where: { $0.id == interaction.id }), "Contact should contain the interaction")
    }
}
