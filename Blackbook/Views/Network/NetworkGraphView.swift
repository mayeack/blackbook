import SwiftUI
import SwiftData

struct NetworkGraphView: View {
    @Query(sort: \Contact.lastName) private var allContacts: [Contact]
    @State private var viewModel = NetworkGraphViewModel()
    @State private var selectedContactID: UUID?
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var trees: [MetViaTreeNode] = []

    private var contacts: [Contact] { allContacts.filter { !$0.isHidden && !$0.isMergedAway } }
    private var contactsByID: [UUID: Contact] {
        Dictionary(uniqueKeysWithValues: contacts.map { ($0.id, $0) })
    }

    var body: some View {
        SwiftUI.Group {
            if trees.isEmpty {
                ContentUnavailableView {
                    Label("No Connections", systemImage: "point.3.connected.trianglepath.dotted")
                } description: {
                    Text("Set \"Met via\" on your contacts to see your relationship tree.")
                }
            } else {
                treeCanvas
            }
        }
        .navigationTitle("Network")
        .navigationDestination(for: UUID.self) { id in
            if let c = contactsByID[id] { ContactDetailView(contact: c) }
        }
        .onAppear { rebuildLayout() }
        .onChange(of: allContacts.map(\.id)) { _, _ in rebuildLayout() }
    }

    private func rebuildLayout() {
        let newTrees = viewModel.buildTree(contacts: contacts)
        viewModel.computeLayout(trees: newTrees)
        trees = newTrees
    }

    @ViewBuilder
    private var treeCanvas: some View {
        let nodes = Array(viewModel.layoutNodes.values)

        ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                TreeEdgesShape(nodes: viewModel.layoutNodes)
                    .stroke(
                        AppConstants.UI.accentGold.opacity(0.35),
                        style: StrokeStyle(lineWidth: 2, lineCap: .round)
                    )

                ForEach(nodes) { node in
                    TreeNodeView(
                        node: node,
                        isSelected: selectedContactID == node.id
                    )
                    .position(node.position)
                    .onTapGesture {
                        selectedContactID = node.id
                    }
                }
            }
            .frame(
                width: viewModel.canvasSize.width * scale,
                height: viewModel.canvasSize.height * scale
            )
            .scaleEffect(scale, anchor: .topLeading)
            .gesture(
                MagnifyGesture()
                    .onChanged { value in
                        scale = max(0.4, min(3.0, lastScale * value.magnification))
                    }
                    .onEnded { value in
                        scale = max(0.4, min(3.0, lastScale * value.magnification))
                        lastScale = scale
                    }
            )
        }
        .background(treeBackground)
        .overlay(alignment: .bottomTrailing) {
            zoomControls
        }
        .overlay(alignment: .bottom) {
            if let id = selectedContactID, let contact = contactsByID[id] {
                selectedContactBar(contact: contact)
            }
        }
    }

    private var zoomControls: some View {
        VStack(spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    scale = min(3.0, scale * 1.3)
                    lastScale = scale
                }
            } label: {
                Image(systemName: "plus")
                    .font(.body.weight(.semibold))
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial, in: Circle())
            }

            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    scale = max(0.4, scale / 1.3)
                    lastScale = scale
                }
            } label: {
                Image(systemName: "minus")
                    .font(.body.weight(.semibold))
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial, in: Circle())
            }

            Button {
                withAnimation(.easeInOut(duration: 0.25)) {
                    scale = 1.0
                    lastScale = 1.0
                }
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.caption.weight(.semibold))
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial, in: Circle())
            }
        }
        .buttonStyle(.plain)
        .padding(16)
    }

    private var treeBackground: Color {
        #if os(iOS)
        Color(UIColor.systemBackground)
        #else
        Color(NSColor.windowBackgroundColor)
        #endif
    }

    private func selectedContactBar(contact: Contact) -> some View {
        NavigationLink(value: contact.id) {
            HStack(spacing: 12) {
                ContactAvatarView(contact: contact, size: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    if let company = contact.company, !company.isEmpty {
                        Text(company)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .animation(.easeInOut(duration: 0.2), value: selectedContactID)
    }
}

// MARK: - Tree Node View

private struct TreeNodeView: View {
    let node: LayoutNode
    let isSelected: Bool

    private let diameter: CGFloat = NetworkGraphViewModel.nodeDiameter

    static var backgroundFill: Color {
        #if os(iOS)
        Color(UIColor.secondarySystemBackground)
        #else
        Color(NSColor.controlBackgroundColor)
        #endif
    }

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(isSelected ? AppConstants.UI.accentGold : TreeNodeView.backgroundFill)
                    .frame(width: diameter, height: diameter)
                    .shadow(color: isSelected ? AppConstants.UI.accentGold.opacity(0.4) : .black.opacity(0.1),
                            radius: isSelected ? 8 : 3, y: 2)

                ContactAvatarView(contact: node.contact, size: diameter - 4)
                    .overlay {
                        Circle()
                            .strokeBorder(
                                isSelected ? AppConstants.UI.accentGold : Color.white.opacity(0.8),
                                lineWidth: isSelected ? 3 : 2
                            )
                    }
            }

            Text(node.contact.firstName.isEmpty ? node.contact.displayName : node.contact.firstName)
                .font(.caption2.weight(.medium))
                .foregroundStyle(isSelected ? AppConstants.UI.accentGold : .primary)
                .lineLimit(1)
                .frame(width: diameter + 20)
        }
        .scaleEffect(isSelected ? 1.1 : 1.0)
        .animation(.easeInOut(duration: 0.15), value: isSelected)
    }
}

// MARK: - Tree Edges

private struct TreeEdgesShape: Shape {
    let nodes: [UUID: LayoutNode]

    func path(in rect: CGRect) -> Path {
        Path { path in
            for node in nodes.values {
                guard let parentID = node.parentID,
                      let parent = nodes[parentID] else { continue }

                let from = parent.position
                let to = node.position
                let midY = (from.y + to.y) / 2

                path.move(to: from)
                path.addCurve(
                    to: to,
                    control1: CGPoint(x: from.x, y: midY),
                    control2: CGPoint(x: to.x, y: midY)
                )
            }
        }
    }
}

