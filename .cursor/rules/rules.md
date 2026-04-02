---
description: Cross-platform macOS and iOS development best practices for SwiftUI, SwiftData, MVVM, networking, testing, performance, and accessibility.
alwaysApply: true
---

# Apple Platform Best Practices (macOS & iOS)

## Architecture — MVVM with @Observable

- Use `@Observable` (Observation framework) for all ViewModels. Avoid legacy `ObservableObject`/`@Published` in new code.
- Keep Views declarative and logic-free; push filtering, sorting, formatting, and validation into ViewModels or dedicated types.
- ViewModels must never import SwiftUI — depend only on Foundation, SwiftData, and domain modules.
- One ViewModel per feature screen. Share cross-cutting state via services injected through the Environment.

```swift
// ✅ GOOD — @Observable, no SwiftUI import
@Observable
final class ProfileViewModel {
    var name = ""
    private let store: ContactStore
    init(store: ContactStore) { self.store = store }
}

// ❌ BAD — legacy pattern, SwiftUI dependency in VM
class ProfileViewModel: ObservableObject {
    @Published var name = ""
}
```

## Cross-Platform Patterns

- Use `#if os(iOS)` / `#if os(macOS)` only at the leaf level — keep shared logic above the conditional.
- Wrap platform-divergent colors and metrics in a constants enum with `#if` blocks (see `AppConstants.UI`).
- Prefer `NavigationSplitView` on macOS and `TabView` on iOS; abstract tab/section definitions into shared types like `AppTab`.
- Test both schemes in CI; never merge code that only compiles on one platform.

```swift
// ✅ Shared enum, platform-specific presentation
enum AppTab: CaseIterable { case dashboard, contacts, settings }

// In ContentView
#if os(iOS)
TabView(selection: $tab) { /* ... */ }
#else
NavigationSplitView { /* sidebar */ } detail: { /* ... */ }
#endif
```

## SwiftUI Views

- **Name collision — `Group`:** This project has a SwiftData model named `Group`. Always use `SwiftUI.Group` (fully qualified) when you need SwiftUI's transparent container. Bare `Group { }` resolves to the model and causes cryptic errors like *"Value of type 'Group' has no member 'frame'"*.
- Decompose views into small, single-responsibility structs; extract repeated patterns into reusable components.
- Use `@State` for view-local transient state, `@Environment` for injected dependencies, and `@Bindable` to bind `@Observable` objects.
- Prefer `task {}` over `onAppear` for async work — it automatically cancels on disappear.
- Always provide a `Identifiable`-conforming `id` for `ForEach` collections; avoid `\.self` on non-trivial types.
- Set accessibility labels, traits, and hints on every interactive or informational element.
- **Form field labels must appear above the field**, not inline to its left. Use an explicit `Section` header for the label and apply `.labelsHidden()` on the `TextField` so macOS `Form` does not render a redundant side-by-side label. This keeps sheets consistent across platforms.

```swift
// ✅ GOOD — label above via section header
Section {
    TextField("Location Name", text: $name)
        .labelsHidden()
} header: {
    Text("Location Name")
}

// ❌ BAD — label renders to the left of the field on macOS
Section {
    TextField("Location Name", text: $name)
}
```

## SwiftData & Persistence

- Define models with `@Model`; prefer explicit property defaults and `@Relationship` annotations over implicit behavior.
- Use `@Attribute(.externalStorage)` for large binary blobs (photos, files).
- Always handle `ModelContainer` creation failures gracefully with fallback strategies (CloudKit → local → fresh store).
- Perform batch writes and expensive queries off the main actor using `ModelActor`.
- Never force-unwrap fetch results; use nil-coalescing or guard-let.

```swift
// ✅ Background writes via ModelActor
@ModelActor
actor BackgroundPersistence {
    func importContacts(_ data: [ContactDTO]) throws {
        for dto in data {
            let contact = Contact(firstName: dto.first, lastName: dto.last)
            modelContext.insert(contact)
        }
        try modelContext.save()
    }
}
```

## Networking & API Calls

