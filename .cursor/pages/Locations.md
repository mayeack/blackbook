# Locations

**Menu item:** Locations
**Tab icon:** `mappin.and.ellipse`
**Root view:** `LocationListView` in `Blackbook/Views/Locations/LocationListView.swift`

## Overview

Locations organize contacts by place. They have a name, icon, and color. Locations follow the same collection pattern as Tags and Groups. When creating or editing a location, icons are automatically suggested based on the location name using a keyword-to-SF-Symbol search service.

## Pages

### LocationListView

**File:** `Blackbook/Views/Locations/LocationListView.swift`

**Data sources:**
- `@Query(sort: \Location.name)` — all locations
- Local `searchText` state for filtering

**Layout:** `NavigationStack` > conditional empty state or `List`.

**Empty state:** `ContentUnavailableView` — "No Locations" / "Create locations to organize your contacts by place." / "New Location" button (borderedProminent, accent gold).

**List rows:** `LocationRowView` per location, inside `NavigationLink(value: location.id)`.

**Swipe actions:** Trailing destructive delete.

**Search:** `.searchable(text:prompt:)` — "Search locations..."

**Toolbar:** Plus button → sheet `LocationFormView(location: nil)`

**Navigation:** `navigationDestination(for: UUID.self)` → `LocationDetailView(location:)`

### LocationRowView

**File:** `Blackbook/Views/Locations/LocationListView.swift` (same file)

Location row layout using **Icon 1** and **Header 1** styles:
- `HStack(spacing: 12)`
- Icon badge (Icon 1): `location.icon` in white `.title3` on `location.color.gradient`, 48×48 (`AppConstants.UI.icon1Size`), cornerRadius 10
- VStack(spacing: 4): name (Header 1: `.title.weight(.bold)`), contact count (caption, secondary)
- Vertical padding: 4

---

### LocationDetailView

**File:** `Blackbook/Views/Locations/LocationDetailView.swift`

**Data sources:** `@Bindable var location: Location`, local `searchText`

**Layout:** `List` with `headerSection` and `membersSection`.

**Navigation title:** `location.name`, inline on iOS.

**Header section:** Same layout as `LocationRowView` — Icon 1 badge (48×48) + name (Header 1: `.title.weight(.bold)`) + contact count, inside a `Section`.

**Members section:**
- Empty + no search: "Add Contacts" button (borderedProminent, accent gold, clear list row background)
- Empty + searching: `ContentUnavailableView.search(text:)`
- Populated: `ForEach(sortedContacts)` with `NavigationLink(value: ContactNavigationID)` → `ContactRowView(showScore: false)`
- Swipe action: "Remove" (orange tint, `person.badge.minus`) — removes contact from location
- Section header: "Members" (when non-empty)

**Search:** `.searchable(text:prompt:)` — "Search members..."

**Toolbar menu (ellipsis.circle):**
- Edit Location → sheet `LocationFormView(location:)`
- Add Contacts → sheet `AddContactsToLocationView(location:)`

**Navigation:** `navigationDestination(for: ContactNavigationID.self)` → `ContactDetailView`

---

### LocationFormView

**File:** `Blackbook/Views/Settings/LocationManagerView.swift`

**Purpose:** Create or edit a location. Presented as a sheet.

**Data:** `let location: Location?` (nil for new)

**Form sections:**
1. **Name:** TextField "Location Name" (headerless section)
2. **Icon:** `LocationIconSuggestionView` — auto-suggests SF Symbol icons based on the location name using `SFSymbolSearchService`. As the user types, the grid updates (debounced 300ms) to show relevant icons. When the name is empty, a default set of common location icons is shown. Section header "Icon".
3. **Color:** `ColorPicker` grid of 10 hex colors, section header "Color"

Colors: 3498DB, E74C3C, 2ECC71, 9B59B6, E67E22, 1ABC9C, F39C12, E91E63, 607D8B, D4A017

**Icon suggestion system:**
- `SFSymbolSearchService` (`Blackbook/Services/SFSymbolSearchService.swift`) maps keywords to SF Symbol names
- Covers place types (restaurant, gym, airport, etc.), geographic terms, city names, and general concepts
- Searches both the keyword map and SF Symbol names directly for matches
- Falls back to a curated set of 24 default location icons when no strong matches are found
- Results scored by relevance: exact match > prefix match > substring match

**Toolbar:** Cancel + Save (disabled if name is whitespace-only)

**Save logic:** Creates or updates location with trimmed name, selected color hex, and selected icon. Saves context, dismisses.

---

### AddContactsToLocationView

**File:** `Blackbook/Views/Locations/LocationDetailView.swift` (same file)

**Purpose:** Multi-select sheet to add contacts to a location.

**Data sources:**
- `@Query(sort: \Contact.lastName)` — all contacts
- `let location: Location`
- Local `selectedIDs: Set<UUID>`, `searchText`

**Computed properties:**
- `memberIDs` — current location members
- `nonMembers` — visible, non-member contacts
- `suggestedContacts` — up to 5 contacts scored by location/group overlap with existing members
- `filteredNonMembers` — search-filtered non-members

**Layout:** `NavigationStack` > `List`:
1. Search `TextField` in headerless section
2. "Suggested" section (when suggestions exist and no search active)
3. "All Contacts" / "Results" section with contact rows or empty state

**Contact row:** Avatar (36) + name + company + selection circle (`checkmark.circle.fill` / `circle`, accent gold)

**Toolbar:** Cancel + "Add (N)" (disabled if none selected)

**macOS frame:** `minWidth: 450, idealWidth: 500, minHeight: 500, idealHeight: 600`

**Save logic:** Appends selected contacts to `location.contacts`, saves, dismisses.

---

### LocationManagerView

**File:** `Blackbook/Views/Settings/LocationManagerView.swift`

**Purpose:** Manage all locations (list, add, edit, delete). Not currently linked from any navigation.

**Layout:** `NavigationStack` > empty state or `List` with rows showing icon + name + count. Tap to edit, swipe to delete.

**Toolbar:** Done (cancel) + Plus (add)
