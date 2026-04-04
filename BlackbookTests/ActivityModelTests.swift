import XCTest
import SwiftData
@testable import Blackbook

@MainActor
final class ActivityModelTests: XCTestCase {

    func testActivityDefaultValues() throws {
        let activity = Activity(name: "Lunch")

        XCTAssertEqual(activity.name, "Lunch")
        XCTAssertEqual(activity.colorHex, "3498DB")
        XCTAssertEqual(activity.icon, "figure.run")
        XCTAssertEqual(activity.activityDescription, "")
        XCTAssertNil(activity.endDate)
        XCTAssertNil(activity.googleEventId)
        XCTAssertTrue(activity.contacts.isEmpty)
        XCTAssertTrue(activity.groups.isEmpty)
    }

    func testActivityColorConversion() throws {
        let activity = Activity(name: "Test", colorHex: "E74C3C")
        XCTAssertNotNil(activity.color)
    }

    func testActivityContactRelationship() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let activity = Activity(name: "Dinner", date: Date())
        context.insert(activity)

        let contact = Contact(firstName: "Alice", lastName: "Smith")
        context.insert(contact)

        activity.contacts.append(contact)
        try context.save()

        XCTAssertTrue(activity.contacts.contains(where: { $0.id == contact.id }))
        XCTAssertTrue(contact.activities.contains(where: { $0.id == activity.id }))
    }

    func testActivityGroupRelationship() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let activity = Activity(name: "Team Lunch", date: Date())
        context.insert(activity)

        let group = Group(name: "Engineering")
        context.insert(group)

        activity.groups.append(group)
        try context.save()

        XCTAssertTrue(activity.groups.contains(where: { $0.id == group.id }))
        XCTAssertTrue(group.activities.contains(where: { $0.id == activity.id }))
    }

    func testActivityDateRange() throws {
        let start = Date()
        let end = Calendar.current.date(byAdding: .hour, value: 2, to: start)!
        let activity = Activity(name: "Meeting", date: start, endDate: end)

        XCTAssertTrue(activity.dateRange.contains("–"), "Date range should include dash separator when endDate is set")
    }

    func testActivityDateRangeNoEnd() throws {
        let activity = Activity(name: "Call", date: Date())
        XCTAssertFalse(activity.dateRange.contains("–"), "Date range should not include dash when no endDate")
    }
}
