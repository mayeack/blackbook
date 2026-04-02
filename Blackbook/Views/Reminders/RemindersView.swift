import SwiftUI
import SwiftData

struct RemindersView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Reminder.dueDate) private var allReminders: [Reminder]
    @State private var filter: ReminderFilter = .upcoming
    enum ReminderFilter: String, CaseIterable, Identifiable { case upcoming = "Upcoming", overdue = "Overdue", completed = "Completed", all = "All"; var id: String { rawValue } }

    var filtered: [Reminder] {
        switch filter {
        case .upcoming: return allReminders.filter { !$0.isCompleted && !$0.isOverdue }
        case .overdue: return allReminders.filter { $0.isOverdue }
        case .completed: return allReminders.filter { $0.isCompleted }
        case .all: return allReminders
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Filter", selection: $filter) { ForEach(ReminderFilter.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented).padding()
            if filtered.isEmpty {
                ContentUnavailableView {
                    Label("No Reminders", systemImage: "bell.slash")
                } description: {
                    Text("No \(filter.rawValue.lowercased()) reminders.")
                }
            }
            else {
                List {
                    ForEach(filtered) { reminder in
                        if let contact = reminder.contact {
                            HStack(spacing: 12) {
                                Button { reminder.isCompleted.toggle(); try? modelContext.save() } label: {
                                    Image(systemName: reminder.isCompleted ? "checkmark.circle.fill" : "circle").font(.title3)
                                        .foregroundStyle(reminder.isCompleted ? .green : reminder.isOverdue ? .red : .secondary)
                                }.buttonStyle(.plain)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(reminder.title).font(.subheadline.weight(.medium)).strikethrough(reminder.isCompleted)
                                    HStack(spacing: 4) { ContactAvatarView(contact: contact, size: 18); Text(contact.displayName).font(.caption).foregroundStyle(.secondary) }
                                }; Spacer()
                                Text(reminder.dueDate.shortFormatted).font(.caption).foregroundStyle(reminder.isOverdue ? .red : .secondary)
                            }.padding(.vertical, 4)
                        }
                    }.onDelete { offsets in for i in offsets { modelContext.delete(filtered[i]) }; try? modelContext.save() }
                }.listStyle(.plain)
            }
        }.navigationTitle("Reminders")
    }
}

struct AddReminderView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    let contact: Contact
    @State private var title = ""
    @State private var dueDate = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    @State private var hasRecurrence = false
    @State private var recurrence: Recurrence = .monthly

    var body: some View {
        NavigationStack {
            Form {
                Section("Reminder") { TextField("Title", text: $title); DatePicker("Due Date", selection: $dueDate, displayedComponents: [.date, .hourAndMinute]) }
                Section("Repeat") { Toggle("Recurring", isOn: $hasRecurrence); if hasRecurrence { Picker("Frequency", selection: $recurrence) { ForEach(Recurrence.allCases) { Text($0.rawValue).tag($0) } } } }
            }
            .navigationTitle("Set Reminder")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") {
                    modelContext.insert(Reminder(contact: contact, title: title, dueDate: dueDate, recurrence: hasRecurrence ? recurrence : nil))
                    try? modelContext.save(); dismiss()
                }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
        }
    }
}
