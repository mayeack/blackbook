import XCTest
import SwiftData
@testable import Blackbook

final class DashboardViewModelTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private let viewModel = DashboardViewModel()

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

    private func makeContact(
        firstName: String = "Test",
        lastName: String = "User",
        score: Double = 50.0,
        isPriority: Bool = false
    ) -> Contact {
        let contact = Contact(firstName: firstName, lastName: lastName)
        contact.relationshipScore = score
        contact.isPriority = isPriority
        context.insert(contact)
        return contact
    }

    private func addInteraction(to contact: Contact, date: Date = Date(), type: InteractionType = .call) {
        let interaction = Interaction(contact: contact, type: type, date: date)
        context.insert(interaction)
    }

    // MARK: - 1. Fading Contacts Filters Low Scores

    func testFadingContactsFiltersLowScores() throws {
        let fading1 = makeContact(firstName: "Fading1", score: 15.0)
        let fading2 = makeContact(firstName: "Fading2", score: 25.0)
        _ = makeContact(firstName: "Strong", score: 80.0)
        _ = makeContact(firstName: "Moderate", score: 50.0)
        try context.save()

        let contacts = [fading1, fading2, makeContact(firstName: "Strong2", score: 80.0), makeContact(firstName: "Mod2", score: 50.0)]
        try context.save()

        let allContacts = try context.fetch(FetchDescriptor<Contact>())
        let fading = viewModel.fadingContacts(from: allContacts)

        let fadingIDs = Set(fading.map(\.id))
        XCTAssertTrue(fadingIDs.contains(fading1.id), "Contact with score 15 should be fading")
        XCTAssertTrue(fadingIDs.contains(fading2.id), "Contact with score 25 should be fading")

        for contact in fading {
            XCTAssertLessThan(contact.relationshipScore, AppConstants.Scoring.fadingThreshold, "All fading contacts should have score < \(AppConstants.Scoring.fadingThreshold)")
            XCTAssertGreaterThan(contact.relationshipScore, 0, "All fading contacts should have score > 0")
        }
    }

    // MARK: - 2. Fading Contacts Excludes Zero Score

    func testFadingContactsExcludesZeroScore() throws {
        let zeroContact = makeContact(firstName: "Zero", score: 0.0)
        let fadingContact = makeContact(firstName: "Fading", score: 20.0)
        try context.save()

        let fading = viewModel.fadingContacts(from: [zeroContact, fadingContact])

        let fadingIDs = Set(fading.map(\.id))
        XCTAssertFalse(fadingIDs.contains(zeroContact.id), "Contact with score 0 should not be in fading list")
        XCTAssertTrue(fadingIDs.contains(fadingContact.id), "Contact with score 20 should be in fading list")
    }

    // MARK: - 3. Fading Contacts Limit

    func testFadingContactsLimit() throws {
        var contacts: [Contact] = []
        for i in 1...10 {
            let contact = makeContact(firstName: "Fading\(i)", score: Double(i * 2))
            contacts.append(contact)
        }
        try context.save()

        let fading = viewModel.fadingContacts(from: contacts, limit: 3)

        XCTAssertEqual(fading.count, 3, "Fading contacts should respect the limit parameter")
    }

    // MARK: - 4. Prioritized Contacts

    func testPrioritizedContacts() throws {
        let priority1 = makeContact(firstName: "Alice", isPriority: true)
        let priority2 = makeContact(firstName: "Bob", isPriority: true)
        let normal = makeContact(firstName: "Charlie", isPriority: false)
        try context.save()

        let prioritized = viewModel.prioritizedContacts(from: [priority1, priority2, normal])

        XCTAssertEqual(prioritized.count, 2, "Only priority contacts should be returned")
        let ids = Set(prioritized.map(\.id))
        XCTAssertTrue(ids.contains(priority1.id))
        XCTAssertTrue(ids.contains(priority2.id))
        XCTAssertFalse(ids.contains(normal.id), "Non-priority contact should not be included")
    }

    // MARK: - 5. Top Contacts Sorted by Score Descending

    func testTopContacts() throws {
        let low = makeContact(firstName: "Low", score: 20.0)
        let mid = makeContact(firstName: "Mid", score: 50.0)
        let high = makeContact(firstName: "High", score: 90.0)
        let veryHigh = makeContact(firstName: "VeryHigh", score: 95.0)
        try context.save()

        let top = viewModel.topContacts(from: [low, mid, high, veryHigh], limit: 3)

        XCTAssertEqual(top.count, 3, "Should return at most 'limit' contacts")
        XCTAssertEqual(top[0].id, veryHigh.id, "First contact should have highest score")
        XCTAssertEqual(top[1].id, high.id, "Second contact should have second highest score")
        XCTAssertEqual(top[2].id, mid.id, "Third contact should have third highest score")
    }

    // MARK: - 6. Weekly Stats

    func testWeeklyStats() throws {
        let contact1 = makeContact(firstName: "Alice")
        let contact2 = makeContact(firstName: "Bob")

        // Add interactions this week
        addInteraction(to: contact1, date: Date(), type: .call)
        addInteraction(to: contact1, date: Date(), type: .meeting)
        addInteraction(to: contact2, date: Date(), type: .text)

        // Add an interaction from last month (should not count)
        let lastMonth = Calendar.current.date(byAdding: .month, value: -1, to: Date())!
        addInteraction(to: contact1, date: lastMonth, type: .email)

        try context.save()

        let stats = viewModel.computeWeeklyStats(context: context)

        XCTAssertEqual(stats.totalInteractions, 3, "Should count only this week's interactions")
        XCTAssertEqual(stats.uniqueContacts, 2, "Should count 2 unique contacts with interactions this week")
    }

    // MARK: - 7. Weekly Stats Empty Contacts

    func testWeeklyStatsEmptyContacts() throws {
        let stats = viewModel.computeWeeklyStats(context: context)

        XCTAssertEqual(stats.totalInteractions, 0, "Empty contacts should yield 0 total interactions")
        XCTAssertEqual(stats.uniqueContacts, 0, "Empty contacts should yield 0 unique contacts")
    }
}
