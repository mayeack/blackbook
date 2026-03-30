import Foundation
import SwiftData
import SwiftUI

@Observable
final class ContactListViewModel {
    var searchText = ""
    var selectedTags: Set<UUID> = []
    var selectedGroups: Set<UUID> = []
    var selectedLocations: Set<UUID> = []
    var sortOrder: ContactSortOrder = .name

    /// Available sort orders for the contact list.
    enum ContactSortOrder: String, CaseIterable, Identifiable {
        case name = "Name", score = "Score", recentInteraction = "Recent", dateAdded = "Added"
        var id: String { rawValue }
    }

    var showHidden = false

    /// Filters contacts by search text, selected tags/groups/locations, and hidden state, then sorts by the current sort order.
    func filteredContacts(_ contacts: [Contact], tags: [Tag], groups: [Group] = [], locations: [Location] = []) -> [Contact] {
        var result = showHidden ? contacts.filter { !$0.isMergedAway } : contacts.filter { !$0.isHidden && !$0.isMergedAway }
        if !searchText.isEmpty {
            let q = searchText.lowercased()
            result = result.filter {
                $0.displayName.localizedCaseInsensitiveContains(q) ||
                ($0.company?.localizedCaseInsensitiveContains(q) ?? false)
            }
        }
        if !selectedTags.isEmpty {
            result = result.filter { !Set($0.tags.map(\.id)).isDisjoint(with: selectedTags) }
        }
        if !selectedGroups.isEmpty {
            result = result.filter { !Set($0.groups.map(\.id)).isDisjoint(with: selectedGroups) }
        }
        if !selectedLocations.isEmpty {
            result = result.filter { !Set($0.locations.map(\.id)).isDisjoint(with: selectedLocations) }
        }
        switch sortOrder {
        case .name: return result.sorted {
            let lhs = $0.lastName.isEmpty
            let rhs = $1.lastName.isEmpty
            if lhs != rhs { return rhs }
            let lastCmp = $0.lastName.localizedCaseInsensitiveCompare($1.lastName)
            if lastCmp != .orderedSame { return lastCmp == .orderedAscending }
            return $0.firstName.localizedCaseInsensitiveCompare($1.firstName) == .orderedAscending
        }
        case .score: return result.sorted { $0.relationshipScore > $1.relationshipScore }
        case .recentInteraction: return result.sorted { ($0.lastInteractionDate ?? .distantPast) > ($1.lastInteractionDate ?? .distantPast) }
        case .dateAdded: return result.sorted { $0.createdAt > $1.createdAt }
        }
    }
}
