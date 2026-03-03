import SwiftUI
import SwiftData

struct LocationManagerView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \Location.name) private var locations: [Location]
    @State private var showAddLocation = false
    @State private var editingLocation: Location?

    var body: some View {
        NavigationStack {
            SwiftUI.Group {
                if locations.isEmpty {
                    ContentUnavailableView {
                        Label("No Locations", systemImage: "mappin")
                    } description: {
                        Text("Create locations to organize your contacts by place.")
                    }
                } else {
                    List {
                        ForEach(locations) { location in
                            HStack(spacing: 12) {
                                Image(systemName: location.icon)
                                    .font(.body)
                                    .foregroundStyle(location.color)
                                    .frame(width: 24)
                                Text(location.name)
                                Spacer()
                                Text("\(location.contacts.count)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { editingLocation = location }
                        }
                        .onDelete { offsets in
                            for i in offsets { modelContext.delete(locations[i]) }
                            try? modelContext.save()
                        }
                    }
                }
            }
            .navigationTitle("Manage Locations")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { showAddLocation = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showAddLocation) { LocationFormView(location: nil) }
            .sheet(item: $editingLocation) { LocationFormView(location: $0) }
        }
    }
}

struct LocationFormView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    let location: Location?
    @State private var name = ""
    @State private var selectedColor = "3498DB"
    @State private var selectedIcon = "mappin"

    private let colors = [
        "3498DB", "E74C3C", "2ECC71", "9B59B6", "E67E22",
        "1ABC9C", "F39C12", "E91E63", "607D8B", "D4A017"
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Location Name", text: $name)
                        .labelsHidden()
                } header: {
                    Text("Location Name")
                }
                Section("Icon") {
                    LocationIconSuggestionView(
                        locationName: name,
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
            .navigationTitle(location == nil ? "New Location" : "Edit Location")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        if let loc = location {
                            loc.name = trimmedName
                            loc.colorHex = selectedColor
                            loc.icon = selectedIcon
                        } else {
                            modelContext.insert(Location(
                                name: trimmedName,
                                colorHex: selectedColor,
                                icon: selectedIcon
                            ))
                        }
                        try? modelContext.save()
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                if let loc = location {
                    name = loc.name
                    selectedColor = loc.colorHex
                    selectedIcon = loc.icon
                }
            }
        }
    }
}
