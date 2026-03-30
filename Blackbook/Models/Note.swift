import Foundation
import SwiftData

/// A free-form text note attached to a contact.
@Model
final class Note {
    var id: UUID
    var contact: Contact?
    var content: String
    var category: NoteCategory?
    var createdAt: Date
    var updatedAt: Date

    var syncStatus: String = SyncStatus.pending.rawValue
    var lastSyncedAt: Date?

    /// Creates a new note for the given contact, defaulting to the general category.
    init(
        contact: Contact,
        content: String,
        category: NoteCategory? = .general
    ) {
        self.id = UUID()
        self.contact = contact
        self.content = content
        self.category = category
        self.createdAt = Date()
        self.updatedAt = Date()
    }
}

/// Classification for notes to aid filtering and display.
enum NoteCategory: String, Codable, CaseIterable, Identifiable {
    case general = "General"
    case personal = "Personal"
    case professional = "Professional"
    case topicDiscussed = "Topic Discussed"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .general: return "note.text"
        case .personal: return "heart.text.square"
        case .professional: return "briefcase"
        case .topicDiscussed: return "bubble.left.and.bubble.right"
        }
    }
}
