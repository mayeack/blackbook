import Foundation
import SwiftData
import SwiftUI

@Model
final class Activity {
    var id: UUID
    var name: String
    var colorHex: String
    var icon: String
    var date: Date
    var endDate: Date?
    var activityDescription: String
    var createdAt: Date
    var googleEventId: String?
    var contacts: [Contact]
    var groups: [Group]

    var color: Color {
        Color(hex: colorHex) ?? .accentColor
    }

    var dateRange: String {
        if let endDate {
            return "\(date.shortFormatted) – \(endDate.shortFormatted)"
        }
        return date.shortFormatted
    }

    init(
        name: String,
        colorHex: String = "3498DB",
        icon: String = "figure.run",
        date: Date = Date(),
        endDate: Date? = nil,
        activityDescription: String = ""
    ) {
        self.id = UUID()
        self.name = name
        self.colorHex = colorHex
        self.icon = icon
        self.date = date
        self.endDate = endDate
        self.activityDescription = activityDescription
        self.createdAt = Date()
        self.contacts = []
        self.groups = []
    }
}
