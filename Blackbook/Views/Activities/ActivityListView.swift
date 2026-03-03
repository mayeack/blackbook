import SwiftUI
import SwiftData

struct ActivityListView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Activity.date, order: .reverse) private var activities: [Activity]
    @Query private var rejectedEvents: [RejectedCalendarEvent]
    @State private var searchText = ""
    @State private var showAddActivity = false
    @State private var calendarService = GoogleCalendarService()

    private var filteredActivities: [Activity] {
        if searchText.isEmpty { return activities }
        return activities.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var rejectedEventIds: Set<String> {
        Set(rejectedEvents.map(\.googleEventId))
    }

    private var existingActivityEventIds: Set<String> {
        Set(activities.compactMap { activity -> String? in
            guard activity.icon == "calendar" else { return nil }
            return activity.googleEventId
        })
    }

    private var visibleSuggestions: [SuggestedCalendarEvent] {
        calendarService.suggestedEvents.filter { event in
            !existingActivityEventIds.contains(event.id)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Top half: existing activities or empty state
                SwiftUI.Group {
                    if filteredActivities.isEmpty {
                        ContentUnavailableView {
                            Label("No Activities", systemImage: "figure.run")
                        } description: {
                            Text("Create activities to track events with your contacts and groups.")
                        } actions: {
                            Button("New Activity") { showAddActivity = true }
                                .buttonStyle(.borderedProminent)
                                .tint(AppConstants.UI.accentGold)
                        }
                    } else {
                        List {
                            Button { showAddActivity = true } label: {
                                Label("Add Activity", systemImage: "plus.circle.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(AppConstants.UI.accentGold)
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)

                            activitiesSection
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                // Bottom half: suggested activities
                suggestedActivitiesPanel
            }
            .navigationDestination(for: UUID.self) { id in
                if let activity = activities.first(where: { $0.id == id }) {
                    ActivityDetailView(activity: activity)
                }
            }
            .navigationTitle("Activities")
            .searchable(text: $searchText, prompt: "Search activities...")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAddActivity = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showAddActivity) { ActivityFormView(activity: nil) }
            .task {
                await calendarService.fetchCalendarList()
                await calendarService.fetchEvents(rejectedEventIds: rejectedEventIds)
            }
            .refreshable {
                await calendarService.fetchCalendarList()
                await calendarService.fetchEvents(rejectedEventIds: rejectedEventIds, force: true)
            }
        }
    }

    // MARK: - Suggested Activities

    private var suggestedActivitiesPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()

            HStack(spacing: 6) {
                Image(systemName: "calendar.badge.clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Suggested Activities")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                if calendarService.isLoading {
                    ProgressView()
                        .controlSize(.mini)
                }
                Spacer()
                if calendarService.isSignedIn {
                    Text("From your Google Calendar")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            if !calendarService.isConfigured || !calendarService.isSignedIn {
                ContentUnavailableView {
                    Label("Connect Google Calendar", systemImage: "calendar.badge.plus")
                } description: {
                    Text("Sign in to Google Calendar in Settings to see activity suggestions from your events.")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if calendarService.isLoading {
                ProgressView("Loading suggestions…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if visibleSuggestions.isEmpty {
                ContentUnavailableView {
                    Label("No Suggestions", systemImage: "calendar")
                } description: {
                    Text("No new calendar events to suggest. Pull to refresh or check back later.")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(visibleSuggestions) { event in
                        SuggestedActivityRow(event: event) {
                            addEventAsActivity(event)
                        } onReject: {
                            rejectEvent(event)
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Existing Activities

    private var activitiesSection: some View {
        ForEach(filteredActivities) { activity in
            NavigationLink(value: activity.id) {
                ActivityRowView(activity: activity)
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    modelContext.delete(activity)
                    try? modelContext.save()
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    // MARK: - Actions

    private func addEventAsActivity(_ event: SuggestedCalendarEvent) {
        let activity = Activity(
            name: event.title,
            colorHex: normalizeColorHex(event.calendarColorHex) ?? "3498DB",
            icon: "calendar",
            date: event.startDate,
            endDate: event.endDate,
            activityDescription: event.eventDescription ?? ""
        )
        activity.googleEventId = event.id
        modelContext.insert(activity)
        try? modelContext.save()
        calendarService.suggestedEvents.removeAll { $0.id == event.id }
    }

    private func rejectEvent(_ event: SuggestedCalendarEvent) {
        let rejected = RejectedCalendarEvent(
            googleEventId: event.id,
            title: event.title,
            eventDate: event.startDate,
            calendarName: event.calendarName
        )
        modelContext.insert(rejected)
        try? modelContext.save()
        calendarService.suggestedEvents.removeAll { $0.id == event.id }
    }

    private func normalizeColorHex(_ hex: String?) -> String? {
        guard var hex = hex else { return nil }
        hex = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex = String(hex.dropFirst()) }
        guard hex.count == 6 else { return nil }
        return hex.uppercased()
    }
}

// MARK: - Suggested Activity Row

struct SuggestedActivityRow: View {
    let event: SuggestedCalendarEvent
    let onAdd: () -> Void
    let onReject: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "calendar")
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Color.blue.gradient, in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                HStack(spacing: 4) {
                    Text(event.startDate.shortFormatted)
                    Text("·")
                    Text(event.calendarName)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            HStack(spacing: 8) {
                Button {
                    withAnimation { onReject() }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.red.opacity(0.7))
                }
                .buttonStyle(.plain)

                Button {
                    withAnimation { onAdd() }
                } label: {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.green)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Activity Row

struct ActivityRowView: View {
    let activity: Activity

    private var contactNames: String {
        let sorted = activity.contacts.sorted { $0.firstName < $1.firstName }
        return sorted.map { "\($0.firstName) \($0.lastName)".trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: activity.icon)
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(activity.color.gradient, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(activity.name)
                    .font(.body.weight(.medium))
                Text(activity.dateRange)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if !activity.contacts.isEmpty {
                    Text(contactNames)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                    Text("\(activity.contacts.count) contact\(activity.contacts.count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if !activity.groups.isEmpty {
                    Text("\(activity.groups.count) group\(activity.groups.count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: 200, alignment: .trailing)
        }
        .padding(.vertical, 2)
    }
}
