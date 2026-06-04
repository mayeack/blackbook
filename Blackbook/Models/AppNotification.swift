import Foundation
import SwiftData

/// A persisted, synced notification / suggested action shown in the Overview "Notifications" chiclet.
/// References its target contact by id (no SwiftData relationship — the id is enough to navigate and
/// keeps the model a simple leaf that syncs without dependency ordering).
@Model
final class AppNotification {
    var id: UUID
    var kindRaw: String
    var title: String
    var message: String
    /// The contact this notification points to (for tap-to-navigate). Nil for non-contact notifications.
    var contactId: UUID?
    var createdAt: Date
    var isRead: Bool
    var isDismissed: Bool

    var updatedAt: Date = Date()
    var syncStatus: String = SyncStatus.pending.rawValue
    var lastSyncedAt: Date?

    // MARK: - Source-device provenance

    var createdByDeviceId: String?
    var createdByPlatform: String?
    var createdByDeviceName: String?
    var lastEditedByDeviceId: String?
    var lastEditedByPlatform: String?
    var lastEditedByDeviceName: String?

    /// The category of this notification, driving its icon and any inline action.
    var kind: AppNotificationKind {
        get { AppNotificationKind(rawValue: kindRaw) ?? .fadingRelationship }
        set { kindRaw = newValue.rawValue }
    }

    init(
        kind: AppNotificationKind,
        title: String,
        message: String,
        contactId: UUID? = nil,
        createdAt: Date = Date()
    ) {
        self.id = UUID()
        self.kindRaw = kind.rawValue
        self.title = title
        self.message = message
        self.contactId = contactId
        self.createdAt = createdAt
        self.isRead = false
        self.isDismissed = false
        self.updatedAt = Date()
        self.createdByDeviceId = DeviceIdentity.installId
        self.createdByPlatform = DeviceIdentity.platform
        self.createdByDeviceName = DeviceIdentity.deviceName
        self.lastEditedByDeviceId = DeviceIdentity.installId
        self.lastEditedByPlatform = DeviceIdentity.platform
        self.lastEditedByDeviceName = DeviceIdentity.deviceName
    }

    func markLocallyEdited() {
        updatedAt = Date()
        if syncStatus != SyncStatus.deleted.rawValue {
            syncStatus = SyncStatus.pending.rawValue
        }
        lastEditedByDeviceId = DeviceIdentity.installId
        lastEditedByPlatform = DeviceIdentity.platform
        lastEditedByDeviceName = DeviceIdentity.deviceName
    }
}

/// The source/category of an `AppNotification`.
enum AppNotificationKind: String, Codable, CaseIterable {
    /// A relationship whose score has dropped — suggest reaching out.
    case fadingRelationship
    /// A previously-imported contact no longer found in the address book — suggest archiving.
    case archiveSuggestion

    var icon: String {
        switch self {
        case .fadingRelationship: return "arrow.down.right.circle.fill"
        case .archiveSuggestion: return "archivebox.fill"
        }
    }
}