- Use `async/await` with `URLSession` — never callback-based patterns in new code.
- Build requests through a dedicated service layer; do not scatter `URLSession` calls across ViewModels.
- Validate HTTP status codes explicitly; map non-2xx responses to typed errors.
- Set `timeoutInterval` on every request; default to 30 seconds.
- Parse responses with `Codable` and `JSONDecoder`; avoid raw `JSONSerialization` for model decoding.
- Store API keys in Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Never hardcode secrets.

```swift
// ✅ Typed error handling
guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
guard (200...299).contains(http.statusCode) else {
    throw APIError.httpError(statusCode: http.statusCode, body: data)
}
let result = try JSONDecoder().decode(T.self, from: data)
```

## Error Handling

- Use typed `Error` enums per module; include enough context to diagnose but never leak secrets.
- Present user-facing errors through an `@Observable` error-state property; avoid raw `alert(isPresented:)` with string messages.
- Log errors with `os.Logger` at appropriate levels (`.error`, `.fault`); include correlation context but never PII.
- Use `Result` or typed throws when callers need to distinguish failure modes.

## Logging

- Use `os.Logger` with subsystem (`Bundle.main.bundleIdentifier`) and per-module category.
- Log at `.debug` for development tracing, `.info` for lifecycle events, `.error` for recoverable failures, `.fault` for invariant violations.
- Never log tokens, passwords, full contact details, or other PII even at debug level.

## Testing

- Write unit tests for every ViewModel and Service using Swift Testing (`@Test`, `#expect`).
- Use protocol abstractions for services so ViewModels are testable with mocks/stubs.
- Test cross-platform conditional logic on both destinations; use `#if targetEnvironment(simulator)` guards only when unavoidable.
- Aim for snapshot/preview tests on key views; keep view-layer tests focused on state-driven output, not pixel matching.

```swift
@Test func filteredContactsMatchSearch() {
    let vm = ContactListViewModel()
    vm.searchText = "alice"
    let result = vm.filteredContacts(sampleContacts, tags: [])
    #expect(result.count == 1)
    #expect(result.first?.firstName == "Alice")
}
```

## Performance

- Use `@Query` with `SortDescriptor` and predicates to push filtering to the store; avoid fetching all records then filtering in-memory.
- Debounce search input (250ms) before triggering queries or network calls.
- Mark large images/data as `@Attribute(.externalStorage)` and load lazily.
- Profile with Instruments (Time Profiler, SwiftUI view body counts) before optimizing; don't guess.
- Use `LazyVStack` / `LazyVGrid` for long scrollable lists; avoid `List` with thousands of rows without pagination.

## Accessibility

- Every tappable element needs an `.accessibilityLabel` and `.accessibilityHint`.
- Use semantic containers: `.accessibilityElement(children: .combine)` for card-style rows.
- Support Dynamic Type — avoid fixed font sizes; use `.font(.body)`, `.font(.headline)`, etc.
- Test with VoiceOver on both macOS and iOS simulators as part of PR review.
- Provide `.accessibilityValue` for scores, progress, and other numeric indicators.

## Project Structure

Follow the established directory layout:

```
App/            — Entry point, root navigation
Models/         — SwiftData @Model types and domain enums
ViewModels/     — @Observable VMs, one per feature
Views/          — SwiftUI views grouped by feature subfolder
Services/       — Network, sync, scoring, AI services
Utilities/      — Keychain, date helpers, constants
```

- New features get a subfolder under `Views/` and a matching ViewModel.
- Shared UI components go in `Views/Components/`.
- Keep `Constants.swift` as the single source for magic numbers, colors, and config keys.

## Xcode Project File (pbxproj)

This project uses an Xcode `.xcodeproj` with explicit file references — it does **not** use folder references or a Swift Package that auto-discovers sources. When creating new `.swift` files, you **must** also register them in `Blackbook.xcodeproj/project.pbxproj`:

1. **PBXFileReference** — add an entry with a unique 24-character hex ID, the filename, `lastKnownFileType = sourcecode.swift`, and `sourceTree = "<group>"`.
2. **PBXBuildFile** — add an entry (another unique ID) referencing the file ref, so the file is compiled.
3. **PBXGroup** — if the file lives in a new subfolder under `Views/`, create a new PBXGroup for that folder and add it as a child of the `Views` group (`AF252EFB7C1EBC43B1A39370`). Add the file ref to the new group's `children`.
4. **PBXSourcesBuildPhase** — add the PBXBuildFile ID to the `files` array of the Sources phase (`4AD73BF9E229F9D3CF7FBD44`).

