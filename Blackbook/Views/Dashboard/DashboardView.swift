import SwiftUI
import SwiftData

struct DashboardView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Contact.relationshipScore, order: .reverse) private var allContacts: [Contact]
    @Query(sort: \Reminder.dueDate) private var reminders: [Reminder]
    @State private var viewModel = DashboardViewModel()
    @State private var showingPrioritizePicker = false
    private var contacts: [Contact] { allContacts.filter { !$0.isHidden && !$0.isMergedAway } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    weeklyStatsCard; prioritizeCard; fadingCard; remindersCard; aiCard; topContactsCard
                }.padding()
            }
            .navigationTitle("Overview")
            .task { viewModel.recalculateScoresIfNeeded(context: modelContext) }
            .sheet(isPresented: $showingPrioritizePicker) {
                PrioritizeContactPicker(contacts: contacts.filter { !$0.isPriority })
            }
        }
    }

    private var weeklyStatsCard: some View {
        let s = viewModel.weeklyStats(from: contacts)
        return DashboardCard(title: "This Week", icon: "chart.bar.fill") {
            HStack(spacing: 24) { StatBubble(value: "\(s.totalInteractions)", label: "Interactions"); StatBubble(value: "\(s.uniqueContacts)", label: "People") }
        }
    }

    private var prioritizeCard: some View {
        let prioritized = viewModel.prioritizedContacts(from: contacts)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "pin.fill").foregroundStyle(AppConstants.UI.accentGold)
                Text("Prioritize").font(.title.weight(.bold))
            }
            if prioritized.isEmpty {
                Button { showingPrioritizePicker = true } label: {
                    AddContactChip()
                }
                .buttonStyle(.plain)
            } else {
                PriorityChipFlowLayout(spacing: 12) {
                    ForEach(prioritized) { contact in
                        PriorityContactChip(contact: contact) {
                            withAnimation { contact.isPriority = false }
                        }
                    }
                    Button { showingPrioritizePicker = true } label: {
                        AddContactChip()
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 14))
    }

    private var fadingCard: some View {
        let fading = viewModel.fadingContacts(from: contacts)
        return DashboardCard(title: "Fading Relationships", icon: "arrow.down.right.circle.fill", iconColor: AppConstants.UI.fadingRed) {
            if fading.isEmpty { Text("All relationships are healthy").font(.subheadline).foregroundStyle(.secondary).padding(.vertical, 8) }
            else {
                PriorityChipFlowLayout(spacing: 12) {
                    ForEach(fading) { contact in
                        ContactChip(contact: contact)
                    }
                }
            }
        }
    }

    private var remindersCard: some View {
        let upcoming = Array(reminders.filter { !$0.isCompleted }.prefix(5))
        return DashboardCard(title: "Upcoming Reminders", icon: "bell.fill", iconColor: AppConstants.UI.accentGold) {
            if upcoming.isEmpty { Text("No upcoming reminders").font(.subheadline).foregroundStyle(.secondary).padding(.vertical, 8) }
            else { VStack(spacing: 6) { ForEach(upcoming) { r in HStack { VStack(alignment: .leading, spacing: 1) { Text(r.title).font(.subheadline).lineLimit(1); if let c = r.contact { Text(c.displayName).font(.caption).foregroundStyle(.secondary) } }; Spacer(); Text(r.dueDate.relativeDescription).font(.caption).foregroundStyle(r.isOverdue ? .red : .secondary) } } } }
        }
    }

    private var aiCard: some View {
        DashboardCard(title: "AI Assistant", icon: "sparkles", iconColor: .purple) {
            NavigationLink { AIInsightsView() } label: {
                HStack { Text("Get AI-powered outreach suggestions").font(.subheadline).foregroundStyle(.secondary); Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
            }.buttonStyle(.plain)
        }
    }

    private var topContactsCard: some View {
        let top = viewModel.topContacts(from: contacts)
        return DashboardCard(title: "Strongest Relationships", icon: "star.fill", iconColor: AppConstants.UI.strongGreen) {
            if top.isEmpty { Text("Add contacts to see top relationships").font(.subheadline).foregroundStyle(.secondary) }
            else {
                PriorityChipFlowLayout(spacing: 12) {
                    ForEach(top) { contact in
                        ContactChip(contact: contact)
                    }
                }
            }
        }
    }
}

