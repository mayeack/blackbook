# Contacts

**Menu item:** Contacts
**Tab icon:** `person.crop.rectangle.stack`
**Root view:** `ContactListView` in `Blackbook/Views/Contacts/ContactListView.swift`

## Overview

The Contacts section is the core of the app. It provides a filterable, searchable, sortable list of all contacts with navigation to individual contact details. Contact detail is a multi-section page with overview, interactions, notes, reminders, and AI features.

## Pages

### ContactListView

**File:** `Blackbook/Views/Contacts/ContactListView.swift`

**Data sources:**
- `@Query(sort: \Contact.lastName)` — all contacts
- `@Query(sort: \Tag.name)` — all tags (for filter chips)
- `@Query(sort: \Group.name)` — all groups (for filter chips)
- `ContactListViewModel` — handles search, sort, tag/group filtering

**Layout:** `NavigationStack` > conditional empty state or `List`.

**Empty state:** `ContentUnavailableView` — "No Contacts" / "Add contacts manually or import from your address book." / "Add Contact" button (borderedProminent, accent gold).

**Filter chips bar:** Horizontal `ScrollView` of `GroupChipView` and `TagChipView` capsules (shown when groups or tags exist). Tapping toggles filter. Chips appear above the contact list in a `listRowSeparator(.hidden)` row.

**Table header (non-compact):** `ContactTableHeaderView` — columns: Name (flex), Groups (110pt), Locations (110pt), Tags (110pt), Score (80pt, trailing). Hidden on compact iOS.

**Contact rows:** `ContactRowView` with two layouts:
- **Compact (iOS):** Avatar (44), name + company, trailing score badge with trend arrow + last interaction date
- **Expanded (macOS / iPad):** Avatar (36), name + company | Groups pills | Locations pills | Tags pills | Score badge with trend arrow. Column widths: groups 110, locations 110, tags 110, score 80.

**Pills column:** `PillsColumnView` shows up to 2 colored capsule pills per column. Overflow shown as "+N". Empty columns show "—".

**Swipe actions:**
- Trailing: Delete (destructive)
- Leading: Hide (gray, sets `isHidden = true`)

**Search:** `.searchable(text:prompt:)` — "Search contacts..."

**Toolbar:**
- Primary: Plus button → sheet `ContactFormView(contact: nil)`
- Automatic: Sort/Filter menu — `Picker` for sort order (all `ContactSortOrder` cases) + `NavigationLink` to `SmartGroupsView`

**Navigation:** `navigationDestination(for: UUID.self)` → `ContactDetailView(contact:)`

---

### ContactDetailView

**File:** `Blackbook/Views/Contacts/ContactDetailView.swift`

**Data sources:** `@Bindable var contact: Contact`, `ContactDetailViewModel`

**Layout:** `ScrollView` > `VStack(spacing: 0)` with header, segmented picker, and section content.

**Navigation title:** `contact.displayName`, inline on iOS.

**Header section:**
- `ContactAvatarView(size: 80)` centered
- Name (title2 bold), job title + company (subheadline, secondary)
- Score ring: `Circle` trim with score color, score number (title3 bold), category label
- Stats card: total interactions, frequency description, last contact date, priority star badge
- Background: `cardBackground` in `RoundedRectangle(cornerRadius: 12)`
- Horizontal scroll of tag/group/location capsule chips below stats

**Segmented picker tabs:**

1. **Overview** — contact info blocks:
   - Phone, Email, Address (InfoBlock with icon)
   - Birthday (DetailRow)
   - Interests (FlowLayout of capsule chips)
   - Family details (DetailRow)
   - Met via: NavigationLink to contact (avatar 28 + name), or "None"
   - Introduced to: list of NavigationLinks to backlinked contacts, or "None"

2. **Interactions** — "Log Interaction" button (borderedProminent, accent gold) + chronological list of `InteractionRowView` or empty state

3. **Notes** — "Add Note" button (borderedProminent, accent gold) + list of `NoteCardView` or empty state

4. **Reminders** — "Set Reminder" button (borderedProminent, accent gold) + list of `ReminderRowView` or empty state