Without all four steps, Xcode will report "Cannot find 'TypeName' in scope" even though the file exists on disk.

**Verification:** After creating any new `.swift` file, search the pbxproj for the filename to confirm all four entries exist. If any are missing, add them before considering the task complete.

## UI Design Tokens & Consistency

All UI components must use the centralized constants in `AppConstants.UI`. When adding new views or features, follow these exact sizing and styling specifications to keep the app visually consistent.

### Typography Hierarchy

| Style | Font | Foreground | Usage |
|---|---|---|---|
| **Header 1** | `.title.weight(.bold)` | `.primary` | Detail screen titles, page-level headings, top-level section titles |
| **Header 2** | `.title3.weight(.bold)` | `.primary` | Table/list column headers, filter row labels (e.g. Contacts table: Name, Groups, Locations, Tags, Met via, Introduced to, Score; filter row labels: Tags, Groups, Locations) |
| **Header 3** | `.headline.weight(.bold)` | `.primary` | Card titles, subsection headings, grouped content labels |

When adding new table or list views with column headers, use the **Header 2** style for column labels. Use **Header 1** for top-level page or detail-view titles, and **Header 3** for smaller subsection or card-level headings.

### Spatial Density & Typography — Use Space Generously

The app targets desktop (macOS) and tablet-class screens with ample real estate. Content must feel **comfortable and easy to scan**, not cramped. Follow these principles:

- **Minimum readable font is `.subheadline`** — never use `.caption2` for user-facing content. `.caption` is the absolute floor for metadata/timestamps. Use `.body` or larger for primary content.
- **Section labels** (field headings like "Phone", "Met via") use `.subheadline.weight(.semibold)` — not `.caption`.
- **Primary content values** (phone numbers, names, note bodies) use `.body` or larger.
- **Titles on detail screens** use `.title.weight(.bold)` — not `.title2` or smaller.
- **Stat rows** in cards use `.subheadline` for both label and value.
- **Card internal padding** uses `AppConstants.UI.cardPadding` (16pt).
- **Section spacing** between content blocks uses `AppConstants.UI.sectionSpacing` (20pt).
- **Chip padding** uses `AppConstants.UI.chipPaddingH` (10) / `chipPaddingV` (5) — not 8/3.
- **Avatar sizes:** profile header = `AppConstants.UI.profileAvatarSize` (96pt), inline references = `AppConstants.UI.metViaAvatarSize` (36pt).
- **Score ring** = `AppConstants.UI.scoreRingSize` (80pt), score text = `.title2.weight(.bold)`, category label = `.caption`.
- **Interaction row icons** = `AppConstants.UI.interactionIconSize` (40pt).

When in doubt, round **up** to the next font size / spacing tier. Small cramped text on a large screen is a worse UX problem than slightly generous spacing.

### Icon Styles

#### Icon 1

Used for prominent, standalone icon badges in collection rows and detail headers where the icon is a key visual anchor (e.g. Location rows and headers).

```swift
Image(systemName: icon)
    .font(.title3)
    .foregroundStyle(.white)
    .frame(width: AppConstants.UI.icon1Size, height: AppConstants.UI.icon1Size)
    .background(color.gradient, in: RoundedRectangle(cornerRadius: 10))
```

- **Size:** `AppConstants.UI.icon1Size` (48×48)
- **Corner radius:** 10
- **Icon font:** `.title3`
- **Background:** `color.gradient` inside `RoundedRectangle`

#### Row Icon Badges (Tag, Group, and any future collection-type rows)

```swift
Image(systemName: icon)
    .font(.body)
    .foregroundStyle(.white)
    .frame(width: 36, height: 36)
    .background(color.gradient, in: RoundedRectangle(cornerRadius: 8))
```

- **Size:** 36×36
- **Corner radius:** 8
- **Icon font:** `.body`
- **Background:** `color.gradient` inside `RoundedRectangle`

