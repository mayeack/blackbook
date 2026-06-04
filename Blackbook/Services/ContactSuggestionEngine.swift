import Foundation

/// Ranks contacts to surface as "suggested" records when picking a contact for a relationship field
/// (e.g. "Introduced to", "Met via"). Suggestions are a function of contextual similarity to the
/// subject — shared tags, groups, and locations — plus a per-field signal, so the user usually finds
/// the right person without typing. Falls back to highest relationship score when there's no overlap,
/// so the picker can *always* offer suggestions.
enum ContactSuggestionEngine {

    /// The field a suggestion is being made for. Each field weights the similarity signals differently.
    enum Field {
        /// People the subject introduced you to (`metViaBacklinks`).
        case introducedTo
        /// The person who introduced you to the subject (`metVia`).
        case metVia
    }

    /// Returns up to `limit` suggested contacts for `subject` in `field`, ranked by similarity.
    ///
    /// - Parameters:
    ///   - subject: the contact whose field is being edited.
    ///   - field: which relationship field the suggestions are for.
    ///   - candidates: the pool to draw from (hidden / merged-away are filtered out here).
    ///   - excluding: contact IDs to omit (e.g. already-selected, the subject itself).
    ///   - limit: maximum number of suggestions (default 3).
    static func suggestions(
        for subject: Contact,
        field: Field,
        from candidates: [Contact],
        excluding: Set<UUID> = [],
        limit: Int = 3
    ) -> [Contact] {
        let subjectTags = Set(subject.tags.map(\.id))
        let subjectGroups = Set(subject.groups.map(\.id))
        let subjectLocations = Set(subject.locations.map(\.id))

        func similarity(_ c: Contact) -> Double {
            var score = 0.0
            score += Double(Set(c.tags.map(\.id)).intersection(subjectTags).count) * 3
            score += Double(Set(c.groups.map(\.id)).intersection(subjectGroups).count) * 2
            score += Double(Set(c.locations.map(\.id)).intersection(subjectLocations).count) * 2
            switch field {
            case .metVia:
                // A likely connector shares the same introducer as the subject.
                if let mv = c.metVia?.id, mv == subject.metVia?.id { score += 1 }
            case .introducedTo:
                // People you'd introduce tend to be already linked to the subject either way.
                if c.metVia?.id == subject.id || subject.metVia?.id == c.id { score += 1 }
            }
            return score
        }

        let pool = candidates.selectable.filter { $0.id != subject.id && !excluding.contains($0.id) }
        return pool
            .map { (contact: $0, score: similarity($0)) }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                if lhs.contact.relationshipScore != rhs.contact.relationshipScore {
                    return lhs.contact.relationshipScore > rhs.contact.relationshipScore
                }
                return lhs.contact.displayName.localizedCaseInsensitiveCompare(rhs.contact.displayName) == .orderedAscending
            }
            .prefix(limit)
            .map(\.contact)
    }
}