5. **AI** — `ContactAIView(contact:)` embedded

**Toolbar menu (ellipsis.circle):**
- Edit → sheet `ContactFormView(contact:)`
- Log Interaction → sheet `LogInteractionView(contact:)`
- Add Note → sheet `AddNoteView(contact:)`
- Set Reminder → sheet `AddReminderView(contact:)`
- Divider
- Merge with… → sheet `MergeContactPickerView(primaryContact:onMerge:)`
- Hide/Unhide Contact (toggles `isHidden`, dismisses if hidden)
- Delete Contact (destructive, dismisses)

**Inline components:**

- `InteractionRowView`: icon circle (32, accent gold bg 0.12) + type + sentiment icon + summary + date + duration
- `NoteCardView`: category label + created date + content (line limit 4) in `cardBackground` rounded rect (10)
- `ReminderRowView`: toggle circle (complete/overdue/pending colors) + title (strikethrough if done) + due date + recurrence
- `FlowLayout`: custom Layout for wrapping chips horizontally

---

### ContactFormView

**File:** `Blackbook/Views/Contacts/ContactFormView.swift`

**Purpose:** Add or edit a contact. Presented as a sheet.

**Data sources:**
- `let contact: Contact?` (nil for new)
- `@Query` for all tags, groups, locations, contacts (for met-via picker)

**Form sections:**
1. **Name:** firstName, lastName TextFields
2. **Work:** company, jobTitle TextFields
3. **Contact Info:** emails (comma separated), phones (comma separated), addresses (semicolon separated)
4. **Personal:** birthday toggle + DatePicker, interests (comma separated), family details
5. **Social:** LinkedIn URL, Twitter handle
6. **Met via:** Picker of all other contacts, or "None"
7. **Tags:** Toggle list of all tags with colored circles
8. **Groups:** Toggle list of all groups with icons
9. **Locations:** Toggle list of all locations with icons
10. **Priority:** Toggle "Priority Contact"

**Toolbar:** Cancel + Save (disabled if both names empty)

**Save logic:** Creates or updates contact, sets all properties, resolves tag/group/location/metVia relationships, saves context, dismisses.

---

### SmartGroupsView

**File:** `Blackbook/Views/Contacts/SmartGroupsView.swift`

**Purpose:** Dynamic, computed contact groups based on rules. Accessed from Contacts toolbar menu.

**Data sources:** `@Query(sort: \Contact.lastName)` — visible contacts only

**Layout:** `List` with conditional sections. Navigation title: "Smart Groups".

**Smart groups:**
1. **Fading Relationships** (fadingRed) — score < 30 and > 0
2. **No Contact in 60+ Days** (orange) — last interaction > 60 days ago or never
3. **Birthday This Month** (pink) — birthday in current month
4. **Priority Contacts** (accent gold) — `isPriority` flag
5. **Untagged** (secondary) — no tags
6. **Ungrouped** (secondary) — no groups

Each group shows count and links to a sub-list of matching contacts, which link to `ContactDetailView`.

---

### AddNoteView

**File:** `Blackbook/Views/Contacts/AddNoteView.swift`

**Purpose:** Add a note to a contact. Presented as a sheet from `ContactDetailView`.

**Form sections:**
1. **Category:** Picker (menu style) of `NoteCategory.allCases` with icons
2. **Note:** `TextEditor` with min height 150

**Toolbar:** Cancel + Save (disabled if content is whitespace-only)

**Save logic:** Inserts `Note(contact:content:category:)`, updates contact `updatedAt`, saves, dismisses.

---

### LogInteractionView

**File:** `Blackbook/Views/Interactions/LogInteractionView.swift`

**Purpose:** Log an interaction with a contact. Presented as a sheet.

**Form sections:**
1. **Type:** Picker (menu style) of `InteractionType.allCases` with icons
2. **When:** DatePicker, optional duration toggle with slider (5–240 min, step 5)
3. **Details:** Summary TextField (3–6 line limit, optional)
4. **Sentiment:** Horizontal row of `Sentiment.allCases` — icon + label buttons, selected state highlighted with accent gold

**Toolbar:** Cancel + Save

