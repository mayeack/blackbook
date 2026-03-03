import SwiftUI
import SwiftData

struct SmartGroupsView: View {
    @Query(sort: \Contact.lastName) private var contacts: [Contact]
    private var visibleContacts: [Contact] { contacts.filter { !$0.isHidden && !$0.isMergedAway } }
    var body: some View {
        List {
            group("Fading Relationships", icon: "arrow.down.right.circle", color: AppConstants.UI.fadingRed,
                  contacts: visibleContacts.filter { $0.relationshipScore < 30 && $0.relationshipScore > 0 })
            group("No Contact in 60+ Days", icon: "clock.badge.exclamationmark", color: .orange,
                  contacts: visibleContacts.filter { guard let l = $0.lastInteractionDate else { return true }; return l.daysSinceNow > 60 })
            group("Birthday This Month", icon: "gift", color: .pink, contacts: visibleContacts.filter { $0.birthday?.isThisMonth ?? false })
            group("Priority Contacts", icon: "star.fill", color: AppConstants.UI.accentGold, contacts: visibleContacts.filter(\.isPriority))
            group("Untagged", icon: "tag.slash", color: .secondary, contacts: visibleContacts.filter { $0.tags.isEmpty })
            group("Ungrouped", icon: "folder.badge.questionmark", color: .secondary, contacts: visibleContacts.filter { $0.groups.isEmpty })
        }.navigationTitle("Smart Groups")
    }
    @ViewBuilder func group(_ title: String, icon: String, color: Color, contacts: [Contact]) -> some View {
        if !contacts.isEmpty {
            Section {
                NavigationLink { List { ForEach(contacts) { c in NavigationLink(value: c.id) { ContactRowView(contact: c) } } }.navigationTitle(title)
                    .navigationDestination(for: UUID.self) { id in if let c = contacts.first(where: { $0.id == id }) { ContactDetailView(contact: c) } }
                } label: { HStack { Label(title, systemImage: icon).foregroundStyle(color); Spacer(); Text("\(contacts.count)").font(.caption).foregroundStyle(.secondary) } }
            }
        }
    }
}
