import XCTest
import SwiftData
@testable import Blackbook

final class InteractionViewModelTests: XCTestCase {

    private var vm: InteractionViewModel!

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([Contact.self, Interaction.self, Note.self, Tag.self, Group.self, Location.self, ContactRelationship.self, Reminder.self, Activity.self, RejectedCalendarEvent.self])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    override func setUp() {
        super.setUp()
        vm = InteractionViewModel()
    }

    override func tearDown() {
        vm = nil
        super.tearDown()
    }

    func testNoFilterReturnsAllSorted() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let contact = Contact(firstName: "Test", lastName: "User")
        context.insert(contact)

        let oldest = Interaction(contact: contact, type: .call, date: Date(timeIntervalSinceNow: -7200))
        let middle = Interaction(contact: contact, type: .email, date: Date(timeIntervalSinceNow: -3600))
        let newest = Interaction(contact: contact, type: .meeting, date: Date())

        context.insert(oldest)
        context.insert(middle)
        context.insert(newest)

        vm.filterType = nil
        let result = vm.filteredInteractions(for: contact)

        XCTAssertEqual(result.count, 3)
        // Sorted by date descending
        XCTAssertEqual(result[0].type, .meeting)
        XCTAssertEqual(result[1].type, .email)
        XCTAssertEqual(result[2].type, .call)
    }

    func testFilterByType() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let contact = Contact(firstName: "Test", lastName: "User")
        context.insert(contact)

        let call = Interaction(contact: contact, type: .call, date: Date())
        let email = Interaction(contact: contact, type: .email, date: Date())
        let meeting = Interaction(contact: contact, type: .meeting, date: Date())

        context.insert(call)
        context.insert(email)
        context.insert(meeting)

        vm.filterType = .call
        let result = vm.filteredInteractions(for: contact)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.type, .call)
    }
}
