import Foundation
import SwiftData
import SwiftUI

@Model
final class Location {
    var id: UUID
    var name: String
    var colorHex: String
    var icon: String
    var contacts: [Contact]

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

    var color: Color {
        Color(hex: colorHex) ?? .accentColor
    }

    init(name: String, colorHex: String = "3498DB", icon: String = "mappin") {
        self.id = UUID()
        self.name = name
        self.colorHex = colorHex
        self.icon = icon
        self.contacts = []
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
