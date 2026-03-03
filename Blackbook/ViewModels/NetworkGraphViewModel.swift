import Foundation
import Observation
import CoreGraphics

struct MetViaTreeNode: Identifiable {
    let id: UUID
    let contact: Contact
    let children: [MetViaTreeNode]?
}

struct LayoutNode: Identifiable {
    let id: UUID
    let contact: Contact
    let depth: Int
    var position: CGPoint
    let parentID: UUID?
    let childIDs: [UUID]
}

@Observable
final class NetworkGraphViewModel {

    private(set) var layoutNodes: [UUID: LayoutNode] = [:]
    private(set) var canvasSize: CGSize = .zero

    static let nodeSpacingX: CGFloat = 100
    static let nodeSpacingY: CGFloat = 120
    static let nodeDiameter: CGFloat = 56
    static let paddingH: CGFloat = 40
    static let paddingV: CGFloat = 60

    func buildTree(contacts: [Contact]) -> [MetViaTreeNode] {
        let visible = contacts.filter { !$0.isHidden && !$0.isMergedAway }
        let visibleIDs = Set(visible.map(\.id))

        let rootContacts = visible.filter { contact in
            let hasBacklinks = contact.metViaBacklinks.contains { visibleIDs.contains($0.id) }
            let metViaIsVisible = contact.metVia.map { visibleIDs.contains($0.id) } ?? false
            return hasBacklinks && !metViaIsVisible
        }

        var visited = Set<UUID>()
        let rootNodes = rootContacts
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .compactMap { buildNode(for: $0, visibleIDs: visibleIDs, visited: &visited) }

        return rootNodes
    }

    func computeLayout(trees: [MetViaTreeNode]) {
        layoutNodes = [:]
        guard !trees.isEmpty else {
            canvasSize = .zero
            return
        }

        var leafCounter = 0
        var allNodes: [UUID: LayoutNode] = [:]
        var maxDepth = 0

        for tree in trees {
            assignPositions(
                node: tree,
                depth: 0,
                parentID: nil,
                leafCounter: &leafCounter,
                allNodes: &allNodes,
                maxDepth: &maxDepth
            )
            leafCounter += 1
        }

        centerParents(allNodes: &allNodes)

        let totalWidth = CGFloat(leafCounter) * Self.nodeSpacingX + Self.paddingH * 2
        let totalHeight = CGFloat(maxDepth + 1) * Self.nodeSpacingY + Self.paddingV * 2

        for id in allNodes.keys {
            allNodes[id]?.position.x += Self.paddingH
            allNodes[id]?.position.y += Self.paddingV
        }

        layoutNodes = allNodes
        canvasSize = CGSize(width: max(totalWidth, 300), height: max(totalHeight, 200))
    }

    private func buildNode(for contact: Contact, visibleIDs: Set<UUID>, visited: inout Set<UUID>) -> MetViaTreeNode? {
        guard !visited.contains(contact.id) else { return nil }
        visited.insert(contact.id)

        let childContacts = contact.metViaBacklinks
            .filter { visibleIDs.contains($0.id) && !visited.contains($0.id) }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }

        let childNodes = childContacts.compactMap { buildNode(for: $0, visibleIDs: visibleIDs, visited: &visited) }

        return MetViaTreeNode(
            id: contact.id,
            contact: contact,
            children: childNodes.isEmpty ? nil : childNodes
        )
    }

    private func assignPositions(
        node: MetViaTreeNode,
        depth: Int,
        parentID: UUID?,
        leafCounter: inout Int,
        allNodes: inout [UUID: LayoutNode],
        maxDepth: inout Int
    ) {
        if depth > maxDepth { maxDepth = depth }

        let kids = node.children ?? []
        let childIDs = kids.map(\.id)

        if kids.isEmpty {
            let x = CGFloat(leafCounter) * Self.nodeSpacingX + Self.nodeSpacingX / 2
            let y = CGFloat(depth) * Self.nodeSpacingY + Self.nodeSpacingY / 2
            allNodes[node.id] = LayoutNode(
                id: node.id, contact: node.contact, depth: depth,
                position: CGPoint(x: x, y: y),
                parentID: parentID, childIDs: []
            )
            leafCounter += 1
        } else {
            for child in kids {
                assignPositions(
                    node: child, depth: depth + 1, parentID: node.id,
                    leafCounter: &leafCounter, allNodes: &allNodes, maxDepth: &maxDepth
                )
            }
            allNodes[node.id] = LayoutNode(
                id: node.id, contact: node.contact, depth: depth,
                position: .zero,
                parentID: parentID, childIDs: childIDs
            )
        }
    }

    private func centerParents(allNodes: inout [UUID: LayoutNode]) {
        let maxDepth = allNodes.values.map(\.depth).max() ?? 0
        for d in stride(from: maxDepth, through: 0, by: -1) {
            let nodesAtDepth = allNodes.values.filter { $0.depth == d }
            for node in nodesAtDepth {
                if !node.childIDs.isEmpty {
                    let childPositions = node.childIDs.compactMap { allNodes[$0]?.position }
                    guard !childPositions.isEmpty else { continue }
                    let avgX = childPositions.map(\.x).reduce(0, +) / CGFloat(childPositions.count)
                    let y = CGFloat(node.depth) * Self.nodeSpacingY + Self.nodeSpacingY / 2
                    allNodes[node.id]?.position = CGPoint(x: avgX, y: y)
                }
            }
        }
    }
}