**Save logic:** Inserts `Interaction(contact:type:date:duration:summary:sentiment:)`, updates `contact.lastInteractionDate` and `updatedAt`, saves, dismisses.

---

### InteractionLogView

**File:** `Blackbook/Views/Interactions/InteractionLogView.swift`

**Purpose:** Full interaction history for a contact with type filtering.

**Layout:** Horizontal `ScrollView` of `FilterChip` buttons ("All" + each `InteractionType`) above a `List` of `InteractionRowView`.

**Empty state:** `ContentUnavailableView` — "No Interactions" / "Log your first interaction."

**Navigation title:** "Interaction History"

---

### MergeContactPickerView

**File:** `Blackbook/Views/Contacts/MergeContactPickerView.swift`

**Purpose:** Select a contact to merge into the current (primary) contact. Presented as a sheet from `ContactDetailView`.

**Data sources:**
- `@Query(sort:)` — all contacts
- `let primaryContact: Contact` — the contact being merged into
- `var onMerge: () -> Void` — callback after successful merge

**Layout:** `NavigationStack` > `List` of eligible contacts (excludes primary, hidden, and already-merged contacts).

**Search:** `.searchable(text:prompt:)` — "Search contacts"

**Contact rows:** Avatar (36) + name + company + score badge.

**Merge flow:**
1. User taps a contact row
2. Confirmation alert appears: "Merge [secondary] into [primary]? All interactions, notes, and relationships from [secondary] will be moved to [primary]. [secondary] will no longer appear in your contacts."
3. On confirm: `ContactMergeService.merge(primary:secondary:context:)` is called
4. The secondary contact is suppressed (`isMergedAway = true`, `mergedIntoContact = primary`) — not deleted
5. All child relationships (interactions, notes, reminders) are re-parented to the primary
6. Many-to-many memberships (tags, groups, locations, activities) are unioned
7. ContactRelationship edges are re-pointed; self-loops and duplicates are removed
8. metVia/metViaBacklinks are transferred
9. Scalar fields (company, jobTitle, birthday, etc.) fall back from primary to secondary when primary is nil/empty
10. The higher relationship score is kept; isPriority is set if either contact was priority

**iOS contact linking:** The secondary contact retains its `cnContactIdentifier`, so the sync service continues to match and update it from the iOS address book. The secondary is excluded from all views via the `isMergedAway` flag.

**Toolbar:** Cancel button (cancellation action)

**macOS frame:** `minWidth: 400, idealWidth: 450, minHeight: 400, idealHeight: 500`

---

### ContactMergeService

**File:** `Blackbook/Services/ContactMergeService.swift`

**Purpose:** Encapsulates all merge logic. Called from `MergeContactPickerView` on merge confirmation.

**Public API:** `func merge(primary: Contact, secondary: Contact, context: ModelContext) throws`

**Merge behavior:**
- Scalar fields: adopt secondary's value if primary's is nil/empty
- Array fields: union (deduped) emails, phones, addresses, interests; merge customFields (primary wins on key conflicts)
- Score: keep higher relationshipScore, more recent lastInteractionDate, isPriority if either was priority
- Re-parent secondary's interactions, notes, reminders to primary
- Union tags, groups, locations, activities memberships (skip duplicates)
- Re-point ContactRelationship edges; delete self-loops and duplicate pairs
- Transfer metVia backlinks; adopt secondary's metVia if primary has none
- Set `secondary.isMergedAway = true` and `secondary.mergedIntoContact = primary`

## Reusable Components (defined in ContactListView.swift)

- **ContactAvatarView:** Circle-clipped photo or initials on gold gradient background. Parameters: `contact`, `size`.
- **ScoreBadgeView:** Capsule with score number, colored by `scoreColor(for:)`.
- **ScoreTrendArrow:** Up (green), down (red), or hidden for stable.
- **TagChipView:** Capsule chip for tag filtering. Shows tag name in tag color; selected state fills background.
- **GroupChipView:** Capsule chip for group filtering. Shows icon + name; selected state fills background.
- **FilterChip:** Generic capsule chip with optional icon. Selected: accent gold bg, white text.
