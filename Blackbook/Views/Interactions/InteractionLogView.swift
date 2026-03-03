import SwiftUI
import SwiftData

struct InteractionLogView: View {
    let contact: Contact
    @State private var filterType: InteractionType?
    var filtered: [Interaction] {
        let all = contact.interactions.sorted { $0.date > $1.date }
        if let f = filterType { return all.filter { $0.type == f } }
        return all
    }
    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    FilterChip(label: "All", isSelected: filterType == nil) { filterType = nil }
                    ForEach(InteractionType.allCases) { t in FilterChip(label: t.rawValue, icon: t.icon, isSelected: filterType == t) { filterType = filterType == t ? nil : t } }
                }.padding(.horizontal).padding(.vertical, 8)
            }
            if filtered.isEmpty {
                ContentUnavailableView {
                    Label("No Interactions", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Log your first interaction.")
                }
            }
            else { List { ForEach(filtered) { InteractionRowView(interaction: $0) } }.listStyle(.plain) }
        }.navigationTitle("Interaction History")
    }
}

struct FilterChip: View {
    let label: String; var icon: String? = nil; let isSelected: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) { if let i = icon { Image(systemName: i).font(.caption2) }; Text(label).font(.caption.weight(.medium)) }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(isSelected ? AppConstants.UI.accentGold : Color.secondary.opacity(0.12), in: Capsule())
                .foregroundStyle(isSelected ? .white : .primary)
        }.buttonStyle(.plain)
    }
}
