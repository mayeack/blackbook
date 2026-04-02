import SwiftUI
import SwiftData

struct TagListView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Tag.name) private var tags: [Tag]
    @State private var searchText = ""
    @State private var showAddTag = false

    private var filteredTags: [Tag] {
        if searchText.isEmpty { return tags }
        return tags.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        SwiftUI.Group {
            if filteredTags.isEmpty {
                ContentUnavailableView {
                    Label("No Tags", systemImage: "tag")
                } description: {
                    Text("Create tags to organize your contacts.")
                } actions: {
                    Button("New Tag") { showAddTag = true }
                        .buttonStyle(.borderedProminent)
                        .tint(AppConstants.UI.accentGold)
                }
            } else {
                List {
                    ForEach(filteredTags) { tag in
                        NavigationLink(value: tag.id) {
                            TagRowView(tag: tag)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                withAnimation {
                                    modelContext.delete(tag)
                                    try? modelContext.save()
                                }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
                .navigationDestination(for: UUID.self) { id in
                    if let tag = tags.first(where: { $0.id == id }) {
                        TagDetailView(tag: tag)
                    }
                }
            }
        }
        .animation(.default, value: filteredTags.map(\.id))
        .navigationTitle("Tags")
        .searchable(text: $searchText, prompt: "Search tags...")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAddTag = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showAddTag) { TagFormView(tag: nil) }
    }
}

struct TagRowView: View {
    let tag: Tag

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "tag.fill")
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(tag.color.gradient, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(tag.name)
                    .font(.body.weight(.medium))
                Text("\(tag.contacts.count) contact\(tag.contacts.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}