### Row Layout (List item rows for Tags, Groups, and future collections)

```swift
HStack(spacing: 12) {
    // icon badge (36×36, see Row Icon Badges)
    VStack(alignment: .leading, spacing: 2) {
        Text(name)
            .font(.body.weight(.medium))
        Text("\(count) contact\(count == 1 ? "" : "s")")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
    Spacer()
}
.padding(.vertical, 2)
```

- **HStack spacing:** 12
- **Name font:** `.body.weight(.medium)`
- **Subtitle font:** `.caption`, `.secondary` foreground
- **VStack spacing:** 2
- **Vertical padding:** 2
- **Do not** add duplicate data (e.g. a second count badge) on the trailing side of the row.

### Location Row Layout

Location rows use **Icon 1** for the badge and **Header 1** for the name to give locations greater visual prominence.

```swift
HStack(spacing: 12) {
    // Icon 1 badge (48×48, see Icon 1)
    VStack(alignment: .leading, spacing: 4) {
        Text(name)
            .font(.title.weight(.bold))
        Text("\(count) contact\(count == 1 ? "" : "s")")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
    Spacer()
}
.padding(.vertical, 4)
```

- **Icon style:** Icon 1 (48×48)
- **Name font:** Header 1 — `.title.weight(.bold)`
- **Subtitle font:** `.caption`, `.secondary` foreground
- **VStack spacing:** 4
- **Vertical padding:** 4

### Detail View Headers (Tag, Group, and future collection detail pages)

Use the same sizing as row icons — detail headers should feel like a natural extension of the list row, not a different component.

```swift
Section {
    HStack(spacing: 12) {
        Image(systemName: icon)
            .font(.body)
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(color.gradient, in: RoundedRectangle(cornerRadius: 8))
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
                .font(.body.weight(.medium))
            Text("\(count) contact\(count == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        Spacer()
    }
    .padding(.vertical, 2)
}
```

- **Icon size:** 36×36 (same as rows)
- **Corner radius:** 8
- **HStack spacing:** 12
- **Name font:** `.body.weight(.medium)`
- **Subtitle font:** `.caption`
- **VStack spacing:** 2
- **Vertical padding:** 2

### Location Detail Header

Location detail headers use **Icon 1** and **Header 1** to match the Location Row Layout.

```swift
Section {
    HStack(spacing: 12) {
        Image(systemName: icon)
            .font(.title3)
            .foregroundStyle(.white)
            .frame(width: AppConstants.UI.icon1Size, height: AppConstants.UI.icon1Size)
            .background(color.color.gradient, in: RoundedRectangle(cornerRadius: 10))
        VStack(alignment: .leading, spacing: 4) {
            Text(name)
                .font(.title.weight(.bold))
            Text("\(count) contact\(count == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        Spacer()
    }
    .padding(.vertical, 4)
}
```

- **Icon style:** Icon 1 (48×48, cornerRadius 10, `.title3` font)
- **Name font:** Header 1 — `.title.weight(.bold)`
- **Subtitle font:** `.caption`
- **VStack spacing:** 4
- **Vertical padding:** 4

### Dashboard Contact Rows (Fading Relationships, Strongest Relationships, and future dashboard cards)

Contact rows inside Dashboard cards must use the **same sizing as the Contacts page** (expanded layout) to keep text and avatars visually consistent across pages.

```swift
HStack(spacing: 12) {
    ContactAvatarView(contact: c, size: 36)
    VStack(alignment: .leading, spacing: 2) {
        Text(c.displayName)
            .font(.body.weight(.medium))
        // optional subtitle
        Text("Last: \(date.relativeDescription)")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
    Spacer()
    ScoreBadgeView(score: c.relationshipScore)
}
.padding(.vertical, 2)
```

- **Avatar size:** 36 (matches Contacts expanded layout)
- **Name font:** `.body.weight(.medium)` — **not** `.subheadline`
- **Subtitle font:** `.caption` — **not** `.caption2`
- **HStack spacing:** 12
- **VStack spacing:** 2
- **Vertical padding:** 2
- The Strongest Relationships card prepends a rank label (`#1`, `#2`, …) before the avatar using `.caption.weight(.bold).monospacedDigit()` in a 24pt-wide frame.

