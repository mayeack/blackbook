import Foundation
import SwiftUI
import SwiftData

struct GraphNode: Identifiable {
    let id: UUID
    let contact: Contact
    var position: CGPoint
    var velocity: CGPoint = .zero
    var radius: CGFloat { 16 + CGFloat(contact.relationshipScore / 100) * 12 }
}

struct GraphEdge: Identifiable {
    let id: UUID
    let relationship: ContactRelationship
    let fromId: UUID
    let toId: UUID
}

/// Force-directed graph layout engine for visualizing contact relationships.
///
/// Uses physics simulation with repulsive forces between all nodes,
/// attractive forces along edges, and gravity toward the canvas center.
@Observable
final class NetworkGraphEngine {
    var nodes: [GraphNode] = []
    var edges: [GraphEdge] = []

    // MARK: - Physics Constants

    private let nodePadding: CGFloat = 50
    private let repulsionForce: CGFloat = 5000
    private let attractionForce: CGFloat = 0.001
    private let gravityForce: CGFloat = 0.01
    private let velocityDamping: CGFloat = 0.85
    private let maxVelocity: CGFloat = 10
    private let convergenceThreshold: CGFloat = 0.1

    func buildGraph(contacts: [Contact], relationships: [ContactRelationship], canvasSize: CGSize) {
        nodes = contacts.map {
            GraphNode(id: $0.id, contact: $0, position: CGPoint(
                x: CGFloat.random(in: nodePadding...(canvasSize.width - nodePadding)),
                y: CGFloat.random(in: nodePadding...(canvasSize.height - nodePadding))
            ))
        }
        let contactIds = Set(contacts.map(\.id))
        edges = relationships.compactMap { rel in
            guard let from = rel.fromContact, let to = rel.toContact,
                  contactIds.contains(from.id), contactIds.contains(to.id) else { return nil }
            return GraphEdge(id: rel.id, relationship: rel, fromId: from.id, toId: to.id)
        }
    }

    @discardableResult
    func simulateStep(canvasSize: CGSize) -> Bool {
        guard nodes.count > 1 else { return true }
        var forces = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, CGPoint.zero) })
        let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
        for i in 0..<nodes.count {
            for j in (i+1)..<nodes.count {
                let dx = nodes[j].position.x - nodes[i].position.x
                let dy = nodes[j].position.y - nodes[i].position.y
                let distSq = max(dx*dx + dy*dy, 1)
                let dist = sqrt(distSq)
                let f = repulsionForce / distSq
                forces[nodes[i].id]?.x -= (dx/dist)*f
                forces[nodes[i].id]?.y -= (dy/dist)*f
                forces[nodes[j].id]?.x += (dx/dist)*f
                forces[nodes[j].id]?.y += (dy/dist)*f
            }
        }
        let idx = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($1.id, $0) })
        for edge in edges {
            guard let fi = idx[edge.fromId], let ti = idx[edge.toId] else { continue }
            let dx = nodes[ti].position.x - nodes[fi].position.x
            let dy = nodes[ti].position.y - nodes[fi].position.y
            forces[edge.fromId]?.x += dx * attractionForce
            forces[edge.fromId]?.y += dy * attractionForce
            forces[edge.toId]?.x -= dx * attractionForce
            forces[edge.toId]?.y -= dy * attractionForce
        }
        var maxSpeed: CGFloat = 0
        for i in 0..<nodes.count {
            guard let force = forces[nodes[i].id] else { continue }
            let gx = center.x - nodes[i].position.x
            let gy = center.y - nodes[i].position.y
            nodes[i].velocity.x = (nodes[i].velocity.x + force.x + gx*gravityForce) * velocityDamping
            nodes[i].velocity.y = (nodes[i].velocity.y + force.y + gy*gravityForce) * velocityDamping
            let speed = sqrt(nodes[i].velocity.x*nodes[i].velocity.x + nodes[i].velocity.y*nodes[i].velocity.y)
            if speed > maxSpeed { maxSpeed = speed }
            if speed > maxVelocity { nodes[i].velocity.x *= maxVelocity/speed; nodes[i].velocity.y *= maxVelocity/speed }
            nodes[i].position.x = max(nodes[i].radius, min(canvasSize.width - nodes[i].radius, nodes[i].position.x + nodes[i].velocity.x))
            nodes[i].position.y = max(nodes[i].radius, min(canvasSize.height - nodes[i].radius, nodes[i].position.y + nodes[i].velocity.y))
        }
        return maxSpeed < convergenceThreshold
    }

    func filteredNodes(byTagIds tagIds: Set<UUID>) -> [GraphNode] {
        guard !tagIds.isEmpty else { return nodes }
        return nodes.filter { !Set($0.contact.tags.map(\.id)).isDisjoint(with: tagIds) }
    }
}
