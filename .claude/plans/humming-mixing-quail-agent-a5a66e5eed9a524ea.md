# Blackbook Feedback Implementation Plan — 23 Items

## Overview

This plan organizes 23 feedback items into 8 logical work batches, grouped by the files they touch to minimize context switching. Each batch lists the items addressed, files modified, specific changes, and dependencies.

---

## BATCH 1: Hidden/Merged Contact Leaks (Items 10, 11, 16)
**Priority: CRITICAL — data privacy**

These are privacy bugs where hidden or merged contacts leak into visible UI areas.

### Item 10: Hidden contacts in Met Via (and everywhere)
**Files to modify:**
- `Blackbook/Views/Contacts/ContactDetailView.swift` — `MetViaPickerView`, `IntroducedToPickerView`, `overviewSection` (metViaBacklinks display)
- `Blackbook/Views/Contacts/ContactFormView.swift` — Met via Picker
- `Blackbook/Views/Contacts/ContactListView.swift` — `MetViaPickerView` and `IntroducedToPickerView` sheet invocations pass unfiltered `allContacts`

**Changes:**
1. **MetViaPickerView.eligible** (line 368-369): Change filter from `allContacts.filter { $0.id != contact.id }` to `allContacts.filter { $0.id != contact.id && !$0.isHidden && !$0.isMergedAway }`. Preserve the currently-set metVia contact even if hidden, so the user can see/clear it.
2. **IntroducedToPickerView.eligible** (line 443-444): Same filter — add `!$0.isHidden && !$0.isMergedAway`.
3. **ContactDetailView.overviewSection** metViaBacklinks display (line 219): Filter the ForEach to `contact.metViaBacklinks.filter { !$0.isHidden && !$0.isMergedAway }.sorted { ... }`.
4. **ContactDetailView.overviewSection** metVia display (line 194): Add a guard — if `metViaContact.isHidden || metViaContact.isMergedAway`, show the name in a dimmed/italic style with "(Hidden)" label, or just show "None" depending on desired UX.
5. **ContactFormView** met via Picker (line 49): Change `allContacts.filter { $0.id != contact?.id }` to also exclude hidden and merged contacts.
6. **ContactListView** sheet (lines 143-149): The `allContacts` passed to `MetViaPickerView` and `IntroducedToPickerView` comes from `@Query`, so the filtering should happen inside those views (already handled above). No change needed at the call site.

### Item 11: Merged contacts + merge primary selection
**Files to modify:**
- `Blackbook/Views/Contacts/MergeContactPickerView.swift`
- `Blackbook/Services/ContactMergeService.swift` (no change needed, already correct)

**Changes:**
1. **MergeContactPickerView**: After user selects a contact to merge with, change the confirmation alert to let the user choose which contact is "primary" (the one that survives). Currently the alert has only "Merge" and "Cancel". Change to:
   - Add a `@State private var chosenPrimary: Contact?` 
   - After selecting a contact, show a picker/alert asking "Which contact should be kept?" with both names as options
   - Pass the chosen primary and secondary to `ContactMergeService.merge()`
   - Update alert text to reflect the choice

### Item 16: Introduced to selection broken
**Files to modify:**
- `Blackbook/Views/Contacts/ContactDetailView.swift` — `IntroducedToPickerView`

**Changes:**
The `IntroducedToPickerView` looks correct in code — it uses `selectedIDs` state and toggles on tap. The bug may be that the view is initialized with `selectedIDs = []` and only populates on `.onAppear` (line 513-515). If the sheet is being reused without `.onAppear` firing, selections would be lost. Verify that `.onAppear` runs each time the sheet is presented. If not, move the initialization to an `.init` or use `.task` instead. Also verify that the "Done" button save logic (lines 497-509) correctly assigns `c.metVia = contact` for newly selected contacts and clears it for deselected ones — this logic looks correct but needs testing.

**Possible root cause**: The `eligible` filter doesn't exclude hidden/merged contacts, so the `filtered` list may contain contacts that can't actually be selected properly. Fixing Item 10 may resolve this.

---

## BATCH 2: Confirmation Dialogs (Items 13, 14)
**Priority: HIGH — destructive action safety**

