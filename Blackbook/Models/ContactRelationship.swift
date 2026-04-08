import Foundation
import SwiftData

@Model
final class ContactRelationship {
    var id: UUID
    var fromContact: Contact?
    var toContact: Contact?
    var label: String?
    var strength: Double?

    var updatedAt: Date
    var syncStatus: String = SyncStatus.pending.rawValue
    var lastSyncedAt: Date?

    init(
        from: Contact,
        to: Contact,
        label: String? = nil,
        strength: Double? = nil
    ) {
        self.id = UUID()
        self.fromContact = from
        self.toContact = to
        self.label = label
        self.strength = strength
        self.updatedAt = Date()
    }
}
