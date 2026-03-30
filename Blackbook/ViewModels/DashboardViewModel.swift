import Foundation
import Observation
import SwiftData

/// Provides computed data for the dashboard: fading contacts, birthdays, weekly stats, and score recalculation.
@Observable
final class DashboardViewModel {
    let scoreEngine = RelationshipScoreEngine()
    private var lastScoreRecalculation: Date?
    private static let recalculationCooldown: TimeInterval = 300

    /// Returns contacts with scores below the fading threshold, sorted lowest first.
    func fadingContacts(from contacts: [Contact], limit: Int = 5) -> [Contact] {
        Array(contacts.filter { $0.relationshipScore < AppConstants.Scoring.fadingThreshold && $0.relationshipScore > 0 }
            .sorted { $0.relationshipScore < $1.relationshipScore }.prefix(limit))
    }

    /// Returns contacts whose birthdays fall within the next `withinDays` days.
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

    /// Aggregates this week's interaction counts, unique contacts, and type breakdown.
    func weeklyStats(from contacts: [Contact]) -> WeeklyStats {
        let thisWeek = contacts.flatMap(\.interactions).filter { $0.date.isThisWeek }
        return WeeklyStats(
            totalInteractions: thisWeek.count,
            uniqueContacts: Set(thisWeek.compactMap { $0.contact?.id }).count,
            byType: Dictionary(grouping: thisWeek, by: \.type).mapValues(\.count)
        )
    }

    /// Returns contacts marked as priority, sorted alphabetically.
    func prioritizedContacts(from contacts: [Contact]) -> [Contact] {
        contacts.filter(\.isPriority).sorted { $0.displayName < $1.displayName }
    }

    /// Returns the highest-scoring contacts, up to `limit`.
    func topContacts(from contacts: [Contact], limit: Int = 5) -> [Contact] {
        Array(contacts.sorted { $0.relationshipScore > $1.relationshipScore }.prefix(limit))
    }

    /// Triggers a full score recalculation if at least 5 minutes have elapsed since the last one.
    func recalculateScoresIfNeeded(context: ModelContext) {
        if let last = lastScoreRecalculation,
           Date().timeIntervalSince(last) < Self.recalculationCooldown {
            return
        }
        scoreEngine.recalculateAll(context: context)
        lastScoreRecalculation = Date()
    }
}

/// Summary of interaction activity for the current week.
struct WeeklyStats {
    let totalInteractions: Int; let uniqueContacts: Int; let byType: [InteractionType: Int]
}