### Empty States

All empty states for collection screens (Tags, Groups, Locations, Contacts, and future collections) must use `ContentUnavailableView` with a label, description, and a primary action button.

```swift
ContentUnavailableView {
    Label("No [Items]", systemImage: "section.icon")
} description: {
    Text("Create [items] to organize your contacts.")
} actions: {
    Button("New [Item]") { showAdd = true }
        .buttonStyle(.borderedProminent)
        .tint(AppConstants.UI.accentGold)
}
```

- **Button style:** `.borderedProminent`
- **Tint:** `AppConstants.UI.accentGold`
- **Description:** short, action-oriented sentence
- Empty states that are contextual sub-sections (e.g. "No reminders" within a contact detail) may omit the action button.

### Primary Action Buttons (inside detail views)

For "Add Contacts" or similar primary actions shown inline in a `List`:

```swift
Button { action() } label: {
    Label("Add Contacts", systemImage: "person.badge.plus")
        .frame(maxWidth: .infinity)
}
.buttonStyle(.borderedProminent)
.tint(AppConstants.UI.accentGold)
.listRowBackground(Color.clear)
```

### Toolbar Plus Buttons

All list screens with a creation action use a toolbar plus button:

```swift
ToolbarItem(placement: .primaryAction) {
    Button { showAdd = true } label: { Image(systemName: "plus") }
}
```

### Detail View Toolbar Menus

All detail views for collections (Tag, Group, Location) use an ellipsis menu with Edit and Add Contacts:

```swift
ToolbarItem(placement: .primaryAction) {
    Menu {
        Button { showEdit = true } label: {
            Label("Edit [Item]", systemImage: "pencil")
        }
        Button { showAddContacts = true } label: {
            Label("Add Contacts", systemImage: "person.badge.plus")
        }
    } label: {
        Image(systemName: "ellipsis.circle")
    }
}
```

### Sheet / Modal Form Padding

All `Form` views presented as `.sheet` modals (e.g., `LocationFormView`, `TagFormView`, `GroupFormView`, `ActivityFormView`, `ContactFormView`) must include consistent outer padding so content does not press against the modal edges:

```swift
Form {
    // sections…
}
.padding(.horizontal, 8)
.padding(.vertical, 4)
```

- **Horizontal padding:** 8pt
- **Vertical padding:** 4pt
- Apply directly to the `Form`, before any `.navigationTitle` or other modifiers.
- This applies to every create/edit form sheet in the app. When adding a new form sheet, include these padding modifiers.

### Card Corner Radii

Use consistent corner radii across the app:

- **Icon 1 badges:** 10
- **Row icon badges:** 8
- **Dashboard cards:** 12
- **Sheet/modal containers:** system default (no override)

### Colors

- **Accent / primary actions:** `AppConstants.UI.accentGold`
- **Score colors:** use `AppConstants.UI.scoreColor(for:)`
- **Card backgrounds:** `AppConstants.UI.cardBackground`
- **Destructive swipe actions:** `.destructive` role or `.tint(.orange)` for non-destructive removals

### Add-to-Collection Sheets (Add Contacts to Tag/Group/Location)

All "Add Contacts" sheets must follow the same structure:

- `NavigationStack` with `List`
- Inline search `TextField` in a headerless `Section`
- Optional "Suggested" section when relevant
- "All Contacts" / "Results" section
- Cancel and "Add (N)" toolbar buttons
- macOS frame: `minWidth: 450, idealWidth: 500, minHeight: 500, idealHeight: 600`
- Selection indicator: `checkmark.circle.fill` / `circle`, tinted `AppConstants.UI.accentGold`

### Creating New Collection Types

When adding a new collection-style feature (like Tags, Groups, or Locations), follow the existing pattern exactly:

1. **Model:** `@Model` in `Models/` with `name`, icon/color properties, and a `contacts` relationship.
2. **List View:** `NavigationStack` → `SwiftUI.Group` → empty state / `List` with `ForEach` and `NavigationLink`. Include `.searchable`, toolbar plus button, swipe-to-delete, and a sheet for the form.
3. **Row View:** use the standard row layout above.
4. **Detail View:** `List` with `headerSection` and `membersSection`. Header uses the standard detail header above. Members section includes the "Add Contacts" button, search-empty state, and `ForEach` with swipe-to-remove.
5. **Form View:** presented as a sheet with Cancel/Save toolbar buttons.
6. **Add Contacts View:** follows the standard add-to-collection sheet pattern above.

