import Foundation
import Observation
import SwiftData

@Observable
final class DashboardViewModel {
    let scoreEngine = RelationshipScoreEngine()
    private var lastScoreRecalculation: Date?
    private static let recalculationCooldown: TimeInterval = 300

    func fadingContacts(from contacts: [Contact], limit: Int = 5) -> [Contact] {
        Array(contacts.filter { $0.relationshipScore < AppConstants.Scoring.fadingThreshold && $0.relationshipScore > 0 }
            .sorted { $0.relationshipScore < $1.relationshipScore }.prefix(limit))
    }

    func upcomingBirthdays(from contacts: [Contact], withinDays: Int = 30) -> [Contact] {
        let cal = Calendar.current
        let today = cal.dateComponents([.month, .day], from: Date())
        return contacts.filter { c in
            guard let bday = c.birthday else { return false }
            let b = cal.dateComponents([.month, .day], from: bday)
            guard let tm = today.month, let td = today.day, let bm = b.month, let bd = b.day else { return false }
            var diff = (bm * 31 + bd) - (tm * 31 + td)
            if diff < 0 { diff += 12 * 31 }
            return diff <= withinDays
        }
    }

    func weeklyStats(from contacts: [Contact]) -> WeeklyStats {
        let thisWeek = contacts.flatMap(\.interactions).filter { $0.date.isThisWeek }
        return WeeklyStats(
            totalInteractions: thisWeek.count,
            uniqueContacts: Set(thisWeek.compactMap { $0.contact?.id }).count,
            byType: Dictionary(grouping: thisWeek, by: \.type).mapValues(\.count)
        )
    }

    func prioritizedContacts(from contacts: [Contact]) -> [Contact] {
        contacts.filter(\.isPriority).sorted { $0.displayName < $1.displayName }
    }

    func topContacts(from contacts: [Contact], limit: Int = 5) -> [Contact] {
        Array(contacts.sorted { $0.relationshipScore > $1.relationshipScore }.prefix(limit))
    }

    func recalculateScoresIfNeeded(context: ModelContext) {
        if let last = lastScoreRecalculation,
           Date().timeIntervalSince(last) < Self.recalculationCooldown {
            return
        }
        scoreEngine.recalculateAll(context: context)
        lastScoreRecalculation = Date()
    }
}

struct WeeklyStats {
    let totalInteractions: Int; let uniqueContacts: Int; let byType: [InteractionType: Int]
}
