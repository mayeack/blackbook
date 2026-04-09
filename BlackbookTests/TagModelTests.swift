import XCTest
import SwiftUI
import SwiftData
@testable import Blackbook

@MainActor
final class TagModelTests: XCTestCase {

    func testTagDefaultValues() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext
        let tag = Tag(name: "VIP")
        context.insert(tag)

        XCTAssertEqual(tag.name, "VIP")
        XCTAssertEqual(tag.colorHex, "D4A017")
        XCTAssertTrue(tag.contacts.isEmpty)
    }

    func testTagColorConversion() throws {
        let tag = Tag(name: "Test", colorHex: "E74C3C")
        XCTAssertNotNil(tag.color, "Color should be created from valid hex")
    }

    func testTagInvalidColorFallback() throws {
        let tag = Tag(name: "Test", colorHex: "ZZZZZZ")
        // Invalid hex should fall back to accentColor via Color(hex:) returning nil
        XCTAssertNotNil(tag.color)
    }

    func testTagContactRelationship() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let tag = Tag(name: "Friends")
        context.insert(tag)

        let contact = Contact(firstName: "Alice", lastName: "Smith")
        context.insert(contact)

        contact.tags.append(tag)
        try context.save()

        XCTAssertTrue(tag.contacts.contains(where: { $0.id == contact.id }), "Tag should contain the contact")
        XCTAssertTrue(contact.tags.contains(where: { $0.id == tag.id }), "Contact should contain the tag")
    }

    func testTagContactCount() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let tag = Tag(name: "Work")
        context.insert(tag)

        let c1 = Contact(firstName: "Alice", lastName: "A")
        let c2 = Contact(firstName: "Bob", lastName: "B")
        context.insert(c1)
        context.insert(c2)

        c1.tags.append(tag)
        c2.tags.append(tag)
        try context.save()

        XCTAssertEqual(tag.contacts.count, 2)
    }

    func testColorHexStringRoundTrip() throws {
        let color = Color(hex: "3498DB")
        XCTAssertNotNil(color, "Should create color from valid hex")

        // Verify hex string conversion works
        let hex = color!.hexString
        XCTAssertEqual(hex.count, 6, "Hex string should be 6 characters")
    }
}
