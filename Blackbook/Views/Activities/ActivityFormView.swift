import SwiftUI
import SwiftData

struct ActivityFormView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    let activity: Activity?
    @State private var name = ""
    @State private var selectedColor = "3498DB"
    @State private var selectedIcon = "figure.run"
    @State private var date = Date()
    @State private var hasEndDate = false
    @State private var endDate = Date()
    @State private var activityDescription = ""

    private let colors = [
        "3498DB", "E74C3C", "2ECC71", "9B59B6", "E67E22",
        "1ABC9C", "F39C12", "E91E63", "607D8B", "D4A017"
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Activity Name", text: $name)
                        .labelsHidden()
                } header: {
                    Text("Name")
                }

                Section("Date") {
                    DatePicker("Start Date", selection: $date, displayedComponents: .date)
                        .labelsHidden()
                    Toggle("End Date", isOn: $hasEndDate.animation())
                    if hasEndDate {
                        DatePicker("End Date", selection: $endDate, in: date..., displayedComponents: .date)
                            .labelsHidden()
                    }
                }

                Section("Description") {
                    TextField("Add a description...", text: $activityDescription, axis: .vertical)
                        .lineLimit(3...6)
                }

                Section("Icon") {
                    CollapsibleIconPicker(
                        categories: AppConstants.Icons.groupCategories,
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
            .navigationTitle(activity == nil ? "New Activity" : "Edit Activity")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        if let a = activity {
                            a.name = trimmed
                            a.colorHex = selectedColor
                            a.icon = selectedIcon
                            a.date = date
                            a.endDate = hasEndDate ? endDate : nil
                            a.activityDescription = activityDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                        } else {
                            let newActivity = Activity(
                                name: trimmed,
                                colorHex: selectedColor,
                                icon: selectedIcon,
                                date: date,
                                endDate: hasEndDate ? endDate : nil,
                                activityDescription: activityDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                            )
                            modelContext.insert(newActivity)
                        }
                        try? modelContext.save()
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                if let a = activity {
                    name = a.name
                    selectedColor = a.colorHex
                    selectedIcon = a.icon
                    date = a.date
                    hasEndDate = a.endDate != nil
                    endDate = a.endDate ?? Date()
                    activityDescription = a.activityDescription
                }
            }
        }
    }
}
