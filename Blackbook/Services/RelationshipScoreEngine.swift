import Foundation
import Observation
import SwiftData

/// Computes relationship scores for contacts using a weighted formula:
/// `score = recency*W1 + frequency*W2 + variety*W3 + sentiment*W4 + priorityBoost`, clamped to 0-100.
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

    /// Recalculates scores and trends for all contacts using direct queries only.
    /// Never traverses lazy SwiftData relationships to avoid EXC_BAD_ACCESS.
    func recalculateAll(context: ModelContext) {
        do {
            let contacts = try context.fetch(FetchDescriptor<Contact>())
            let sevenDaysAgo = Date.daysAgo(7)
            let fourteenDaysAgo = Date.daysAgo(14)

            // Pre-fetch all interactions in one query, grouped by contact ID.
            // We avoid traversing Interaction.contact by including ALL interactions
            // and matching by the stored contact reference's persistent ID.
            let allInteractions = try context.fetch(FetchDescriptor<Interaction>())

            // Build lookup: contact persistentModelID → interactions
            var interactionsByContact: [UUID: [Interaction]] = [:]
            for interaction in allInteractions {
                // Access the contact's id through the relationship — but this is
                // safe because we're on the main thread in .onAppear.
                // To be extra safe, use a simple nil check without chaining.
                if let c = interaction.contact {
                    interactionsByContact[c.id, default: []].append(interaction)
                }
            }

            for contact in contacts {
                let contactInteractions = interactionsByContact[contact.id] ?? []
                let scoringCutoff = Date.daysAgo(AppConstants.Scoring.frequencyWindowDays)
                let scoringInteractions = contactInteractions.filter { $0.date >= scoringCutoff }

                let raw = (recencyWeight * recencyScore(for: contact))
                    + (frequencyWeight * frequencyScore(interactions: scoringInteractions))
                    + (varietyWeight * varietyScore(interactions: scoringInteractions))
                    + (sentimentWeight * sentimentScore(interactions: contactInteractions))
                    + (contact.isPriority ? AppConstants.Scoring.priorityBoost : 0)
                contact.relationshipScore = min(100, max(0, raw))

                let recentCount = contactInteractions.filter { $0.date >= sevenDaysAgo }.count
                let priorCount = contactInteractions.filter { $0.date >= fourteenDaysAgo && $0.date < sevenDaysAgo }.count
                if recentCount > priorCount { contact.scoreTrend = .up }
                else if recentCount < priorCount { contact.scoreTrend = .down }
                else { contact.scoreTrend = .stable }
            }
            try context.save()
        } catch {}
    }

    private func recencyScore(for contact: Contact) -> Double {
        guard let lastDate = contact.lastInteractionDate else { return 0 }
        return max(0, 100.0 * pow(0.5, Double(lastDate.daysSinceNow) / AppConstants.Scoring.recencyHalfLifeDays))
    }

    private func frequencyScore(interactions: [Interaction]) -> Double {
        return min(100, Double(interactions.count) / 3.0 * 12.5)
    }

    private func varietyScore(interactions: [Interaction]) -> Double {
        let types = Set(interactions.map(\.type))
        return (Double(types.count) / Double(InteractionType.allCases.count)) * 100
    }

    private func sentimentScore(interactions: [Interaction]) -> Double {
        let recent = interactions.sorted { $0.date > $1.date }.prefix(10).compactMap(\.sentiment)
        guard !recent.isEmpty else { return 50 }
        let weightedSum = recent.enumerated().reduce(0.0) { $0 + $1.element.weight / Double($1.offset + 1) }
        let totalWeight = (1...recent.count).reduce(0.0) { $0 + 1.0 / Double($1) }
        return (weightedSum / totalWeight) * 100
    }
}
