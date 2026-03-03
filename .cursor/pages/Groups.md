# Groups

**Menu item:** Groups
**Tab icon:** `folder.fill`
**Root view:** `GroupListView` in `Blackbook/Views/Groups/GroupListView.swift`

## Overview

Groups are customizable collections with a name, icon, and color for organizing contacts. Groups follow the same collection pattern as Tags and Locations but include a user-selectable icon from categorized icon sets.

## Pages

### GroupListView

**File:** `Blackbook/Views/Groups/GroupListView.swift`

**Data sources:**
- `@Query(sort: \Group.name)` — all groups
- Local `searchText` state for filtering

**Layout:** `NavigationStack` > conditional empty state or `List`.

**Empty state:** `ContentUnavailableView` — "No Groups" / "Create groups to organize your contacts." / "New Group" button (borderedProminent, accent gold).

**List rows:** `GroupRowView` per group, inside `NavigationLink(value: group.id)`.

**Swipe actions:** Trailing destructive delete.

**Search:** `.searchable(text:prompt:)` — "Search groups..."

**Toolbar:** Plus button → sheet `GroupFormView(group: nil)`

**Navigation:** `navigationDestination(for: UUID.self)` → `GroupDetailView(group:)`

### GroupRowView

**File:** `Blackbook/Views/Groups/GroupListView.swift` (same file)

Standard collection row layout:
- `HStack(spacing: 12)`
- Icon badge: `group.icon` in white on `group.color.gradient`, 36x36, cornerRadius 8
- VStack: name (body weight medium), contact count (caption, secondary)
- Vertical padding: 2

---

### GroupDetailView

**File:** `Blackbook/Views/Groups/GroupDetailView.swift`

**Data sources:** `@Bindable var group: Group`, local `searchText`

**Layout:** `List` with `headerSection` and `membersSection`.

**Navigation title:** `group.name`, inline on iOS.

**Header section:** Same layout as `GroupRowView` — icon badge + name + contact count, inside a `Section`.

**Members section:**
- Empty + no search: "Add Contacts" button (borderedProminent, accent gold, clear list row background)
- Empty + searching: `ContentUnavailableView.search(text:)`
- Populated: `ForEach(sortedContacts)` with `NavigationLink(value: ContactNavigationID)` → `ContactRowView(showScore: false)`
- Swipe action: "Remove" (orange tint, `person.badge.minus`) — removes contact from group
- Section header: "Members" (when non-empty)

**Search:** `.searchable(text:prompt:)` — "Search members..."

**Toolbar menu (ellipsis.circle):**
- Edit Group → sheet `GroupFormView(group:)`
- Add Contacts → sheet `AddContactsToGroupView(group:)`

**Navigation:** `navigationDestination(for: ContactNavigationID.self)` → `ContactDetailView`

---

### GroupFormView

**File:** `Blackbook/Views/Settings/GroupManagerView.swift`

**Purpose:** Create or edit a group. Presented as a sheet.

**Data:** `let group: Group?` (nil for new)

**Form sections:**
1. **Group Name:** TextField with bold header "Group Name", `labelsHidden()`
2. **Icons:** `CollapsibleIconPicker` with `AppConstants.Icons.groupCategories`, bold header "Icons"
3. **Color:** `ColorPicker` grid of 10 hex colors, bold header "Color"

Colors: 3498DB, E74C3C, 2ECC71, 9B59B6, E67E22, 1ABC9C, F39C12, E91E63, 607D8B, D4A017

**Toolbar:** Cancel + Save (disabled if name is whitespace-only)

**Save logic:** Creates or updates group with trimmed name, selected color hex, and selected icon. Saves context, dismisses.

---

### AddContactsToGroupView

**File:** `Blackbook/Views/Groups/GroupDetailView.swift` (same file)

**Purpose:** Multi-select sheet to add contacts to a group.

**Data sources:**
- `@Query(sort: \Contact.lastName)` — all contacts
- `let group: Group`
- Local `selectedIDs: Set<UUID>`, `searchText`

**Computed properties:**
- `memberIDs` — current group members
- `nonMembers` — visible, non-member contacts
- `suggestedContacts` — up to 5 contacts scored by tag/group overlap with existing members
- `filteredNonMembers` — search-filtered non-members

**Layout:** `NavigationStack` > `List`:
1. Search `TextField` in headerless section
2. "Suggested" section (when suggestions exist and no search active)
3. "All Contacts" / "Results" section with contact rows or empty state

**Contact row:** Avatar (36) + name + company + selection circle (`checkmark.circle.fill` / `circle`, accent gold)

**Toolbar:** Cancel + "Add (N)" (disabled if none selected)

**macOS frame:** `minWidth: 450, idealWidth: 500, minHeight: 500, idealHeight: 600`

**Save logic:** Appends selected contacts to `group.contacts`, saves, dismisses.

---

### GroupManagerView

**File:** `Blackbook/Views/Settings/GroupManagerView.swift`

**Purpose:** Manage all groups (list, add, edit, delete). Not currently linked from any navigation.

**Layout:** `NavigationStack` > empty state or `List` with rows showing icon + name + count. Tap to edit, swipe to delete.

**Toolbar:** Done (cancel) + Plus (add)

## Shared Components

### CollapsibleIconPicker

**File:** `Blackbook/Views/Settings/IconAndColorPickers.swift`

Expandable category-based icon grid:
- `ForEach(categories)` with collapsible disclosure buttons
- 6-column `LazyVGrid` of SF Symbol icons (title3, 40x40)
- Selected icon: white text on accent color background. Unselected: primary on secondary 0.15 bg.
- Corner radius: 8

### ColorPicker

**File:** `Blackbook/Views/Settings/IconAndColorPickers.swift`

5-column `LazyVGrid` of colored circles (36x36):
- Selected: white checkmark overlay
- Tap to select
