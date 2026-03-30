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
    var showTagPicker = false
    var showGroupPicker = false
    var showLocationPicker = false
    var selectedNoteCategory: NoteCategory? = nil

    /// Returns the contact's notes filtered by the selected category (if any), sorted newest first.
    func filteredNotes(for contact: Contact) -> [Note] {
        let notes = contact.notes
        if let cat = selectedNoteCategory { return notes.filter { $0.category == cat }.sorted { $0.createdAt > $1.createdAt } }
        return notes.sorted { $0.createdAt > $1.createdAt }
    }

    /// Computes interaction statistics: total count, most common type, and average monthly frequency over the last 90 days.
    func interactionStats(for contact: Contact) -> InteractionStats {
        let all = contact.interactions
        let typeCounts = Dictionary(grouping: all, by: \.type).mapValues(\.count)
        let recentCount = all.filter { $0.date >= Date.daysAgo(90) }.count
        return InteractionStats(totalCount: all.count, mostCommonType: typeCounts.max { $0.value < $1.value }?.key, monthlyFrequency: Double(recentCount) / 3.0)
    }

    /// Permanently deletes the contact from the model context.
    func deleteContact(_ contact: Contact, context: ModelContext) {
        context.delete(contact); try? context.save()
    }
}

/// Summarizes a contact's interaction history: total count, dominant type, and monthly frequency.
struct InteractionStats {
    let totalCount: Int; let mostCommonType: InteractionType?; let monthlyFrequency: Double
    /// Human-readable label for the monthly frequency: "Very Active", "Active", "Moderate", or "Low".
    var frequencyDescription: String {
        if monthlyFrequency >= 8 { return "Very Active" }
        else if monthlyFrequency >= 4 { return "Active" }
        else if monthlyFrequency >= 1 { return "Moderate" }
        else { return "Low" }
    }
}
