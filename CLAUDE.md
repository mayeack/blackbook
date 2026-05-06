# Blackbook - Development Rules

## UI/UX Design Rules

- **Contact chips/avatars must always be tappable.** Any view that displays a contact avatar or chip (`ContactChip`, `PriorityContactChip`, `ContactAvatarView`, or similar) must be wrapped in a `NavigationLink` that navigates to `ContactDetailView` for that contact. This applies everywhere in the app — dashboard, lists, detail pages, search results, etc. Never display a contact's avatar as a static, non-interactive element.

- **NavigationStack rules (avoid double back arrows):**
  - **Tab root views** (e.g., ContactListView, SettingsView): Own `NavigationStack` — they are the navigation root.
  - **Sheet-presented views** (e.g., ContactFormView, GroupFormView): Own `NavigationStack` — sheets need their own navigation context.
  - **Pushed views** (via `NavigationLink` / `.navigationDestination`): **NO** `NavigationStack` — they inherit from the parent. Adding one creates a double navigation bar with duplicate back arrows.
  - **iOS tab overflow** (>5 tabs): Use the explicit `MoreView` tab — the system-provided More tab adds its own `UINavigationController` and stacks a second back chevron on top of any inner `NavigationStack`. Overflow screens reached via `MoreView` are pushed views and must NOT wrap themselves in a `NavigationStack`.

- **Icon sizes must be consistent.** Detail view headers for tags, groups, and locations all use 36x36pt icons with `.font(.body)` and `RoundedRectangle(cornerRadius: 8)`. Do not use `icon1Size` for larger icons.

- **Hidden contacts must never appear outside Settings > Hidden Contacts.** Always filter with `!$0.isHidden && !$0.isMergedAway` in any contact list, picker, or display. This includes Met Via pickers, Introduced To pickers, ContactFormView, and network graph.

- **All contact lists default sort alphabetically by last name A-Z** using locale-aware comparison with firstName as tiebreaker.

- **Contact search must use `.searchable()` modifier** (native iOS search bar), not inline TextField. All search views should show avatar + name + company.

- **Data list rows use the shared `EntityListRow` component** (`Blackbook/Views/Components/EntityListRow.swift`). 36×36pt gradient icon, `RoundedRectangle(cornerRadius: 8)`, title `.body.weight(.medium)` with `lineLimit(2)`, subtitle `.caption .secondary`, `HStack(spacing: 12)`, `.padding(.vertical, 2)`. Use the trailing `@ViewBuilder` slot for accessories (chevrons, counts, badges). Settings rows are the exception — they use the smaller `SettingsRow` (28×28 icon).
