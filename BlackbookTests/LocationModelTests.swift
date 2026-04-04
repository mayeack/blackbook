import XCTest
import SwiftData
@testable import Blackbook

@MainActor
final class LocationModelTests: XCTestCase {

    func testLocationDefaultValues() throws {
        let location = Location(name: "Office")

        XCTAssertEqual(location.name, "Office")
        XCTAssertEqual(location.colorHex, "3498DB")
        XCTAssertEqual(location.icon, "mappin")
        XCTAssertTrue(location.contacts.isEmpty)
    }

    func testLocationContactRelationship() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let location = Location(name: "NYC")
        context.insert(location)

        let contact = Contact(firstName: "Alice", lastName: "Smith")
        context.insert(contact)

        contact.locations.append(location)
        try context.save()

        XCTAssertTrue(location.contacts.contains(where: { $0.id == contact.id }))
        XCTAssertTrue(contact.locations.contains(where: { $0.id == location.id }))
    }

    func testLocationColorConversion() throws {
        let location = Location(name: "Test", colorHex: "2ECC71")
        XCTAssertNotNil(location.color)
    }
}
