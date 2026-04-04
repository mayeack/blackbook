# Tags

**Menu item:** Tags
**Tab icon:** `tag`
**Root view:** `TagListView` in `Blackbook/Views/Tags/TagListView.swift`

## Overview

Tags are color-coded labels for organizing contacts. Users create tags, assign them to contacts, and browse tagged contacts. Tags have a name and color (hex string). The icon is always `tag.fill`.

## Pages

### TagListView

**File:** `Blackbook/Views/Tags/TagListView.swift`

**Data sources:**
- `@Query(sort: \Tag.name)` — all tags
- Local `searchText` state for filtering

**Layout:** `NavigationStack` > conditional empty state or `List`.

**Empty state:** `ContentUnavailableView` — "No Tags" / "Create tags to organize your contacts." / "New Tag" button (borderedProminent, accent gold).

**List rows:** `TagRowView` per tag, inside `NavigationLink(value: tag.id)`.

**Swipe actions:** Trailing destructive delete.

**Search:** `.searchable(text:prompt:)` — "Search tags..."

**Toolbar:** Plus button → sheet `TagFormView(tag: nil)`

**Navigation:** `navigationDestination(for: UUID.self)` → `TagDetailView(tag:)`

### TagRowView

**File:** `Blackbook/Views/Tags/TagListView.swift` (same file)

Standard collection row layout:
- `HStack(spacing: 12)`
- Icon badge: `tag.fill` in white on `tag.color.gradient`, 36x36, cornerRadius 8
- VStack: name (body weight medium), contact count (caption, secondary)
- Vertical padding: 2

---

### TagDetailView

**File:** `Blackbook/Views/Tags/TagDetailView.swift`

**Data sources:** `@Bindable var tag: Tag`, local `searchText`

**Layout:** `List` with `headerSection` and `membersSection`.

**Navigation title:** `tag.name`, inline on iOS.

**Header section:** Same layout as `TagRowView` — icon badge + name + contact count, inside a `Section`.

**Members section:**
- Empty + no search: "Add Contacts" button (borderedProminent, accent gold, clear list row background)
- Empty + searching: `ContentUnavailableView.search(text:)`
- Populated: `ForEach(sortedContacts)` with `NavigationLink(value: ContactNavigationID)` → `ContactRowView(showScore: false)`
- Swipe action: "Remove" (orange tint, `person.badge.minus`) — removes contact from tag
- Section header: "Members" (when non-empty)

**Search:** `.searchable(text:prompt:)` — "Search members..."

**Toolbar menu (ellipsis.circle):**
- Edit Tag → sheet `TagFormView(tag:)`
- Add Contacts → sheet `AddContactsToTagView(tag:)`

**Navigation:** `navigationDestination(for: ContactNavigationID.self)` → `ContactDetailView`

---

### TagFormView

**File:** `Blackbook/Views/Settings/TagManagerView.swift`

**Purpose:** Create or edit a tag. Presented as a sheet.

**Data:** `let tag: Tag?` (nil for new)

**Form sections:**
1. **Name:** TextField "Tag Name"
2. **Color:** 5-column grid of 10 colored circles. Selected circle shows white checkmark. Colors: D4A017, E74C3C, 3498DB, 2ECC71, 9B59B6, E67E22, 1ABC9C, F39C12, E91E63, 607D8B

**Toolbar:** Cancel + Save (disabled if name is whitespace-only)

**Save logic:** Creates or updates tag with trimmed name and selected color hex. Saves context, dismisses.

---

### AddContactsToTagView

**File:** `Blackbook/Views/Tags/TagDetailView.swift` (same file)

**Purpose:** Multi-select sheet to add contacts to a tag.

**Data sources:**
- `@Query(sort: \Contact.lastName)` — all contacts
- `let tag: Tag`
- Local `selectedIDs: Set<UUID>`, `searchText`

**Computed properties:**
- `memberIDs` — current tag members
- `nonMembers` — visible, non-member contacts
- `suggestedContacts` — up to 5 contacts scored by tag/group overlap with existing members
- `filteredNonMembers` — search-filtered non-members

**Layout:** `NavigationStack` > `List`:
1. "Suggested" section (when suggestions exist and no search active)
2. "All Contacts" / "Results" section with contact rows or empty state

**Search:** `.searchable(text:prompt:)` — "Search contacts…"

**Contact row:** Avatar (36) + name + company + selection circle (`checkmark.circle.fill` / `circle`, accent gold)

**Toolbar:** Cancel + "Add (N)" (disabled if none selected)

**macOS frame:** `minWidth: 450, idealWidth: 500, minHeight: 500, idealHeight: 600`

**Save logic:** Appends selected contacts to `tag.contacts`, saves, dismisses.

---

### TagManagerView

**File:** `Blackbook/Views/Settings/TagManagerView.swift`

**Purpose:** Manage all tags (list, add, edit, delete). Not currently linked from any navigation.

**Layout:** `NavigationStack` > empty state or `List` with tap-to-edit rows and swipe-to-delete.

**Toolbar:** Done (cancel) + Plus (add)