### Item 13: Delete confirmation
**Files to modify:**
- `Blackbook/Views/Contacts/ContactListView.swift` — swipe action
- `Blackbook/Views/Contacts/ContactDetailView.swift` — toolbar menu
- `Blackbook/ViewModels/ContactDetailViewModel.swift`

**Changes:**
1. **ContactListView** swipe delete (line 103): Instead of immediately calling `modelContext.delete(contact)`, set a `@State private var contactToDelete: Contact?` which triggers an `.alert()`:
   ```swift
   .alert("Delete Contact", isPresented: $showDeleteConfirmation, presenting: contactToDelete) { contact in
       Button("Delete", role: .destructive) { modelContext.delete(contact); try? modelContext.save() }
       Button("Cancel", role: .cancel) { contactToDelete = nil }
   } message: { contact in
       Text("Are you sure you want to delete \(contact.displayName)? This cannot be undone.")
   }
   ```
2. **ContactDetailView** toolbar delete (line 67): Same pattern — replace immediate deletion with confirmation alert. Add `@State private var showDeleteConfirmation = false` and an `.alert()` modifier.
3. **ContactDetailViewModel.deleteContact**: Keep as-is; the views will call it after confirmation.

### Item 14: Hide confirmation
**Files to modify:**
- `Blackbook/Views/Contacts/ContactListView.swift` — swipe action
- `Blackbook/Views/Contacts/ContactDetailView.swift` — toolbar menu

**Changes:**
1. **ContactListView** swipe hide (line 107-113): Add `@State private var contactToHide: Contact?` and a confirmation alert before setting `isHidden = true`.
2. **ContactDetailView** toolbar hide (line 59-63): Add confirmation alert before toggling `isHidden`.

---

## BATCH 3: Contact List UX (Items 1, 3, 9, 12)
**Priority: MEDIUM — core navigation improvements**

### Item 1: Default sort alphabetically everywhere
**Files to modify:**
- `Blackbook/ViewModels/ContactListViewModel.swift`
- `Blackbook/Views/Dashboard/DashboardView.swift` — `PrioritizeContactPicker`

**Changes:**
1. `ContactListViewModel` already defaults to `.name` sort which sorts by lastName A-Z. This is correct.
2. **PrioritizeContactPicker** (line 252-255): The `filtered` property doesn't sort — it just filters `contacts` which arrives sorted by `relationshipScore` descending (from the @Query on DashboardView line 6). Fix: sort `filtered` by lastName alphabetically, matching the ContactListViewModel.name sort logic.
3. Audit all other contact list pickers (AddContactsToGroupView, AddContactsToTagView, AddContactsToLocationView, AddContactsToActivityView) — these all already sort by lastName. Confirmed correct.

### Item 3: Filter redesign — collapsible filter bubbles
**Files to modify:**
- `Blackbook/Views/Contacts/ContactListView.swift` — `FilterRow` and filter section
- `Blackbook/ViewModels/ContactListViewModel.swift` — add expand/collapse state

**Changes:**
1. Add `@State private var expandedFilters: Set<String> = []` to ContactListView (or to the ViewModel).
2. Replace the current inline `FilterRow` components with a new `CollapsibleFilterBubble` component:
   - Each filter (Tags, Groups, Locations) renders as a single tappable bubble/capsule showing the filter name
   - If any filters are active in that category, show a count badge
   - Tapping the bubble toggles expansion, showing the chips below
   - An expand/collapse chevron arrow on the bubble
3. The `FilterRow` struct can be refactored or replaced. The new component wraps the existing chip views.

### Item 9: Double tap to clear filters
**Files to modify:**
- `Blackbook/Views/Contacts/ContactListView.swift`

**Changes:**
1. Add a `TapGesture(count: 2)` on the contacts List area (or on a clear area) that calls `viewModel.selectedTags.removeAll(); viewModel.selectedGroups.removeAll(); viewModel.selectedLocations.removeAll()`.
2. Alternatively, add an explicit "Clear Filters" button that appears when any filter is active — this may be more discoverable than double-tap.

**Note:** Double-tap gestures on List areas can interfere with row selection. Consider placing the gesture on the filter section header area instead, or adding it as a toolbar button.

### Item 12: Pin search bar
**Files to modify:**
- `Blackbook/Views/Contacts/ContactListView.swift`

