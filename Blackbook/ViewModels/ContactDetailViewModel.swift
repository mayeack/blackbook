import Foundation
import Observation
import SwiftData

@Observable
final class ContactDetailViewModel {
    var showLogInteraction = false
    var showAddNote = false
    var showAddReminder = false
    var showEditContact = false
    var showMergeContact = false
    var selectedNoteCategory: NoteCategory? = nil

    func filteredNotes(for contact: Contact) -> [Note] {
        let notes = contact.notes
        if let cat = selectedNoteCategory { return notes.filter { $0.category == cat }.sorted { $0.createdAt > $1.createdAt } }
        return notes.sorted { $0.createdAt > $1.createdAt }
    }

    func interactionStats(for contact: Contact) -> InteractionStats {
        let all = contact.interactions
        let typeCounts = Dictionary(grouping: all, by: \.type).mapValues(\.count)
        let recentCount = all.filter { $0.date >= Date.daysAgo(90) }.count
        return InteractionStats(totalCount: all.count, mostCommonType: typeCounts.max { $0.value < $1.value }?.key, monthlyFrequency: Double(recentCount) / 3.0)
    }

    func deleteContact(_ contact: Contact, context: ModelContext) {
        context.delete(contact); try? context.save()
    }
}

struct InteractionStats {
    let totalCount: Int; let mostCommonType: InteractionType?; let monthlyFrequency: Double
    var frequencyDescription: String {
        if monthlyFrequency >= 8 { return "Very Active" }
        else if monthlyFrequency >= 4 { return "Active" }
        else if monthlyFrequency >= 1 { return "Moderate" }
        else { return "Low" }
    }
}
