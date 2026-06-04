import Foundation
import SwiftData

@Observable
final class ContactListViewModel {
    var searchText = ""
    var selectedTags: Set<UUID> = []
    var selectedGroups: Set<UUID> = []
    var selectedLocations: Set<UUID> = []
    var sortColumn: SortColumn = .name
    var sortAscending = true

    /// A sortable column. The first seven map to the table headers; `recent` / `dateAdded` are
    /// extra sorts offered in the sort menu.
    enum SortColumn: String, CaseIterable, Identifiable {
        case name = "Name"
        case groups = "Groups"
        case locations = "Locations"
        case tags = "Tags"
        case metVia = "Met via"
        case introducedTo = "Introduced to"
        case score = "Score"
        case recent = "Recent"
        case dateAdded = "Added"
        var id: String { rawValue }

        /// Numeric columns default to descending (highest / most-recent first) on first selection.
        var defaultsDescending: Bool {
            switch self {
            case .score, .recent, .dateAdded: return true
            default: return false
            }
        }
    }

    var showHidden = false

    /// Click a column header (or pick a sort): selects the column, or toggles direction if it's
    /// already the active column.
    func toggleSort(_ column: SortColumn) {
        if sortColumn == column {
            sortAscending.toggle()
        } else {
            sortColumn = column
            sortAscending = !column.defaultsDescending
        }
    }

    /// Filters contacts by search text, selected tags/groups/locations, and hidden state, then sorts
    /// by the active column + direction.
    func filteredContacts(_ contacts: [Contact], tags: [Tag], groups: [Group] = [], locations: [Location] = []) -> [Contact] {
        var result = showHidden ? contacts.filter { !$0.isMergedAway } : contacts.selectable
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
        return sorted(result)
    }

    // MARK: - Sorting

    private func sorted(_ contacts: [Contact]) -> [Contact] {
        switch sortColumn {
        case .name:
            return contacts.sorted { directionalNameLess($0, $1) }
        case .score:
            return contacts.sorted { numericLess($0, $1, key: { $0.relationshipScore }) }
        case .recent:
            return contacts.sorted { numericLess($0, $1, key: { $0.lastInteractionDate?.timeIntervalSince1970 ?? -.greatestFiniteMagnitude }) }
        case .dateAdded:
            return contacts.sorted { numericLess($0, $1, key: { $0.createdAt.timeIntervalSince1970 }) }
        case .groups, .locations, .tags, .metVia, .introducedTo:
            return contacts.sorted { stringLess($0, $1) }
        }
    }

    /// A→Z by last name (blank last names last), first name as tiebreak; reversed when descending.
    private func directionalNameLess(_ a: Contact, _ b: Contact) -> Bool {
        let aEmpty = a.lastName.isEmpty, bEmpty = b.lastName.isEmpty
        if aEmpty != bEmpty { return bEmpty } // blank last names always sort to the bottom
        let cmp = a.lastName.localizedCaseInsensitiveCompare(b.lastName)
        if cmp == .orderedSame {
            return a.firstName.localizedCaseInsensitiveCompare(b.firstName) == .orderedAscending
        }
        return sortAscending ? (cmp == .orderedAscending) : (cmp == .orderedDescending)
    }

    private func numericLess(_ a: Contact, _ b: Contact, key: (Contact) -> Double) -> Bool {
        let ka = key(a), kb = key(b)
        if ka == kb { return nameAscending(a, b) }
        return sortAscending ? ka < kb : ka > kb
    }

    /// Sort by the active string-valued column. Empty values always sort to the bottom; ties fall
    /// back to alphabetical name order.
    private func stringLess(_ a: Contact, _ b: Contact) -> Bool {
        let ka = stringKey(a), kb = stringKey(b)
        if ka.isEmpty != kb.isEmpty { return kb.isEmpty } // non-empty before empty, regardless of direction
        let cmp = ka.localizedCaseInsensitiveCompare(kb)
        if cmp == .orderedSame { return nameAscending(a, b) }
        return sortAscending ? (cmp == .orderedAscending) : (cmp == .orderedDescending)
    }

    private func stringKey(_ c: Contact) -> String {
        switch sortColumn {
        case .groups: return c.groups.map(\.name).min(by: caseInsensitiveLess) ?? ""
        case .locations: return c.locations.map(\.name).min(by: caseInsensitiveLess) ?? ""
        case .tags: return c.tags.map(\.name).min(by: caseInsensitiveLess) ?? ""
        case .metVia: return c.metVia?.displayName ?? ""
        case .introducedTo: return c.metViaBacklinks.map(\.displayName).min(by: caseInsensitiveLess) ?? ""
        default: return ""
        }
    }

    private func caseInsensitiveLess(_ a: String, _ b: String) -> Bool {
        a.localizedCaseInsensitiveCompare(b) == .orderedAscending
    }

    private func nameAscending(_ a: Contact, _ b: Contact) -> Bool {
        let cmp = a.lastName.localizedCaseInsensitiveCompare(b.lastName)
        if cmp != .orderedSame { return cmp == .orderedAscending }
        return a.firstName.localizedCaseInsensitiveCompare(b.firstName) == .orderedAscending
    }
}
