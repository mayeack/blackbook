import SwiftUI
import SwiftData

struct LogInteractionView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    let contact: Contact
    @State private var type: InteractionType = .call
    @State private var date = Date()
    @State private var summary = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Type") { Picker("Type", selection: $type) { ForEach(InteractionType.allCases) { Label($0.rawValue, systemImage: $0.icon).tag($0) } }.pickerStyle(.menu).labelsHidden() }
                Section("When") {
                    DatePicker("Date", selection: $date, displayedComponents: .date).labelsHidden()
                }
                Section("Details") { TextField("Summary (optional)", text: $summary, axis: .vertical).lineLimit(3...6) }
            }
            .navigationTitle("Log Interaction")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") {
                    modelContext.insert(Interaction(contact: contact, type: type, date: date, duration: nil, summary: summary.isEmpty ? nil : summary, sentiment: nil))
                    contact.lastInteractionDate = date; contact.updatedAt = Date(); try? modelContext.save(); dismiss()
                } }
            }
        }
    }
}
