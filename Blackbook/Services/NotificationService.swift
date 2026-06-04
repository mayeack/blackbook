import Foundation
import SwiftData

/// Generates `AppNotification` records (suggested actions) from app state. Notifications are deduped
/// one-per-contact-per-kind, so re-running is idempotent and a dismissed notification is not recreated.
/// Generation runs on a background context during sync / import; callers save the context.
enum NotificationService {
    /// Cap on new fading notifications created per run, so the chiclet stays a focused suggested-action
    /// list rather than mirroring every below-threshold contact.
    private static let maxNewFadingPerRun = 10

    /// Creates fading-relationship notifications for contacts whose score has slipped below the fading
    /// threshold (but is still > 0 — i.e. previously engaged, now cooling). Mirrors the Dashboard
    /// "Fading Relationships" definition. Returns the number created.
    @discardableResult
    static func generateFadingNotifications(context: ModelContext) -> Int {
        let alreadyNotified = existingContactIDs(ofKind: .fadingRelationship, in: context)

        let threshold = AppConstants.Scoring.fadingThreshold
        let predicate = #Predicate<Contact> {
            !$0.isHidden && !$0.isMergedAway && $0.relationshipScore > 0 && $0.relationshipScore < threshold
        }
        guard let fading = try? context.fetch(FetchDescriptor<Contact>(predicate: predicate)) else { return 0 }

        let candidates = fading
            .filter { !alreadyNotified.contains($0.id) }
            .sorted { $0.relationshipScore < $1.relationshipScore } // most faded first
            .prefix(maxNewFadingPerRun)

        var created = 0
        for contact in candidates {
            context.insert(AppNotification(
                kind: .fadingRelationship,
                title: "Reconnect with \(contact.displayName)",
                message: "This relationship is fading — reach out to stay in touch.",
                contactId: contact.id
            ))
            created += 1
        }
        if created > 0 { try? context.save() }
        return created
    }

    /// Creates an archive-suggestion notification for a contact no longer found in the address book,
    /// unless one already exists for that contact. Does not save (the import flow saves the context).
    @discardableResult
    static func suggestArchive(contactId: UUID, displayName: String, context: ModelContext) -> Bool {
        guard !existingContactIDs(ofKind: .archiveSuggestion, in: context).contains(contactId) else { return false }
        context.insert(AppNotification(
            kind: .archiveSuggestion,
            title: "Archive \(displayName)?",
            message: "No longer in your address book — archive to hide them from your lists.",
            contactId: contactId
        ))
        return true
    }

    /// Contact IDs that already have a notification of the given kind in any state (active or dismissed),
    /// so a dismissed suggestion is never recreated.
    private static func existingContactIDs(ofKind kind: AppNotificationKind, in context: ModelContext) -> Set<UUID> {
        guard let all = try? context.fetch(FetchDescriptor<AppNotification>()) else { return [] }
        return Set(all.filter { $0.kind == kind }.compactMap { $0.contactId })
    }
}
