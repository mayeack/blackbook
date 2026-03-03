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
    }
}