**Changes:**
The `.searchable()` modifier on NavigationStack (line 128) already uses the system search bar which is pinned by default in iOS 16+. However, the issue may be that the search bar collapses when scrolling on certain iOS versions. Options:
1. Use `.searchable(text:, placement: .navigationBarDrawer(displayMode: .always))` to force the search bar to always be visible.
2. This is a one-line change on line 128.

---

## BATCH 4: Contact Detail & Form (Items 5, 20, 23)
**Priority: MEDIUM — UI polish and feature addition**

### Item 5: Left justify overview content
**Files to modify:**
- `Blackbook/Views/Contacts/ContactDetailView.swift` — `overviewSection`

**Changes:**
The `overviewSection` (line 176) already uses `VStack(alignment: .leading, ...)`, and the sub-components (`InfoBlock`, `DetailRow`, etc.) all use `VStack(alignment: .leading, ...)`. However, the header section (line 103) uses a centered VStack for the avatar and name. The overview section itself looks correctly left-aligned. Review specific sub-views for any centering:
- The `headerSection` is centered by design (avatar, name, stats ring)
- The `overviewSection` VStack is left-aligned
- Verify that FlowLayout items align to leading edge — they do via the layout algorithm
- No change may actually be needed, but if specific items aren't left-aligned on device, check for `.frame(maxWidth: .infinity)` without explicit alignment.

### Item 20: Birthday showing full year
**Files to modify:**
- `Blackbook/Utilities/DateHelpers.swift`

**Changes:**
The `shortFormatted` extension (line 12-16) uses `DateFormatter` with `.medium` dateStyle, which produces "Mar 27, 2026" for dates in the current year and "Mar 27, 1990" for other years. The issue says birthday is "truncated" — meaning the year is missing. However, `.medium` does include the year. 

