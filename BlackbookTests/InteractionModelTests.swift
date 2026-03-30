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
}
