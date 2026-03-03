# Reminders

**Menu item:** Reminders
**Tab icon:** `bell`
**Root view:** `RemindersView` in `Blackbook/Views/Reminders/RemindersView.swift`

## Overview

The Reminders tab shows all reminders across all contacts, filterable by status. Users can mark reminders complete, delete them, and create new reminders from individual contact detail pages.

## Pages

### RemindersView

**File:** `Blackbook/Views/Reminders/RemindersView.swift`

**Data sources:**
- `@Query(sort: \Reminder.dueDate)` — all reminders
- Local `filter: ReminderFilter` state

**Layout:** `NavigationStack` > `VStack(spacing: 0)` with segmented picker and content.

**Navigation title:** "Reminders"

**Filter picker:** Segmented `Picker` with padding. Options:
1. **Upcoming** — not completed, not overdue
2. **Overdue** — `isOverdue` (past due and not completed)
3. **Completed** — `isCompleted`
4. **All** — everything

**Empty state:** `ContentUnavailableView` — "No Reminders" / "No {filter} reminders."

**Reminder rows:** Each row (when contact exists):
- Toggle button: `checkmark.circle.fill` (green) / `circle` (overdue: red, else secondary), title3 font
- VStack: title (subheadline medium, strikethrough if done), contact avatar (18) + name (caption, secondary)
- Trailing: due date (caption, red if overdue, else secondary)
- Vertical padding: 4

**Actions:**
- Tap toggle: marks `isCompleted` toggle, saves
- Swipe to delete: `.onDelete` removes reminder from context

**List style:** `.plain`

---

### AddReminderView

**File:** `Blackbook/Views/Reminders/RemindersView.swift` (same file)

**Purpose:** Create a reminder for a contact. Presented as a sheet from `ContactDetailView`.

**Data:** `let contact: Contact`

**Default values:** `dueDate` = tomorrow, `recurrence` = monthly

**Form sections:**
1. **Reminder:** title TextField + DatePicker (date + time components)
2. **Repeat:** "Recurring" toggle, optional frequency Picker (`Recurrence.allCases`)

**Toolbar:** Cancel + Save (disabled if title is whitespace-only)

**Save logic:** Inserts `Reminder(contact:title:dueDate:recurrence:)` with optional recurrence. Saves context, dismisses.