## Data Integrity — Tags, Groups, and Locations

Tags, Groups, and Locations are **persistent, user-created organizational records**. They must survive app restarts, re-launches, and SwiftData container re-creation.

- **NEVER delete** a Tag, Group, or Location record programmatically unless the user **explicitly** initiates the deletion (e.g., swipe-to-delete, a "Delete" button they tap/click, or a confirmed destructive action).
- Do not use `modelContext.delete()` on these types in seed data routines, migration helpers, onboarding flows, or cleanup logic.
- Do not drop or recreate the `ModelContainer` in a way that discards existing stores. Use additive migrations and fallback strategies that preserve data.
- When resetting or debugging, only delete records the user has selected — never wipe entire collections silently.
- If a feature requires clearing data (e.g., "Reset to Defaults"), gate it behind an explicit, user-confirmed destructive action with a warning.
- Treat accidental data loss of these records as a **critical bug**.

## Page Documentation Sync

Every menu item and its pages are documented in `.cursor/pages/*.md`. These files are the single source of truth for what each page looks like and how it behaves. They must stay in sync with the code.

**File mapping:**

| Views directory / file(s) | Documentation file |
|---|---|
| `Views/Dashboard/DashboardView.swift`, `Views/Dashboard/AIInsightsView.swift` | `.cursor/pages/Dashboard.md` |
| `Views/Contacts/*.swift`, `Views/Interactions/*.swift` | `.cursor/pages/Contacts.md` |
| `Views/Tags/*.swift`, `Views/Settings/TagManagerView.swift` | `.cursor/pages/Tags.md` |
| `Views/Groups/*.swift`, `Views/Settings/GroupManagerView.swift` | `.cursor/pages/Groups.md` |
| `Views/Locations/*.swift`, `Views/Settings/LocationManagerView.swift` | `.cursor/pages/Locations.md` |
| `Views/Network/NetworkGraphView.swift` | `.cursor/pages/Network.md` |
| `Views/Reminders/RemindersView.swift` | `.cursor/pages/Reminders.md` |
| `Views/Settings/SettingsView.swift`, `Views/Settings/IconAndColorPickers.swift` | `.cursor/pages/Settings.md` |

**Rules:**

1. When you modify a View file listed above, you **must** update the corresponding `.cursor/pages/*.md` file in the same change to reflect the new state of the page.
2. When you add a new View or sub-page to an existing section, add its documentation to the matching `.md` file.
3. When you create a new top-level menu item (new `AppTab` case), create a new `.cursor/pages/<Name>.md` file following the same format as the existing docs and add the mapping to this table.
4. Updates should reflect actual changes — do not rewrite the entire doc for minor edits; add, remove, or modify only the affected sections.
5. The documentation must be detailed enough to rebuild the page from scratch: include layout hierarchy, data sources, navigation, toolbar items, sheet presentations, empty states, and component specifications.

## Code Style

- Prefer `let` over `var`; use `var` only when mutation is required.
- Use trailing closure syntax; omit argument labels when the closure is the only or final parameter.
- Mark classes `final` unless designed for inheritance.
- Use `guard` for early exits; avoid deep nesting.
- Group related properties and methods with `// MARK: -` sections.
- Keep files under 300 lines; extract helpers when a file grows beyond that.

## CloudKit & Sync

- Default to `.private` CloudKit database for user data; never store sensitive data in `.public`.
- Handle `CKError` codes gracefully — especially `.networkUnavailable`, `.quotaExceeded`, and `.serverRecordChanged`.
- Provide offline-first UX: persist locally first, sync in background, surface conflicts through UI.
- Test sync behavior by toggling airplane mode and verifying data integrity on restore.

## Security

