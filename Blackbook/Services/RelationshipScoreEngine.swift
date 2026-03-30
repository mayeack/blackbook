import Foundation
import Observation
import SwiftData

/// Computes relationship scores for contacts using a weighted formula:
/// `score = recency*W1 + frequency*W2 + variety*W3 + sentiment*W4 + priorityBoost + activityBoost`, clamped to 0-100.
@Observable
final class RelationshipScoreEngine {
    private var recencyWeight: Double {
        UserDefaults.standard.object(forKey: "scoring.recencyWeight") as? Double ?? AppConstants.Scoring.recencyWeight
    }
    private var frequencyWeight: Double {
        UserDefaults.standard.object(forKey: "scoring.frequencyWeight") as? Double ?? AppConstants.Scoring.frequencyWeight
    }
    private var varietyWeight: Double {
        UserDefaults.standard.object(forKey: "scoring.varietyWeight") as? Double ?? AppConstants.Scoring.varietyWeight
    }
    private var sentimentWeight: Double {
        UserDefaults.standard.object(forKey: "scoring.sentimentWeight") as? Double ?? AppConstants.Scoring.sentimentWeight
    }

    /// Recalculates scores and trends for all contacts, comparing 7-day interaction counts to determine trend direction.
    func recalculateAll(context: ModelContext) {
        do {
            let contacts = try context.fetch(FetchDescriptor<Contact>())
            let sevenDaysAgo = Date.daysAgo(7)
            let fourteenDaysAgo = Date.daysAgo(14)
            for contact in contacts {
                contact.relationshipScore = calculateScore(for: contact)
                let recentCount = contact.interactions.filter { $0.date >= sevenDaysAgo }.count
                let priorCount = contact.interactions.filter { $0.date >= fourteenDaysAgo && $0.date < sevenDaysAgo }.count
                if recentCount > priorCount { contact.scoreTrend = .up }
                else if recentCount < priorCount { contact.scoreTrend = .down }
                else { contact.scoreTrend = .stable }
            }
            try context.save()
        } catch {}
    }

    /// Returns the composite relationship score (0-100) for a contact using weighted sub-scores plus optional boosts.
    func calculateScore(for contact: Contact) -> Double {
        let raw = (recencyWeight * recencyScore(for: contact))
            + (frequencyWeight * frequencyScore(for: contact))
            + (varietyWeight * varietyScore(for: contact))
            + (sentimentWeight * sentimentScore(for: contact))
            + (contact.isPriority ? AppConstants.Scoring.priorityBoost : 0)
            + activityBoost(for: contact)
        return min(100, max(0, raw))
    }

    private func recencyScore(for contact: Contact) -> Double {
        guard let lastDate = contact.lastInteractionDate else { return 0 }
        return max(0, 100.0 * pow(0.5, Double(lastDate.daysSinceNow) / AppConstants.Scoring.recencyHalfLifeDays))
    }

    private func frequencyScore(for contact: Contact) -> Double {
        let recentCount = contact.interactions.filter { $0.date >= Date.daysAgo(AppConstants.Scoring.frequencyWindowDays) }.count
        return min(100, Double(recentCount) / 3.0 * 12.5)
    }

    private func varietyScore(for contact: Contact) -> Double {
        let types = Set(contact.interactions.filter { $0.date >= Date.daysAgo(AppConstants.Scoring.frequencyWindowDays) }.map(\.type))
        return (Double(types.count) / Double(InteractionType.allCases.count)) * 100
    }

    private func sentimentScore(for contact: Contact) -> Double {
        let recent = contact.interactions.sorted { $0.date > $1.date }.prefix(10).compactMap(\.sentiment)
        guard !recent.isEmpty else { return 50 }
        let weightedSum = recent.enumerated().reduce(0.0) { $0 + $1.element.weight / Double($1.offset + 1) }
        let totalWeight = (1...recent.count).reduce(0.0) { $0 + 1.0 / Double($1) }
        return (weightedSum / totalWeight) * 100
    }

    private func activityBoost(for contact: Contact) -> Double {
        let fadeDays = AppConstants.Scoring.activityFadeDays
        let perEvent = AppConstants.Scoring.activityBoostPerEvent
        let total = contact.activities.reduce(0.0) { sum, activity in
            let daysSince = Double(activity.date.daysSinceNow)
            guard daysSince < fadeDays else { return sum }
            return sum + perEvent * max(0, 1.0 - daysSince / fadeDays)
        }
        return min(total, AppConstants.Scoring.activityBoostCap)
    }
}
