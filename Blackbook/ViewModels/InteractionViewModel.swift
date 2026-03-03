import Foundation
import Observation
import SwiftData

@Observable
final class InteractionViewModel {
    var filterType: InteractionType?

    func filteredInteractions(for contact: Contact) -> [Interaction] {
        let all = contact.interactions.sorted { $0.date > $1.date }
        if let filter = filterType { return all.filter { $0.type == filter } }
        return all
    }
}
