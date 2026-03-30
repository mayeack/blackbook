import XCTest
import SwiftData
@testable import Blackbook

final class NetworkGraphViewModelTests: XCTestCase {

    private var vm: NetworkGraphViewModel!

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([Contact.self, Interaction.self, Note.self, Tag.self, Group.self, Location.self, ContactRelationship.self, Reminder.self, Activity.self, RejectedCalendarEvent.self])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    override func setUp() {
        super.setUp()
        vm = NetworkGraphViewModel()
    }

    override func tearDown() {
        vm = nil
        super.tearDown()
    }

    // MARK: - buildTree

    func testBuildTreeSingleRoot() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let root = Contact(firstName: "Root", lastName: "User")
        let child1 = Contact(firstName: "Child1", lastName: "User")
        let child2 = Contact(firstName: "Child2", lastName: "User")

        context.insert(root)
        context.insert(child1)
        context.insert(child2)

        // Set up metVia relationships: children were introduced via root
        child1.metVia = root
        child2.metVia = root

        let trees = vm.buildTree(contacts: [root, child1, child2])

        XCTAssertEqual(trees.count, 1)
        XCTAssertEqual(trees.first?.contact.firstName, "Root")
        XCTAssertEqual(trees.first?.children?.count, 2)
    }

    func testBuildTreeExcludesHidden() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let root = Contact(firstName: "Root", lastName: "User")
        let child = Contact(firstName: "Child", lastName: "User")
        let hiddenChild = Contact(firstName: "Hidden", lastName: "User")
        hiddenChild.isHidden = true

        context.insert(root)
        context.insert(child)
        context.insert(hiddenChild)

        child.metVia = root
        hiddenChild.metVia = root

        let trees = vm.buildTree(contacts: [root, child, hiddenChild])

        XCTAssertEqual(trees.count, 1)
        // Only the non-hidden child should appear
        XCTAssertEqual(trees.first?.children?.count, 1)
        XCTAssertEqual(trees.first?.children?.first?.contact.firstName, "Child")
    }

    func testBuildTreeExcludesMergedAway() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let root = Contact(firstName: "Root", lastName: "User")
        let child = Contact(firstName: "Child", lastName: "User")
        let merged = Contact(firstName: "Merged", lastName: "User")
        merged.isMergedAway = true

        context.insert(root)
        context.insert(child)
        context.insert(merged)

        child.metVia = root
        merged.metVia = root

        let trees = vm.buildTree(contacts: [root, child, merged])

        XCTAssertEqual(trees.count, 1)
        XCTAssertEqual(trees.first?.children?.count, 1)
        XCTAssertEqual(trees.first?.children?.first?.contact.firstName, "Child")
    }

    func testEmptyContactsReturnsEmptyTree() {
        let trees = vm.buildTree(contacts: [])
        XCTAssertTrue(trees.isEmpty)
    }

    // MARK: - computeLayout

    func testComputeLayoutAssignsPositions() throws {
        let container = try makeContainer()
        let context = ModelContext(container)

        let root = Contact(firstName: "Root", lastName: "User")
        let child = Contact(firstName: "Child", lastName: "User")

        context.insert(root)
        context.insert(child)

        child.metVia = root

        let trees = vm.buildTree(contacts: [root, child])
        vm.computeLayout(trees: trees)

        XCTAssertFalse(vm.layoutNodes.isEmpty)
        XCTAssertGreaterThan(vm.canvasSize.width, 0)
        XCTAssertGreaterThan(vm.canvasSize.height, 0)

        // Root and child should both have layout positions
        XCTAssertNotNil(vm.layoutNodes[root.id])
        XCTAssertNotNil(vm.layoutNodes[child.id])

        // Child should be at a deeper Y than root
        let rootY = vm.layoutNodes[root.id]!.position.y
        let childY = vm.layoutNodes[child.id]!.position.y
        XCTAssertGreaterThan(childY, rootY)
    }

    func testComputeLayoutEmptyInput() {
        vm.computeLayout(trees: [])

        XCTAssertTrue(vm.layoutNodes.isEmpty)
        XCTAssertEqual(vm.canvasSize, .zero)
    }
}
