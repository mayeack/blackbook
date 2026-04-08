import Foundation
import SwiftData
import SwiftUI

@Model
final class Group {
    var id: UUID
    var name: String
    var colorHex: String
    var icon: String
    var contacts: [Contact]

    @Relationship(inverse: \Activity.groups)
    var activities: [Activity]

    var updatedAt: Date
    var syncStatus: String = SyncStatus.pending.rawValue
    var lastSyncedAt: Date?

    var color: Color {
        Color(hex: colorHex) ?? .accentColor
    }

    init(name: String, colorHex: String = "3498DB", icon: String = "folder") {
        self.id = UUID()
        self.name = name
        self.colorHex = colorHex
        self.icon = icon
        self.contacts = []
        self.activities = []
        self.updatedAt = Date()
    }
}
