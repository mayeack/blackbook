import Foundation
import Observation
import SwiftData

/// Computes relationship scores for contacts using a weighted formula:
/// `score = recency*W + priorityBoost`, clamped to 0-100.
/// Frequency, variety, and sentiment scoring require interaction data
/// which is computed lazily when viewing individual contact details.
@Observable
final class RelationshipScoreEngine {
    private var recencyWeight: Double {
        UserDefaults.standard.object(forKey: "scoring.recencyWeight") as? Double ?? AppConstants.Scoring.recencyWeight
    }

    /// Recalculates scores and trends for all contacts using only direct
    /// Contact properties. Never accesses lazy SwiftData relationships.
    func recalculateAll(context: ModelContext) {
        do {
            let contacts = try context.fetch(FetchDescriptor<Contact>())
            let sevenDaysAgo = Date.daysAgo(7)

            for contact in contacts {
                // Score based on recency of last interaction + priority boost
                var score: Double = 0
                if let lastDate = contact.lastInteractionDate {
                    score = max(0, 100.0 * pow(0.5, Double(lastDate.daysSinceNow) / AppConstants.Scoring.recencyHalfLifeDays))
                }
                if contact.isPriority {
                    score += AppConstants.Scoring.priorityBoost
                }
                contact.relationshipScore = min(100, max(0, score))

                // Trend: had recent interaction = up, no recent = stable/down
                if let lastDate = contact.lastInteractionDate {
                    if lastDate >= sevenDaysAgo {
                        contact.scoreTrend = .up
                    } else if lastDate >= Date.daysAgo(14) {
                        contact.scoreTrend = .stable
                    } else {
                        contact.scoreTrend = .down
                    }
                } else {
                    contact.scoreTrend = .stable
                }
            }
            try context.save()
        } catch {}
    }
}
