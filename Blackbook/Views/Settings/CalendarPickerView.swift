import SwiftUI

struct CalendarPickerView: View {
    var calendarService: GoogleCalendarService
    @State private var selectedIds: Set<String> = []
    @State private var hasLoaded = false

    var body: some View {
        SwiftUI.Group {
            if calendarService.isLoading && !hasLoaded {
                ProgressView("Loading calendars…")
            } else if calendarService.availableCalendars.isEmpty {
                ContentUnavailableView {
                    Label("No Calendars", systemImage: "calendar.badge.exclamationmark")
                } description: {
                    Text("No calendars were found. Make sure you are signed in to Google Calendar.")
                }
            } else {
                List {
                    ForEach(calendarService.availableCalendars) { calendar in
                        Button {
                            toggleCalendar(calendar.id)
                        } label: {
                            HStack(spacing: 12) {
                                Circle()
                                    .fill(calendarColor(from: calendar.backgroundColor))
                                    .frame(width: 12, height: 12)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(calendar.summary)
                                        .font(.body.weight(.medium))
                                    if calendar.primary == true {
                                        Text("Primary")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }

                                Spacer()

                                Image(systemName: selectedIds.contains(calendar.id) ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(selectedIds.contains(calendar.id) ? AppConstants.UI.accentGold : .secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .navigationTitle("Select Calendars")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            selectedIds = calendarService.selectedCalendarIds
            await calendarService.fetchCalendarList()
            hasLoaded = true
        }
    }

    private func toggleCalendar(_ id: String) {
        if selectedIds.contains(id) {
            selectedIds.remove(id)
        } else {
            selectedIds.insert(id)
        }
        calendarService.selectedCalendarIds = selectedIds
    }

    private func calendarColor(from hex: String?) -> Color {
        guard let hex else { return .blue }
        return Color(hex: hex.replacingOccurrences(of: "#", with: "")) ?? .blue
    }
}
