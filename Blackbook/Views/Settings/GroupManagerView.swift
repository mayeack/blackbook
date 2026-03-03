import SwiftUI
import SwiftData

struct GroupManagerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Group.name) private var groups: [Group]
    @State private var showAddGroup = false
    @State private var editingGroup: Group?

    var body: some View {
        NavigationStack {
            SwiftUI.Group {
                if groups.isEmpty {
                    ContentUnavailableView {
                        Label("No Groups", systemImage: "folder")
                    } description: {
                        Text("Create groups to organize your contacts.")
                    }
                } else {
                    List {
                        ForEach(groups) { group in
                            HStack(spacing: 12) {
                                Image(systemName: group.icon)
                                    .font(.body)
                                    .foregroundStyle(group.color)
                                    .frame(width: 24)
                                Text(group.name)
                                Spacer()
                                Text("\(group.contacts.count)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { editingGroup = group }
                        }
                        .onDelete { offsets in
                            for i in offsets { modelContext.delete(groups[i]) }
                            try? modelContext.save()
                        }
                    }
                }
            }
            .navigationTitle("Manage Groups")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { showAddGroup = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showAddGroup) { GroupFormView(group: nil) }
            .sheet(item: $editingGroup) { GroupFormView(group: $0) }
        }
    }
}

struct GroupFormView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    let group: Group?
    @State private var name = ""
    @State private var selectedColor = "3498DB"
    @State private var selectedIcon = "folder"

    private let colors = [
        "3498DB", "E74C3C", "2ECC71", "9B59B6", "E67E22",
        "1ABC9C", "F39C12", "E91E63", "607D8B", "D4A017"
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Group Name", text: $name)
                        .labelsHidden()
                } header: {
                    Text("Group Name")
                }
                Section("Icon") {
                    GroupIconSuggestionView(
                        groupName: name,
                        selectedIcon: $selectedIcon,
                        accentColorHex: selectedColor
                    )
                }
                Section("Color") {
                    ColorPicker(colors: colors, selectedColor: $selectedColor)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .navigationTitle(group == nil ? "New Group" : "Edit Group")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        if let g = group {
                            g.name = trimmed
                            g.colorHex = selectedColor
                            g.icon = selectedIcon
                        } else {
                            modelContext.insert(Group(name: trimmed, colorHex: selectedColor, icon: selectedIcon))
                        }
                        try? modelContext.save()
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                if let g = group {
                    name = g.name
                    selectedColor = g.colorHex
                    selectedIcon = g.icon
                }
            }
        }
    }
}
