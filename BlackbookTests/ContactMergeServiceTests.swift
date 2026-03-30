import XCTest
import SwiftData
@testable import Blackbook

final class ContactMergeServiceTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private let mergeService = ContactMergeService()

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

    private func makeContact(firstName: String = "Primary", lastName: String = "User") -> Contact {
        let contact = Contact(firstName: firstName, lastName: lastName)
        context.insert(contact)
        return contact
    }

    // MARK: - 1. Merge Same Contact Is No-Op

    func testMergeSameContactIsNoOp() throws {
        let contact = makeContact()
        contact.company = "Original"
        try context.save()

        try mergeService.merge(primary: contact, secondary: contact, context: context)

        XCTAssertEqual(contact.company, "Original", "Merging a contact with itself should be a no-op")
        XCTAssertFalse(contact.isMergedAway, "Contact should not be marked as merged away when merging with itself")
    }

    // MARK: - 2. Scalar Fields Merge (Primary Nil)

    func testScalarFieldsMerge() throws {
        let primary = makeContact(firstName: "Primary")
        primary.company = nil

        let secondary = makeContact(firstName: "Secondary")
        secondary.company = "Acme"

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertEqual(primary.company, "Acme", "Primary should inherit secondary's company when primary is nil")
    }

    // MARK: - 3. Scalar Fields Primary Wins

    func testScalarFieldsPrimaryWins() throws {
        let primary = makeContact(firstName: "Primary")
        primary.company = "Beta"

        let secondary = makeContact(firstName: "Secondary")
        secondary.company = "Acme"

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertEqual(primary.company, "Beta", "Primary's non-nil company should be preserved")
    }

    // MARK: - 4. Array Fields Union

    func testArrayFieldsUnion() throws {
        let primary = makeContact(firstName: "Primary")
        primary.emails = ["alice@example.com", "shared@example.com"]

        let secondary = makeContact(firstName: "Secondary")
        secondary.emails = ["bob@example.com", "shared@example.com"]

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertTrue(primary.emails.contains("alice@example.com"), "Primary's original email should be preserved")
        XCTAssertTrue(primary.emails.contains("bob@example.com"), "Secondary's unique email should be added")
        XCTAssertTrue(primary.emails.contains("shared@example.com"), "Shared email should be present")

        let uniqueCount = Set(primary.emails).count
        XCTAssertEqual(uniqueCount, primary.emails.count, "No duplicate emails should exist after merge")
    }

    // MARK: - 5. Score Takes Max

    func testScoreTakesMax() throws {
        let primary = makeContact(firstName: "Primary")
        primary.relationshipScore = 40.0

        let secondary = makeContact(firstName: "Secondary")
        secondary.relationshipScore = 60.0

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertEqual(primary.relationshipScore, 60.0, "Primary should take the higher score")
    }

    // MARK: - 6. isPriority Propagates

    func testIsPriorityPropagates() throws {
        let primary = makeContact(firstName: "Primary")
        primary.isPriority = false

        let secondary = makeContact(firstName: "Secondary")
        secondary.isPriority = true

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertTrue(primary.isPriority, "Primary should become priority if secondary is priority")
    }

    // MARK: - 7. Interactions Reparented

    func testInteractionsReparented() throws {
        let primary = makeContact(firstName: "Primary")
        let secondary = makeContact(firstName: "Secondary")

        let interaction = Interaction(contact: secondary, type: .call, date: Date())
        context.insert(interaction)

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertEqual(interaction.contact?.id, primary.id, "Interaction should be reparented to primary")
    }

    // MARK: - 8. Notes Reparented

    func testNotesReparented() throws {
        let primary = makeContact(firstName: "Primary")
        let secondary = makeContact(firstName: "Secondary")

        let note = Note(contact: secondary, content: "Test note")
        context.insert(note)

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertEqual(note.contact?.id, primary.id, "Note should be reparented to primary")
    }

    // MARK: - 9. Reminders Reparented

    func testRemindersReparented() throws {
        let primary = makeContact(firstName: "Primary")
        let secondary = makeContact(firstName: "Secondary")

        let reminder = Reminder(contact: secondary, title: "Follow up", dueDate: Date())
        context.insert(reminder)

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertEqual(reminder.contact?.id, primary.id, "Reminder should be reparented to primary")
    }

    // MARK: - 10. Secondary Marked Merged Away

    func testSecondaryMarkedMergedAway() throws {
        let primary = makeContact(firstName: "Primary")
        let secondary = makeContact(firstName: "Secondary")

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertTrue(secondary.isMergedAway, "Secondary should be marked as merged away")
    }

    // MARK: - 11. MergedIntoContact Set

    func testMergedIntoContactSet() throws {
        let primary = makeContact(firstName: "Primary")
        let secondary = makeContact(firstName: "Secondary")

        try context.save()
        try mergeService.merge(primary: primary, secondary: secondary, context: context)

        XCTAssertEqual(secondary.mergedIntoContact?.id, primary.id, "Secondary's mergedIntoContact should point to primary")
    }
}
