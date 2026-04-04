import XCTest
import SwiftData
@testable import Blackbook

@MainActor
final class GroupModelTests: XCTestCase {

    func testGroupDefaultValues() throws {
        let group = Group(name: "Team")

        XCTAssertEqual(group.name, "Team")
        XCTAssertEqual(group.colorHex, "3498DB")
        XCTAssertEqual(group.icon, "folder")
        XCTAssertTrue(group.contacts.isEmpty)
        XCTAssertTrue(group.activities.isEmpty)
    }

    func testGroupContactRelationship() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let group = Group(name: "Friends")
        context.insert(group)

        let contact = Contact(firstName: "Alice", lastName: "Smith")
        context.insert(contact)

        contact.groups.append(group)
        try context.save()

        XCTAssertTrue(group.contacts.contains(where: { $0.id == contact.id }))
        XCTAssertTrue(contact.groups.contains(where: { $0.id == group.id }))
    }

    func testGroupIconPersistence() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let group = Group(name: "Sports", colorHex: "2ECC71", icon: "sportscourt")
        context.insert(group)
        try context.save()

        let fetched = try context.fetch(FetchDescriptor<Group>())
        XCTAssertEqual(fetched.first?.icon, "sportscourt")
    }

    func testGroupActivityRelationship() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let group = Group(name: "Work")
        context.insert(group)

        let activity = Activity(name: "Meeting", date: Date())
        context.insert(activity)

        activity.groups.append(group)
        try context.save()

        XCTAssertTrue(group.activities.contains(where: { $0.id == activity.id }))
    }

    func testGroupColorConversion() throws {
        let group = Group(name: "Test", colorHex: "E74C3C")
        XCTAssertNotNil(group.color)
    }
}
