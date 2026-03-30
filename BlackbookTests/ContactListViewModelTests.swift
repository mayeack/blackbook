import XCTest
import SwiftData
@testable import Blackbook

final class ContactListViewModelTests: XCTestCase {

    private var vm: ContactListViewModel!

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([Contact.self, Interaction.self, Note.self, Tag.self, Group.self, Location.self, ContactRelationship.self, Reminder.self, Activity.self, RejectedCalendarEvent.self])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    override func setUp() {
        super.setUp()
        vm = ContactListViewModel()
    }

    override func tearDown() {
        vm = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeContact(
        firstName: String = "John",
        lastName: String = "Doe",
        company: String? = nil,
        score: Double = 50,
        isHidden: Bool = false,
        isMergedAway: Bool = false,
        createdAt: Date = Date()
    ) -> Contact {
        let c = Contact(firstName: firstName, lastName: lastName, company: company)
        c.relationshipScore = score
        c.isHidden = isHidden
        c.isMergedAway = isMergedAway
        c.createdAt = createdAt
        return c
    }

    // MARK: - Tests

    func testFilterExcludesHiddenAndMerged() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let visible = makeContact(firstName: "Visible", lastName: "User")
        let hidden = makeContact(firstName: "Hidden", lastName: "User", isHidden: true)
        let merged = makeContact(firstName: "Merged", lastName: "User", isMergedAway: true)

        context.insert(visible)
        context.insert(hidden)
        context.insert(merged)

        let contacts = [visible, hidden, merged]
        let result = vm.filteredContacts(contacts, tags: [])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.firstName, "Visible")
    }

    func testSearchByName() throws {
        let alice = makeContact(firstName: "Alice", lastName: "Smith")
        let bob = makeContact(firstName: "Bob", lastName: "Jones")

        vm.searchText = "Alice"
        let result = vm.filteredContacts([alice, bob], tags: [])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.firstName, "Alice")
    }

    func testSearchByCompany() throws {
        let c1 = makeContact(firstName: "Alice", lastName: "Smith", company: "Acme Corp")
        let c2 = makeContact(firstName: "Bob", lastName: "Jones", company: "Widgets Inc")

        vm.searchText = "Acme"
        let result = vm.filteredContacts([c1, c2], tags: [])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.company, "Acme Corp")
    }

    func testSearchCaseInsensitive() throws {
        let c = makeContact(firstName: "Alice", lastName: "Smith")

        vm.searchText = "aLiCe"
        let result = vm.filteredContacts([c], tags: [])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.firstName, "Alice")
    }

    func testFilterByTag() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let tag = Tag(name: "VIP")
        context.insert(tag)

        let c1 = makeContact(firstName: "Alice", lastName: "Smith")
        let c2 = makeContact(firstName: "Bob", lastName: "Jones")
        context.insert(c1)
        context.insert(c2)

        c1.tags.append(tag)

        vm.selectedTags = [tag.id]
        let result = vm.filteredContacts([c1, c2], tags: [tag])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.firstName, "Alice")
    }

    func testSortByName() throws {
        let c1 = makeContact(firstName: "Zoe", lastName: "Adams")
        let c2 = makeContact(firstName: "Alice", lastName: "Zeller")
        let c3 = makeContact(firstName: "Bob", lastName: "Adams")

        vm.sortOrder = .name
        let result = vm.filteredContacts([c1, c2, c3], tags: [])

        // Sorted by lastName then firstName: Adams (Bob), Adams (Zoe), Zeller (Alice)
        XCTAssertEqual(result[0].firstName, "Bob")
        XCTAssertEqual(result[1].firstName, "Zoe")
        XCTAssertEqual(result[2].firstName, "Alice")
    }

    func testSortByScore() throws {
        let c1 = makeContact(firstName: "Low", lastName: "Score", score: 10)
        let c2 = makeContact(firstName: "High", lastName: "Score", score: 90)
        let c3 = makeContact(firstName: "Mid", lastName: "Score", score: 50)

        vm.sortOrder = .score
        let result = vm.filteredContacts([c1, c2, c3], tags: [])

        XCTAssertEqual(result[0].firstName, "High")
        XCTAssertEqual(result[1].firstName, "Mid")
        XCTAssertEqual(result[2].firstName, "Low")
    }

    func testEmptySearchReturnsAll() throws {
        let c1 = makeContact(firstName: "Alice", lastName: "Smith")
        let c2 = makeContact(firstName: "Bob", lastName: "Jones")

        vm.searchText = ""
        let result = vm.filteredContacts([c1, c2], tags: [])

        XCTAssertEqual(result.count, 2)
    }
}
