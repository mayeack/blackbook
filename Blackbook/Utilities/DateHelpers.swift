import Foundation

extension Date {
    var relativeDescription: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: Date())
    }

    var shortFormatted: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: self)
    }

    var longFormatted: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .short
        return formatter.string(from: self)
    }

    var daysSinceNow: Int {
        Calendar.current.dateComponents([.day], from: self, to: Date()).day ?? 0
    }

    var isToday: Bool { Calendar.current.isDateInToday(self) }

    var isThisWeek: Bool {
        Calendar.current.isDate(self, equalTo: Date(), toGranularity: .weekOfYear)
    }

    var isThisMonth: Bool {
        Calendar.current.isDate(self, equalTo: Date(), toGranularity: .month)
    }

    static func daysAgo(_ days: Int) -> Date {
        Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
    }
}

extension TimeInterval {
    var formattedDuration: String {
        let minutes = Int(self)
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        let rem = minutes % 60
        return rem == 0 ? "\(hours)h" : "\(hours)h \(rem)m"
    }
}