- Store all secrets (API keys, tokens) in Keychain — never in UserDefaults, plists, or source code.
- Use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` for device-bound secrets.
- Validate and sanitize all external input (API responses, imported files, user text fields).
- Enable App Transport Security; never add blanket `NSAllowsArbitraryLoads` exceptions.
- Use certificate pinning for high-value API endpoints when feasible.

## Build — Swift & SwiftUI Compilation

These patterns have caused real build failures. Follow them strictly to keep the project compiling.

### Button Initializer Syntax

Never use `Button(action: methodReference)` with a trailing closure for the label. The compiler matches it to `init(role:action:)` instead of `init(action:label:)`. Always use the explicit `label:` parameter:

```swift
// ❌ BAD — ambiguous overload, compiler picks init(role:action:)
Button(action: signIn) {
    Text("Sign In")
}

// ❌ STILL BAD — closure wrapper doesn't help
Button(action: { signIn() }) {
    Text("Sign In")
}

// ✅ GOOD — explicit label: parameter, no ambiguity
Button {
    signIn()
} label: {
    Text("Sign In")
}
```

### SwiftUI.Group Qualification

Already documented above — `Group` resolves to the SwiftData model. Always write `SwiftUI.Group { }`.

### Exhaustive Switch on SDK Enums

Amplify and other SDK enums may add cases in future versions. Always include `@unknown default` to prevent non-exhaustive switch errors. Use `String(describing:)` for logging since many SDK enums don't conform to `CustomStringConvertible`.

```swift
// ✅ GOOD
switch result.nextStep {
case .confirmUser:
    authState = .confirmSignUp(email: email)
case .done:
    await signIn(email: email, password: password)
@unknown default:
    logger.warning("Unhandled step: \(String(describing: result.nextStep))")
}
```

### Decimal from StoreKit Prices

StoreKit `Product.price` is `Decimal`, which doesn't conform to `BinaryInteger`. Never write `Int(decimalValue)`. Use `NSDecimalNumber` for conversion:

```swift
// ❌ BAD — won't compile
Text("Save \(Int(savings))%")

// ✅ GOOD
Text("Save \(NSDecimalNumber(decimal: savings).intValue)%")
```

### JSONEncoder vs JSONSerialization

`JSONEncoder` requires `Encodable` conformance. `[String: Any]` doesn't conform. Use `JSONSerialization` for untyped dictionaries:

```swift
// ❌ BAD — [String: Any] is not Encodable
let data = try JSONEncoder().encode(dict)

// ✅ GOOD
let data = try JSONSerialization.data(withJSONObject: dict)
```

### os.Logger String Interpolation

`os.Logger` uses `OSLogMessage` interpolation, not standard Swift interpolation. Property references inside logger calls may require explicit `self.` in certain contexts. Non-`CustomStringConvertible` types need `String(describing:)`:

```swift
// ❌ BAD — may fail in closures or with non-conforming types
logger.info("Count: \(offlineQueue.count)")
logger.info("Step: \(result.nextStep)")

// ✅ GOOD
logger.info("Count: \(self.offlineQueue.count)")
logger.info("Step: \(String(describing: result.nextStep))")
```

## CI/CD — GitHub Actions & Fastlane

### Xcode Version Must Match Project Format

The project uses Xcode 26 format (version 77). CI runners must use a compatible Xcode. The `macos-15` runner provides Xcode 26.3. Always keep the CI Xcode version in sync with the local development version:

```yaml
# .github/workflows/ci.yml
runs-on: macos-15
steps:
  - name: Select Xcode
    run: sudo xcode-select -s /Applications/Xcode_26.3.app
```

If upgrading Xcode locally, update the CI workflow in the same commit.

### Simulator Destination Must Exist on Runner

Use simulator device names available on the CI runner image. Currently `iPhone 16` on `macos-15`. Check runner image release notes when updating.

### SPM Package Resolution Timeout

Fastlane's `build_app` calls `xcodebuild -showBuildSettings`, which resolves SPM packages with a 3-second default timeout. For projects with many dependencies (Amplify, AWS SDK, etc.), this always times out. Fix both:

1. **Pre-resolve packages** as a separate CI step before Fastlane runs
2. **Increase the timeout** via environment variable

```yaml
- name: Resolve packages
  run: xcodebuild -resolvePackageDependencies -project Blackbook.xcodeproj -scheme Blackbook

