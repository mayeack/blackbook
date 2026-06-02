import XCTest
import SwiftData
@testable import Blackbook

/// Tests for `NetworkGraphEngine` — the force-directed layout engine behind the Network tab.
/// Covers graph construction (node/edge mapping, dangling-edge rejection), tag filtering, and
/// the convergence contract of `simulateStep`. Previously untested.
@MainActor
final class NetworkGraphEngineTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!
    private let engine = NetworkGraphEngine()
    private let canvas = CGSize(width: 400, height: 400)

    override func setUpWithError() throws {
        container = try TestHelpers.makeContainer()
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    // MARK: - Helpers

    @discardableResult
    private func makeContact(_ first: String, score: Double = 50) -> Contact {
        let c = TestHelpers.makeContact(firstName: first, lastName: "X", score: score, in: context)
        return c
    }

    @discardableResult
    private func relate(_ a: Contact, _ b: Contact, label: String = "friend") -> ContactRelationship {
        let rel = ContactRelationship(from: a, to: b, label: label)
        context.insert(rel)
        return rel
    }

    // MARK: - buildGraph

    func testBuildGraphCreatesNodePerContact() {
        let a = makeContact("A"); let b = makeContact("B"); let c = makeContact("C")
        engine.buildGraph(contacts: [a, b, c], relationships: [], canvasSize: canvas)
        XCTAssertEqual(engine.nodes.count, 3)
        XCTAssertEqual(engine.edges.count, 0)
        XCTAssertEqual(Set(engine.nodes.map(\.id)), Set([a.id, b.id, c.id]))
    }

    func testBuildGraphMapsValidEdges() {
        let a = makeContact("A"); let b = makeContact("B")
        let rel = relate(a, b)
        engine.buildGraph(contacts: [a, b], relationships: [rel], canvasSize: canvas)
        XCTAssertEqual(engine.edges.count, 1)
        XCTAssertEqual(engine.edges[0].fromId, a.id)
        XCTAssertEqual(engine.edges[0].toId, b.id)
    }

    func testBuildGraphDropsEdgeToContactNotInSet() {
        // A relationship pointing at a contact that isn't part of the rendered set must be skipped,
        // otherwise simulateStep would dereference a missing node index.
        let a = makeContact("A"); let b = makeContact("B"); let outsider = makeContact("Z")
        let danglingRel = relate(a, outsider)
        engine.buildGraph(contacts: [a, b], relationships: [danglingRel], canvasSize: canvas)
        XCTAssertEqual(engine.edges.count, 0, "edge to a non-rendered contact must be filtered out")
    }

    func testBuildGraphPlacesNodesWithinCanvas() {
        let a = makeContact("A")
        engine.buildGraph(contacts: [a], relationships: [], canvasSize: canvas)
        let p = engine.nodes[0].position
        XCTAssertGreaterThanOrEqual(p.x, 0)
        XCTAssertLessThanOrEqual(p.x, canvas.width)
        XCTAssertGreaterThanOrEqual(p.y, 0)
        XCTAssertLessThanOrEqual(p.y, canvas.height)
    }

    func testRebuildReplacesPreviousGraph() {
        let a = makeContact("A"); let b = makeContact("B")
        engine.buildGraph(contacts: [a, b], relationships: [relate(a, b)], canvasSize: canvas)
        XCTAssertEqual(engine.nodes.count, 2)
        let c = makeContact("C")
        engine.buildGraph(contacts: [c], relationships: [], canvasSize: canvas)
        XCTAssertEqual(engine.nodes.count, 1)
        XCTAssertEqual(engine.edges.count, 0)
        XCTAssertEqual(engine.nodes[0].id, c.id)
    }

    // MARK: - filteredNodes(byTagIds:)

    func testFilteredNodesEmptyFilterReturnsAll() {
        let a = makeContact("A"); let b = makeContact("B")
        engine.buildGraph(contacts: [a, b], relationships: [], canvasSize: canvas)
        XCTAssertEqual(engine.filteredNodes(byTagIds: []).count, 2)
    }

    func testFilteredNodesMatchesTaggedContactsOnly() throws {
        let tag = Tag(name: "VIP", colorHex: "FF0000")
        context.insert(tag)
        let tagged = makeContact("Tagged")
        tagged.tags = [tag]
        let untagged = makeContact("Untagged")
        engine.buildGraph(contacts: [tagged, untagged], relationships: [], canvasSize: canvas)

        let filtered = engine.filteredNodes(byTagIds: [tag.id])
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.id, tagged.id)
    }

    func testFilteredNodesUnmatchedTagReturnsNone() {
        let a = makeContact("A")
        engine.buildGraph(contacts: [a], relationships: [], canvasSize: canvas)
        XCTAssertTrue(engine.filteredNodes(byTagIds: [UUID()]).isEmpty)
    }

    // MARK: - simulateStep

    func testSimulateStepEventuallyConverges() {
        let a = makeContact("A"); let b = makeContact("B"); let c = makeContact("C")
        engine.buildGraph(contacts: [a, b, c], relationships: [relate(a, b)], canvasSize: canvas)
        var converged = false
        // The engine damps velocity each step; within a generous bound it should report convergence.
        for _ in 0..<2000 where !converged {
            converged = engine.simulateStep(canvasSize: canvas)
        }
        XCTAssertTrue(converged, "force simulation should converge on a small graph")
        // Positions must stay finite (no NaN/inf blow-up).
        for node in engine.nodes {
            XCTAssertTrue(node.position.x.isFinite && node.position.y.isFinite)
        }
    }

    func testSimulateStepOnEmptyGraphConvergesImmediately() {
        engine.buildGraph(contacts: [], relationships: [], canvasSize: canvas)
        XCTAssertTrue(engine.simulateStep(canvasSize: canvas))
    }
}
