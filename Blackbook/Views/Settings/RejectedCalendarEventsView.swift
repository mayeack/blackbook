import SwiftUI
import SwiftData

struct RejectedCalendarEventsView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \RejectedCalendarEvent.rejectedAt, order: .reverse) private var rejectedEvents: [RejectedCalendarEvent]
    @State private var searchText = ""

    private var filteredEvents: [RejectedCalendarEvent] {
        if searchText.isEmpty { return rejectedEvents }
        return rejectedEvents.filter {
            $0.title.localizedCaseInsensitiveContains(searchText)
            || $0.calendarName.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        SwiftUI.Group {
            if rejectedEvents.isEmpty {
                ContentUnavailableView {
                    Label("No Rejected Events", systemImage: "calendar.badge.minus")
                } description: {
                    Text("Calendar events you reject will appear here. You can restore them to see them as suggestions again.")
                }
            } else {
                List {
                    ForEach(filteredEvents) { event in
                        HStack(spacing: 12) {
                            Image(systemName: "calendar")
                                .font(.body)
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Color.secondary.gradient, in: RoundedRectangle(cornerRadius: 8))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(event.title)
                                    .font(.body.weight(.medium))
                                HStack(spacing: 4) {
                                    Text(event.eventDate.shortFormatted)
                                    Text("·")
                                    Text(event.calendarName)
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }

                            Spacer()

                            Button {
                                withAnimation {
                                    modelContext.delete(event)
                                    try? modelContext.save()
                                }
                            } label: {
                                Text("Restore")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(AppConstants.UI.accentGold)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, 2)
                    }
                    .onDelete { offsets in
                        for index in offsets {
                            modelContext.delete(filteredEvents[index])
                        }
                        try? modelContext.save()
                    }
                }
                .searchable(text: $searchText, prompt: "Search rejected events...")
            }
        }
        .navigationTitle("Rejected Events")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