- name: Deploy to TestFlight
  env:
    FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT: 120
  run: fastlane ios beta
```

### Code Signing in CI

Automatic signing doesn't work on CI runners. The Fastlane `beta` lane must explicitly configure signing when running in CI:

```ruby
if is_ci
  update_code_signing_settings(
    use_automatic_signing: false,
    path: "Blackbook.xcodeproj",
    team_id: "37NR4Z7NT6",
    profile_name: "match AppStore com.blackbookdevelopment.app",
    code_sign_identity: "Apple Distribution"
  )
end
```

### Fastlane Match — Private Repo Access

Match stores encrypted certificates in a private git repo. CI runners can't interactively authenticate, so provide a base64-encoded PAT:

1. Create a GitHub PAT with `repo` scope
2. Base64 encode: `echo -n "username:token" | base64`
3. Store as `MATCH_GIT_BASIC_AUTHORIZATION` secret
4. Pass to Fastlane as an environment variable in the workflow

### Required GitHub Secrets

The deploy-testflight job requires all of these secrets to be configured:

| Secret | Purpose |
|---|---|
| `ASC_KEY_ID` | App Store Connect API Key ID |
| `ASC_ISSUER_ID` | App Store Connect API Issuer ID |
| `ASC_KEY_CONTENT` | Base64-encoded `.p8` API key file |
| `ITC_TEAM_ID` | App Store Connect team ID |
| `MATCH_GIT_URL` | Private certs repo URL |
| `MATCH_PASSWORD` | Encryption password for Match certs |
| `MATCH_GIT_BASIC_AUTHORIZATION` | Base64 `username:PAT` for repo access |

If any secret is missing or wrong, the deploy will fail silently or with cryptic errors. After rotating any credential, update the corresponding secret immediately.

### Git Identity on Build Machines

Fastlane Match commits encrypted certs to the certs repo. Git requires `user.name` and `user.email` to be configured. On fresh machines or CI runners, `setup_ci` handles this, but on local machines ensure global git config is set before running `fastlane match`:

```bash
git config --global user.name "Your Name"
git config --global user.email "your-email"
```

## App Store Validation — TestFlight Upload

These are hard requirements enforced by App Store Connect. A build will upload but be rejected if any are missing.

### App Icon

The asset catalog must include a 1024x1024 PNG referenced in `AppIcon.appiconset/Contents.json` with a `"filename"` key. Empty icon slots (no filename) cause validation failure:

```json
{
  "filename": "AppIcon.png",
  "idiom": "universal",
  "platform": "ios",
  "size": "1024x1024"
}
```

### iPad Interface Orientations

All four orientations must be specified for iPad multitasking support. Missing `UIInterfaceOrientationPortraitUpsideDown` causes rejection:

```
INFOPLIST_KEY_UISupportedInterfaceOrientations = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
INFOPLIST_KEY_UISupportedInterfaceOrientations~ipad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
```

### Launch Screen

Apps targeting iOS 14+ must declare a launch screen. Set this build setting:

```
INFOPLIST_KEY_UILaunchScreen_Generation = YES
```

### Files Referenced in Xcode Project Must Exist

If the Xcode project references a file (e.g., `amplifyconfiguration.json`), that file must be present in the repo for CI builds. Either commit the file (with placeholder values) or generate it in a CI step before building. Check `.gitignore` whenever a CI build fails with "No such file or directory".

## Pre-Push Checklist

Before pushing to `main` (which triggers the full CI/CD pipeline):

1. **Local build succeeds:** `xcodebuild build -scheme Blackbook -destination 'generic/platform=iOS Simulator'`
2. **No new compiler warnings** in files you touched
3. **All switch statements** on SDK enums have `@unknown default`
4. **No `Button(action:)` with trailing closures** — use `Button { } label: { }` syntax
5. **No bare `Group { }`** in view code — use `SwiftUI.Group { }`
6. **All files referenced in pbxproj exist on disk** and are not gitignored
7. **App icon PNG present** in `AppIcon.appiconset/` with filename in `Contents.json`
8. **CI workflow Xcode version matches** local Xcode version