The actual issue may be that for birthdays in the current year (if someone's birthday date object has year=2026), it shows the current year which is confusing. Or the birthday Date was imported without a year component.

**Solution:** Add a dedicated `birthdayFormatted` property that always shows day, month, and year:
```swift
var birthdayFormatted: String {
    let formatter = DateFormatter()
    formatter.dateFormat = "MMMM d, yyyy"
    return formatter.string(from: self)
}
```
Then update `ContactDetailView.overviewSection` line 180 to use `b.birthdayFormatted` instead of `b.shortFormatted`.

### Item 23: Add Instagram + collapsible form sections
**Files to modify:**
- `Blackbook/Models/Contact.swift` — add `instagramHandle` property
- `Blackbook/Views/Contacts/ContactFormView.swift` — add Instagram field, add collapsible sections
- `Blackbook/Services/ContactMergeService.swift` — merge Instagram field
- `Blackbook/Services/ContactSyncService.swift` — import Instagram from social profiles
- `Blackbook/Views/Contacts/ContactDetailView.swift` — display Instagram in overview

**Changes:**
1. **Contact model**: Add `var instagramHandle: String?` property. SwiftData will handle migration.
2. **ContactFormView**: 
   - Add `@State private var instagramHandle = ""` 
   - Add TextField in Social section: `TextField("Instagram Handle", text: $instagramHandle)`
   - Add collapsible sections using `DisclosureGroup` for each Form Section. Track expansion state with `@State private var expandedSections: Set<String> = ["Name", "Contact Info"]` (Name and Contact Info expanded by default).
   - Load/save instagramHandle in onAppear and save() function.
3. **ContactMergeService.mergeScalarFields**: Add Instagram merge logic matching the pattern for twitterHandle.
4. **ContactSyncService.populateFields**: Check for Instagram in social profiles.
5. **ContactDetailView.overviewSection**: Add Instagram display row if not nil.

---

## BATCH 5: Icon System Fixes (Items 6, 7)
**Priority: MEDIUM — UI consistency**

### Item 6: Fix icon suggestion selection bug
**Files to modify:**
- `Blackbook/Views/Settings/GroupIconSuggestionView.swift`
- `Blackbook/Views/Settings/LocationIconSuggestionView.swift`
- `Blackbook/Views/Settings/GroupManagerView.swift` — `GroupFormView`
- `Blackbook/Views/Settings/LocationManagerView.swift` — layout for scrolling past suggestions

**Changes:**
1. **GroupIconSuggestionView** and **LocationIconSuggestionView**: The `onChange(of: groupName/locationName)` handler (lines 40-55 in both) updates `suggestedIcons` array but does NOT update `selectedIcon`. When icons reorder, the selected icon stays the same string but may no longer be in the suggestions grid. The fix:
   - After updating `suggestedIcons`, check if `selectedIcon` is still in the new array. If not, either keep it (it will just not show as selected in the suggestions) or auto-select the first suggestion.
   - The real issue is the user cannot scroll PAST the suggestion grid to see the full CollapsibleIconPicker. In `GroupFormView` (GroupManagerView.swift line 82-88), the form has Section("Icon") containing only `GroupIconSuggestionView`. The `CollapsibleIconPicker` is NOT present.

2. **GroupFormView** and LocationFormView: Add `CollapsibleIconPicker` below the suggestion view within the same Section, or as a new Section("All Icons"), so users can browse all icons:
   ```swift
   Section("Icon") {
       GroupIconSuggestionView(...)
       CollapsibleIconPicker(
           categories: AppConstants.Icons.groupCategories,
           selectedIcon: $selectedIcon,
           accentColorHex: selectedColor
       )
   }
   ```

### Item 7: Consistent icon sizes
**Files to modify:**
- `Blackbook/Utilities/Constants.swift`
- `Blackbook/Views/Locations/LocationDetailView.swift`
- `Blackbook/Views/Tags/TagDetailView.swift`
- `Blackbook/Views/Groups/GroupDetailView.swift`

**Changes:**
1. **Constants.swift**: Rename `icon1Size` (48pt) or add a new constant `detailIconSize: CGFloat = 36` to standardize. Keep 36pt as the standard for all detail view header icons.
2. **LocationDetailView.headerSection** (line 74-75): Change `AppConstants.UI.icon1Size` (48) to 36, and adjust font from `.title3` to `.body` to match Group/Tag detail views.
3. **GroupDetailView.headerSection** (line 78-79): Already uses 36x36 with `.body` font. No change.
4. **TagDetailView.headerSection** (line 74-75): Already uses 36x36 with `.body` font. No change.

---

## BATCH 6: Suggested Groups Dedup + Group/Tag Member Sorting (Items 19, 21, 22)
**Priority: MEDIUM — data presentation**

### Item 19: Don't show suggested groups/tags/locations twice
**Files to modify:**
- `Blackbook/Views/Contacts/ContactGroupPickerView.swift`
- `Blackbook/Views/Contacts/ContactTagPickerView.swift`
- `Blackbook/Views/Contacts/ContactLocationPickerView.swift`

**Changes:**
The issue: `suggestedGroups` filters out `currentIDs` (selected items), but `filteredGroups` also filters out `selectedIDs`. When a group appears in both "Suggested" and "All Groups" sections, it shows twice.

Fix for all three picker views: In the `filteredGroups`/`filteredTags`/`filteredLocations` computed property, additionally exclude suggested item IDs:
```swift
private var filteredGroups: [Group] {
    let suggestedIDs = Set(suggestedGroups.map(\.id))
    let base = allGroups.filter { !selectedIDs.contains($0.id) && (searchText.isEmpty ? !suggestedIDs.contains($0.id) : true) }
    if searchText.isEmpty { return base }
    return base.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
}
```
Only exclude from "All" when not searching — during search, show everything matching.

### Item 21: Sort group members alphabetically
**Files to modify:**
- `Blackbook/Views/Groups/GroupDetailView.swift`
- `Blackbook/Views/Tags/TagDetailView.swift`
- `Blackbook/Views/Locations/LocationDetailView.swift`

**Changes:**
All three views already have `sortedContacts` using `.sorted { $0.lastName < $1.lastName }`. However, this uses simple string comparison, not the locale-aware comparison used elsewhere. Standardize to:
```swift
.sorted {
    let lhs = $0.lastName.isEmpty
    let rhs = $1.lastName.isEmpty
    if lhs != rhs { return rhs }
    let lastCmp = $0.lastName.localizedCaseInsensitiveCompare($1.lastName)
    if lastCmp != .orderedSame { return lastCmp == .orderedAscending }
    return $0.firstName.localizedCaseInsensitiveCompare($1.firstName) == .orderedAscending
}
```
This matches the sort logic used in `ContactListViewModel` and `AddContactsToGroupView`.

### Item 22: Filter by other tags within a tag detail view
**Files to modify:**
- `Blackbook/Views/Tags/TagDetailView.swift`

**Changes:**
Add filter chips (for Locations and other Tags) to the tag detail view's member list. Steps:
1. Add `@Query(sort: \Location.name) private var allLocations: [Location]` and `@Query(sort: \Tag.name) private var allTags: [Tag]` to TagDetailView.
2. Add `@State private var selectedLocationFilter: Set<UUID> = []` and `@State private var selectedTagFilter: Set<UUID> = []`.
3. Add a filter section above the members list showing Location and Tag chips (excluding the current tag).
4. Update `sortedContacts` to filter by selected locations/tags in addition to search text.

This same pattern could be applied to GroupDetailView and LocationDetailView for consistency.

---

## BATCH 7: Import & Sync (Items 17, 18)
**Priority: MEDIUM — feature enhancement**

### Item 17: Import contacts flow — selective import
**Files to modify:**
- `Blackbook/Services/ContactSyncService.swift`
- `Blackbook/Views/Settings/SettingsView.swift`
- New file: `Blackbook/Views/Settings/ContactImportPickerView.swift`

**Changes:**
1. **ContactSyncService**: Add a new method `fetchSystemContacts() -> [CNContact]` that returns the list without importing, for the selective import UI to use. Extract the CNContact fetching logic from `importContacts` into this reusable method.
2. **New ContactImportPickerView**: A sheet view showing all system contacts with checkboxes. Group by first letter. Search support. "Select All" / "Deselect All" buttons. "Import Selected" button.
3. **SettingsView.contactsSyncSection**: Change the single "Import from Contacts" button to show a menu or action sheet with two options: "Import All" and "Select Contacts to Import".
4. Add a method to ContactSyncService: `importSelectedContacts(identifiers: Set<String>, into: ModelContext)` that only imports contacts matching the given CN identifiers.

### Item 18: Last synced format — date/time instead of relative
**Files to modify:**
- `Blackbook/Views/Settings/SettingsView.swift` — `syncStatusText` computed property

**Changes:**
Change line 162 from `date.relativeDescription` to `date.longFormatted` (or `date.shortFormatted` + time):
```swift
private var syncStatusText: String {
    if syncService.isSyncing { return "Syncing..." }
    if let date = syncService.lastSyncDate {
        return "Last synced: \(date.longFormatted)"  // "March 27, 2026 at 3:15 PM"
    }
    return "Not synced"
}
```
Same change for iMessage sync subtitle if applicable (line 222).

---

## BATCH 8: Miscellaneous UX (Items 2, 4, 8, 15)
**Priority: LOW-MEDIUM — polish**

### Item 2: Google Calendar link in suggested activities
**Files to modify:**
- `Blackbook/Views/Activities/ActivityListView.swift`

**Changes:**
In `suggestedActivitiesPanel` (line 121-127), when `!calendarService.isConfigured || !calendarService.isSignedIn`, the current ContentUnavailableView says "Sign in to Google Calendar in Settings". Change to include a NavigationLink or button that navigates to Settings > Google Calendar section:
```swift
ContentUnavailableView {
    Label("Connect Google Calendar", systemImage: "calendar.badge.plus")
} description: {
    Text("Connect your Google Calendar to see activity suggestions.")
} actions: {
    NavigationLink {
        // Navigate to Google Calendar settings
        // This requires either a deep link or refactoring settings into a standalone view
    } label: {
        Text("Configure in Settings")
            .font(.subheadline.weight(.medium))
    }
    .buttonStyle(.borderedProminent)
    .tint(AppConstants.UI.accentGold)
}
```
**Challenge:** Since SettingsView is a separate tab, NavigationLink won't work across tab boundaries. Options:
- Use an environment-level navigation state (e.g., `@AppStorage` or shared `Observable`) to signal "open settings and scroll to calendar"
- Or simply use `Button` that opens the Settings tab programmatically via a binding on the parent ContentView's tab selection

### Item 4: Fix double back arrows
**Files to modify:**
- Multiple views — requires audit

**Analysis:** Double back arrows typically occur when a `NavigationStack` is nested inside another `NavigationStack`. The most common pattern is a `.sheet()` presenting a view that wraps in `NavigationStack`, where the parent already provides navigation.

Views that present sheets with their own NavigationStack (correct, since sheets need their own):
- ContactFormView, LogInteractionView, AddNoteView, etc. — these are all sheets, so their inner NavigationStack is correct.

The BiometricSettingsView issue: `SettingsView` pushes `BiometricSettingsView` via `NavigationLink`. `SettingsView` has its own `NavigationStack`. `BiometricSettingsView` does NOT have its own NavigationStack (confirmed line 63-111 of BiometricLockView.swift). So this should be fine.

**Action:** This needs device testing to identify the specific screens with double back arrows. The most likely culprit is if any pushed view (not sheet) also wraps in NavigationStack. Audit all `NavigationLink` destinations to ensure they do NOT contain their own `NavigationStack`.

### Item 8: Consistent search contacts UX
**Files to modify:**
- Multiple picker views

**Analysis:** The "Add to Contacts" pattern (e.g., `AddContactsToGroupView`) uses a TextField-based search inside a List Section. The `PrioritizeContactPicker` uses `.searchable()` on the NavigationStack. The ContactListView uses `.searchable()`. These are inconsistent.

**Changes:** Standardize all contact-searching views to use `.searchable()` modifier instead of inline TextField. Views to update:
- `AddContactsToGroupView` — change from TextField to `.searchable()`
- `AddContactsToTagView` — same
- `AddContactsToLocationView` — same
- `AddContactsToActivityView` — same
- `ContactGroupPickerView` — same
- `ContactTagPickerView` — same
- `ContactLocationPickerView` — same

### Item 15: Tap to deselect on network graph
**Files to modify:**
- `Blackbook/Views/Network/NetworkGraphView.swift`

**Changes:**
Add a tap gesture to the background of the `treeCanvas` that clears `selectedContactID`:
```swift
// In treeCanvas, on the ZStack or ScrollView:
.onTapGesture {
    withAnimation { selectedContactID = nil }
}
```
However, this may conflict with the node tap gestures. Use `.simultaneousGesture()` or apply the background tap on a separate layer behind the nodes. A cleaner approach:
```swift
// Add a background rectangle that captures taps
Color.clear
    .contentShape(Rectangle())
    .onTapGesture { selectedContactID = nil }
```
Place this as the first element in the ZStack, before the edges and nodes.

---

## Dependency Graph

```
Item 10 (hidden leaks) ──> Item 16 (introduced to broken) — fixing filtering may fix selection
Item 10 ──> Item 11 (merged contacts) — both deal with contact visibility
Item 23 (Instagram) ──> requires SwiftData model migration
Item 17 (selective import) ──> depends on ContactSyncService refactor
Item 3 (filter redesign) ──> Item 9 (clear filters) — clear button can be part of redesign
Item 7 (icon sizes) ──> Item 6 (icon picker fix) — both touch icon system
```

## Items Needing Clarification

1. **Item 4 (double back arrows)**: Need specific screens where this occurs to fix. The BiometricSettingsView code looks correct. Suggest device testing to identify actual instances.
2. **Item 9 (double tap to clear)**: Double-tap on a List area is unconventional iOS UX and may conflict with cell selection. Recommend a visible "Clear Filters" button instead, or both.
3. **Item 5 (left justify)**: The overview section already uses left-aligned VStacks. Need specific screenshots to identify which content is not left-aligned.
4. **Item 2 (Google Calendar link)**: Cross-tab navigation is non-trivial. Need to decide between deep-link approach (more work, better UX) or a simple text instruction.
5. **Item 22 (filter within tag)**: Should this also apply to GroupDetailView and LocationDetailView for consistency?

## Recommended Implementation Order

1. **Batch 1** (Items 10, 11, 16) — Privacy fixes, highest priority
2. **Batch 2** (Items 13, 14) — Destructive action safety
3. **Batch 4** (Items 5, 20, 23) — Contact detail + model changes (do model migration early)
4. **Batch 5** (Items 6, 7) — Icon fixes
5. **Batch 6** (Items 19, 21, 22) — Data presentation
6. **Batch 3** (Items 1, 3, 9, 12) — Contact list UX
7. **Batch 7** (Items 17, 18) — Import/sync
8. **Batch 8** (Items 2, 4, 8, 15) — Polish
