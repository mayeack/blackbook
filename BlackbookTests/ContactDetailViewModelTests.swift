import XCTest
import SwiftData
@testable import Blackbook

final class ContactDetailViewModelTests: XCTestCase {

    private var vm: ContactDetailViewModel!

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([Contact.self, Interaction.self, Note.self, Tag.self, Group.self, Location.self, ContactRelationship.self, Reminder.self, Activity.self, RejectedCalendarEvent.self])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    override func setUp() {
        super.setUp()
        vm = ContactDetailViewModel()
    }

    override func tearDown() {
        vm = nil
        super.tearDown()
    }

    // MARK: - filteredNotes

    func testFilteredNotesAllCategories() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let contact = Contact(firstName: "Test", lastName: "User")
        context.insert(contact)

        let older = Note(contact: contact, content: "Older note", category: .general)
        older.createdAt = Date(timeIntervalSinceNow: -3600)
        let newer = Note(contact: contact, content: "Newer note", category: .personal)
        newer.createdAt = Date(timeIntervalSinceNow: -60)
        let newest = Note(contact: contact, content: "Newest note", category: .professional)
        newest.createdAt = Date()

        context.insert(older)
        context.insert(newer)
        context.insert(newest)

        vm.selectedNoteCategory = nil
        let result = vm.filteredNotes(for: contact)

        XCTAssertEqual(result.count, 3)
        // Sorted descending by createdAt
        XCTAssertEqual(result[0].content, "Newest note")
        XCTAssertEqual(result[1].content, "Newer note")
        XCTAssertEqual(result[2].content, "Older note")
    }

    func testFilteredNotesByCategory() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let contact = Contact(firstName: "Test", lastName: "User")
        context.insert(contact)

        let general = Note(contact: contact, content: "General note", category: .general)
        let personal = Note(contact: contact, content: "Personal note", category: .personal)
        context.insert(general)
        context.insert(personal)

        vm.selectedNoteCategory = .personal
        let result = vm.filteredNotes(for: contact)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.content, "Personal note")
    }

    // MARK: - interactionStats

    func testInteractionStatsEmpty() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let contact = Contact(firstName: "Test", lastName: "User")
        context.insert(contact)

        let stats = vm.interactionStats(for: contact)

        XCTAssertEqual(stats.totalCount, 0)
        XCTAssertNil(stats.mostCommonType)
        XCTAssertEqual(stats.monthlyFrequency, 0)
    }

    func testInteractionStatsMostCommonType() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let contact = Contact(firstName: "Test", lastName: "User")
        context.insert(contact)

        // Add 3 calls and 1 email (all within 90 days so they count as recent too)
        for _ in 0..<3 {
            let interaction = Interaction(contact: contact, type: .call, date: Date(timeIntervalSinceNow: -86400))
            context.insert(interaction)
        }
        let emailInteraction = Interaction(contact: contact, type: .email, date: Date(timeIntervalSinceNow: -86400))
        context.insert(emailInteraction)

        let stats = vm.interactionStats(for: contact)

        XCTAssertEqual(stats.totalCount, 4)
        XCTAssertEqual(stats.mostCommonType, .call)
    }

    // MARK: - frequencyDescription

    func testFrequencyDescriptionVeryActive() {
        let stats = InteractionStats(totalCount: 30, mostCommonType: .call, monthlyFrequency: 10.0)
        XCTAssertEqual(stats.frequencyDescription, "Very Active")
    }

    func testFrequencyDescriptionLow() {
        let stats = InteractionStats(totalCount: 1, mostCommonType: .email, monthlyFrequency: 0.5)
        XCTAssertEqual(stats.frequencyDescription, "Low")
    }
}
