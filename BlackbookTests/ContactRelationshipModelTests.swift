import XCTest
import SwiftData
@testable import Blackbook

@MainActor
final class ContactRelationshipModelTests: XCTestCase {

    func testRelationshipCreation() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let alice = Contact(firstName: "Alice", lastName: "A")
        let bob = Contact(firstName: "Bob", lastName: "B")
        context.insert(alice)
        context.insert(bob)

        let relationship = ContactRelationship(from: alice, to: bob, label: "colleagues", strength: 0.8)
        context.insert(relationship)
        try context.save()

        XCTAssertEqual(relationship.fromContact?.id, alice.id)
        XCTAssertEqual(relationship.toContact?.id, bob.id)
        XCTAssertEqual(relationship.label, "colleagues")
        XCTAssertEqual(relationship.strength, 0.8)
    }

    func testRelationshipDirectionality() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let alice = Contact(firstName: "Alice", lastName: "A")
        let bob = Contact(firstName: "Bob", lastName: "B")
        context.insert(alice)
        context.insert(bob)

        let edge = ContactRelationship(from: alice, to: bob, label: "mentor")
        context.insert(edge)
        try context.save()

        XCTAssertTrue(alice.connectionsFrom.contains(where: { $0.id == edge.id }), "Alice should have an outgoing connection")
        XCTAssertTrue(bob.connectionsTo.contains(where: { $0.id == edge.id }), "Bob should have an incoming connection")
        XCTAssertFalse(alice.connectionsTo.contains(where: { $0.id == edge.id }), "Alice should not have this as incoming")
    }

    func testRelationshipDefaultValues() throws {
        let container = try TestHelpers.makeContainer()
        let context = container.mainContext

        let alice = Contact(firstName: "Alice", lastName: "A")
        let bob = Contact(firstName: "Bob", lastName: "B")
        context.insert(alice)
        context.insert(bob)

        let edge = ContactRelationship(from: alice, to: bob)
        context.insert(edge)

        XCTAssertNil(edge.label)
        XCTAssertNil(edge.strength)
    }
}
