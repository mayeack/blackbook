import XCTest
import SwiftData
@testable import Blackbook

final class ContactModelTests: XCTestCase {

    // MARK: - Enum tests (no container needed)

    func testScoreCategoryRawValues() {
        XCTAssertEqual(ScoreCategory.strong.rawValue, "Strong")
        XCTAssertEqual(ScoreCategory.moderate.rawValue, "Moderate")
        XCTAssertEqual(ScoreCategory.fading.rawValue, "Fading")
        XCTAssertEqual(ScoreCategory.dormant.rawValue, "Dormant")
    }

    func testScoreTrendRawValues() {
        XCTAssertEqual(ScoreTrend.up.rawValue, "up")
        XCTAssertEqual(ScoreTrend.down.rawValue, "down")
        XCTAssertEqual(ScoreTrend.stable.rawValue, "stable")
    }

    // MARK: - ModelContainer tests

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([
            Contact.self,
            Interaction.self,
            Note.self,
            Tag.self,
            Group.self,
            Location.self,
            ContactRelationship.self,
            Reminder.self,
            Activity.self,
            RejectedCalendarEvent.self
        ])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    @MainActor
    private func makeContact(
        firstName: String = "John",
        lastName: String = "Doe",
        in container: ModelContainer
    ) -> Contact {
        let context = container.mainContext
        let contact = Contact(firstName: firstName, lastName: lastName)
        context.insert(contact)
        return contact
    }

    // MARK: - displayName

    @MainActor
    func testDisplayNameBothNames() throws {
        let container = try makeContainer()
        let contact = makeContact(firstName: "John", lastName: "Doe", in: container)
        XCTAssertEqual(contact.displayName, "John Doe")
    }

    @MainActor
    func testDisplayNameFirstOnly() throws {
        let container = try makeContainer()
        let contact = makeContact(firstName: "John", lastName: "", in: container)
        XCTAssertEqual(contact.displayName, "John")
    }

    @MainActor
    func testDisplayNameEmpty() throws {
        let container = try makeContainer()
        let contact = makeContact(firstName: "", lastName: "", in: container)
        XCTAssertEqual(contact.displayName, "Unknown")
    }

    // MARK: - initials

    @MainActor
    func testInitialsBothNames() throws {
        let container = try makeContainer()
        let contact = makeContact(firstName: "John", lastName: "Doe", in: container)
        XCTAssertEqual(contact.initials, "JD")
    }

    @MainActor
    func testInitialsEmpty() throws {
        let container = try makeContainer()
        let contact = makeContact(firstName: "", lastName: "", in: container)
        XCTAssertEqual(contact.initials, "?")
    }

    // MARK: - scoreCategory

    @MainActor
    func testScoreCategoryStrong() throws {
        let container = try makeContainer()
        let contact = makeContact(in: container)
        contact.relationshipScore = 70
        XCTAssertEqual(contact.scoreCategory, .strong)
    }

    @MainActor
    func testScoreCategoryModerate() throws {
        let container = try makeContainer()
        let contact = makeContact(in: container)
        contact.relationshipScore = 40
        XCTAssertEqual(contact.scoreCategory, .moderate)
    }

    @MainActor
    func testScoreCategoryFading() throws {
        let container = try makeContainer()
        let contact = makeContact(in: container)
        contact.relationshipScore = 10
        XCTAssertEqual(contact.scoreCategory, .fading)
    }

    @MainActor
    func testScoreCategoryDormant() throws {
        let container = try makeContainer()
        let contact = makeContact(in: container)
        contact.relationshipScore = 5
        XCTAssertEqual(contact.scoreCategory, .dormant)
    }

    // MARK: - Default values

    @MainActor
    func testDefaultValues() throws {
        let container = try makeContainer()
        let contact = makeContact(in: container)
        XCTAssertEqual(contact.relationshipScore, 50.0, accuracy: 0.001)
        XCTAssertFalse(contact.isPriority)
        XCTAssertFalse(contact.isHidden)
        XCTAssertFalse(contact.isMergedAway)
    }
}
