import XCTest
@testable import Blackbook

final class ReminderModelTests: XCTestCase {

    // MARK: - Recurrence enum

    func testRecurrenceRawValues() {
        XCTAssertEqual(Recurrence.weekly.rawValue, "Weekly")
        XCTAssertEqual(Recurrence.biweekly.rawValue, "Biweekly")
        XCTAssertEqual(Recurrence.monthly.rawValue, "Monthly")
        XCTAssertEqual(Recurrence.quarterly.rawValue, "Quarterly")
    }

    func testRecurrenceCaseCount() {
        XCTAssertEqual(Recurrence.allCases.count, 4)
    }

    func testRecurrenceIdentifiable() {
        for recurrence in Recurrence.allCases {
            XCTAssertEqual(recurrence.id, recurrence.rawValue)
        }
    }

    // MARK: - Additional Reminder Tests

    @MainActor
    func testIsOverdue() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext
        let contact = TestHelpers.makeContact(in: context)

        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Date())!
        let reminder = TestHelpers.makeReminder(contact: contact, title: "Overdue", dueDate: yesterday, in: context)

        XCTAssertTrue(reminder.isOverdue, "Incomplete reminder past due date should be overdue")
    }

    @MainActor
    func testIsNotOverdueWhenCompleted() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext
        let contact = TestHelpers.makeContact(in: context)

        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Date())!
        let reminder = TestHelpers.makeReminder(contact: contact, title: "Done", dueDate: yesterday, in: context)
        reminder.isCompleted = true

        XCTAssertFalse(reminder.isOverdue, "Completed reminder should not be overdue even if past due")
    }

    @MainActor
    func testNextOccurrenceMonthly() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext
        let contact = TestHelpers.makeContact(in: context)

        let now = Date()
        let reminder = TestHelpers.makeReminder(contact: contact, title: "Monthly", dueDate: now, recurrence: .monthly, in: context)

        let next = reminder.nextOccurrence()
        XCTAssertNotNil(next)
        let expectedNext = Calendar.current.date(byAdding: .month, value: 1, to: now)
        XCTAssertEqual(next?.timeIntervalSinceReferenceDate ?? 0, expectedNext?.timeIntervalSinceReferenceDate ?? 0, accuracy: 1.0)
    }

    @MainActor
    func testNextOccurrenceWeekly() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext
        let contact = TestHelpers.makeContact(in: context)

        let now = Date()
        let reminder = TestHelpers.makeReminder(contact: contact, title: "Weekly", dueDate: now, recurrence: .weekly, in: context)

        let next = reminder.nextOccurrence()
        XCTAssertNotNil(next)
        let expectedNext = Calendar.current.date(byAdding: .weekOfYear, value: 1, to: now)
        XCTAssertEqual(next?.timeIntervalSinceReferenceDate ?? 0, expectedNext?.timeIntervalSinceReferenceDate ?? 0, accuracy: 1.0)
    }

    @MainActor
    func testNextOccurrenceNilForNonRecurring() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext
        let contact = TestHelpers.makeContact(in: context)

        let reminder = TestHelpers.makeReminder(contact: contact, title: "Once", dueDate: Date(), in: context)

        XCTAssertNil(reminder.nextOccurrence(), "Non-recurring reminder should return nil for next occurrence")
    }
}
