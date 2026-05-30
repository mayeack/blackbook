import Foundation
import SwiftData

@Model
final class RejectedCalendarEvent {
    var id: UUID
    var googleEventId: String
    var title: String
    var eventDate: Date
    var calendarName: String
    var rejectedAt: Date

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

    init(
        googleEventId: String,
        title: String,
        eventDate: Date,
        calendarName: String
    ) {
        self.id = UUID()
        self.googleEventId = googleEventId
        self.title = title
        self.eventDate = eventDate
        self.calendarName = calendarName
        self.rejectedAt = Date()
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
