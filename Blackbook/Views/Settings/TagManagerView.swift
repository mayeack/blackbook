import SwiftUI
import SwiftData

struct TagManagerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Tag.name) private var tags: [Tag]
    @State private var showAddTag = false
    @State private var editingTag: Tag?

    var body: some View {
        NavigationStack {
            SwiftUI.Group {
                if tags.isEmpty {
                    ContentUnavailableView {
                        Label("No Tags", systemImage: "tag")
                    } description: {
                        Text("Create tags to organize your contacts.")
                    }
                }
                else {
                    List {
                        ForEach(tags) { tag in
                            HStack(spacing: 12) { Circle().fill(tag.color).frame(width: 14, height: 14); Text(tag.name); Spacer(); Text("\(tag.contacts.count)").font(.caption).foregroundStyle(.secondary) }
                                .contentShape(Rectangle()).onTapGesture { editingTag = tag }
                        }.onDelete { for i in $0 { modelContext.delete(tags[i]) }; try? modelContext.save() }
                    }
                }
            }
            .navigationTitle("Manage Tags")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button { showAddTag = true } label: { Image(systemName: "plus") } }
            }
            .sheet(isPresented: $showAddTag) { TagFormView(tag: nil) }
            .sheet(item: $editingTag) { TagFormView(tag: $0) }
        }
    }
}

struct TagFormView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    let tag: Tag?
    @State private var name = ""; @State private var selectedColor = "D4A017"
    private let colors = ["D4A017","E74C3C","3498DB","2ECC71","9B59B6","E67E22","1ABC9C","F39C12","E91E63","607D8B"]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Tag Name", text: $name)
                        .labelsHidden()
                } header: {
                    Text("Tag Name")
                }
                Section("Color") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 5), spacing: 12) {
                        ForEach(colors, id: \.self) { hex in
                            Circle().fill(Color(hex: hex) ?? .gray).frame(width: 36, height: 36)
                                .overlay { if selectedColor == hex { Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white) } }
                                .onTapGesture { selectedColor = hex }
                        }
                    }.padding(.vertical, 4)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .navigationTitle(tag == nil ? "New Tag" : "Edit Tag")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") {
                    withAnimation {
                        if let t = tag { t.name = name.trimmingCharacters(in: .whitespacesAndNewlines); t.colorHex = selectedColor }
                        else { modelContext.insert(Tag(name: name.trimmingCharacters(in: .whitespacesAndNewlines), colorHex: selectedColor)) }
                        try? modelContext.save()
                    }
                    dismiss()
                }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
            .onAppear { if let t = tag { name = t.name; selectedColor = t.colorHex } }
        }
    }
}
