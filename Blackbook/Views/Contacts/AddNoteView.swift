import SwiftUI
import SwiftData

struct AddNoteView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    let contact: Contact
    @State private var content = ""
    @State private var category: NoteCategory = .general

    var body: some View {
        NavigationStack {
            Form {
                Section("Category") {
                    Picker("Category", selection: $category) { ForEach(NoteCategory.allCases) { Label($0.rawValue, systemImage: $0.icon).tag($0) } }.pickerStyle(.menu)
                }
                Section("Note") { TextEditor(text: $content).frame(minHeight: 150) }
            }
            .navigationTitle("Add Note")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { modelContext.insert(Note(contact: contact, content: content, category: category)); contact.updatedAt = Date(); try? modelContext.save(); dismiss() }.disabled(content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
        }
    }
}