struct DashboardCard<Content: View>: View {
    let title: String; let icon: String; var iconColor: Color = AppConstants.UI.accentGold; @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { HStack(spacing: 8) { Image(systemName: icon).foregroundStyle(iconColor); Text(title).font(.title.weight(.bold)) }; content() }
            .frame(maxWidth: .infinity, alignment: .leading).padding().background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct StatBubble: View {
    let value: String; let label: String
    var body: some View { VStack(spacing: 2) { Text(value).font(.title2.weight(.bold).monospacedDigit()); Text(label).font(.caption).foregroundStyle(.secondary) } }
}

// MARK: - Prioritize Components

struct PriorityContactChip: View {
    let contact: Contact
    let onRemove: () -> Void

    var body: some View {
        VStack(spacing: 4) {
            ZStack(alignment: .topTrailing) {
                ContactAvatarView(contact: contact, size: 56)
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.white, Color.secondary)
                }
                .buttonStyle(.plain)
                .offset(x: 4, y: -4)
            }
            Text(contact.displayName).font(.caption).lineLimit(2).multilineTextAlignment(.center)
                .frame(height: 32, alignment: .top)
            ScoreBadgeView(score: contact.relationshipScore)
        }
        .frame(width: 72)
    }
}

struct ContactChip: View {
    let contact: Contact

    var body: some View {
        VStack(spacing: 4) {
            ContactAvatarView(contact: contact, size: 56)
            Text(contact.displayName).font(.caption).lineLimit(2).multilineTextAlignment(.center)
                .frame(height: 32, alignment: .top)
            ScoreBadgeView(score: contact.relationshipScore)
        }
        .frame(width: 72)
    }
}

struct AddContactChip: View {
    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .strokeBorder(AppConstants.UI.accentGold, style: StrokeStyle(lineWidth: 2, dash: [5, 3]))
                    .frame(width: 56, height: 56)
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(AppConstants.UI.accentGold)
            }
            Text("Add Contact").font(.caption).lineLimit(2).multilineTextAlignment(.center)
                .foregroundStyle(AppConstants.UI.accentGold)
                .frame(height: 32, alignment: .top)
        }
        .frame(width: 72)
    }
}

struct PriorityChipFlowLayout: Layout {
    var spacing: CGFloat = 12

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = layout(in: proposal.width ?? 0, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layout(in: bounds.width, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y), proposal: .unspecified)
        }
    }

    private func layout(in availableWidth: CGFloat, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > availableWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            maxWidth = max(maxWidth, x - spacing)
        }

        return (CGSize(width: maxWidth, height: y + rowHeight), positions)
    }
}

struct PrioritizeContactPicker: View {
    @Environment(\.dismiss) private var dismiss
    let contacts: [Contact]
    @State private var searchText = ""

    private var filtered: [Contact] {
        if searchText.isEmpty { return contacts }
        let query = searchText.lowercased()
        return contacts.filter { $0.displayName.lowercased().contains(query) }
    }

    var body: some View {
        NavigationStack {
            List(filtered) { contact in
                Button {
                    withAnimation { contact.isPriority = true }
                    dismiss()
                } label: {
                    HStack(spacing: 12) {
                        ContactAvatarView(contact: contact, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(contact.displayName).font(.body.weight(.medium))
                            if let company = contact.company, !company.isEmpty {
                                Text(company).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        ScoreBadgeView(score: contact.relationshipScore)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .searchable(text: $searchText, prompt: "Search contacts")
            .navigationTitle("Add to Prioritize")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, minHeight: 500)
        #endif
    }
}
