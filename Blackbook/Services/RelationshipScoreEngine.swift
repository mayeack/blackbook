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

    /// Recalculates scores and trends for all contacts.
    ///
    /// First re-derives each contact's `lastInteractionDate` from its actual `Interaction`
    /// records on *this* device, then scores from that field. This decouples the score from
    /// cross-device propagation of the denormalized `lastInteractionDate`: synced interaction
    /// rows arrive cleanly, but the contact-field update can be rejected by conflict resolution
    /// (`ContactSyncApply.applyRemoteContact`) when the local copy is newer + pending, leaving
    /// recency stuck at 0 even though the texts are present (work_log: Hugo Dooner).
    ///
    /// We deliberately read interactions via a single `FetchDescriptor<Interaction>` and group
    /// by the to-one `interaction.contact?.id` — the same controlled service-side pattern used
    /// by the server's `IMessageSyncService`. We never touch the `Contact.interactions` to-many
    /// inverse, which is what faults under `@Query` re-renders (work_log 2026-06-01/02).
    func recalculateAll(context: ModelContext) {
        do {
            let contacts = try context.fetch(FetchDescriptor<Contact>())
            let sevenDaysAgo = Date.daysAgo(7)

            // Latest interaction date per contact, derived from the records this device holds.
            var latestInteraction: [UUID: Date] = [:]
            for ix in try context.fetch(FetchDescriptor<Interaction>()) {
                guard let cid = ix.contact?.id else { continue }
                if let current = latestInteraction[cid] {
                    if ix.date > current { latestInteraction[cid] = ix.date }
                } else {
                    latestInteraction[cid] = ix.date
                }
            }

            for contact in contacts {
                // Heal a stale/missing denormalized date from real interaction records.
                // Local-only correction — no markLocallyEdited(); each device derives its own.
                if let derived = latestInteraction[contact.id],
                   contact.lastInteractionDate == nil || derived > contact.lastInteractionDate! {
                    contact.lastInteractionDate = derived
                }

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
