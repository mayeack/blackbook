# Settings

**Menu item:** Settings
**Tab icon:** `gear`
**Root view:** `SettingsView` in `Blackbook/Views/Settings/SettingsView.swift`

## Overview

The Settings tab provides app configuration: contact sync, privacy (hidden contacts), AI API key management, relationship scoring tuning, and version info. Uses a grouped `Form` layout.

## Pages

### SettingsView

**File:** `Blackbook/Views/Settings/SettingsView.swift`

**Data sources:**
- `ContactSyncService` — `@State private var syncService`
- `hasAPIKey: Bool` — checked on appear via `KeychainService.retrieve`

**Layout:** `NavigationStack` > `Form` with `.formStyle(.grouped)`.

**Navigation title:** "Settings"

**Sections:**

1. **Contacts** (`contactsSyncSection`)
   - "Import from Contacts" button row
   - `SettingsRow` with icon `person.crop.rectangle.stack.fill` (blue), subtitle: sync status
   - Shows `ProgressView` while syncing, chevron otherwise
   - Error display: red warning with `exclamationmark.triangle.fill`, optional CloudKit troubleshooting hint
   - Action: requests contact access, imports contacts, starts change observer

2. **Privacy** (`hiddenContactsSection`)
   - `NavigationLink` → `HiddenContactsView`
   - `SettingsRow` with icon `eye.slash.fill` (secondary), subtitle: "View and unhide contacts"

3. **AI Assistant** (`aiSection`)
   - Button → sheet `APIKeyEntryView`
   - `SettingsRow` with icon `brain` (purple), subtitle: "API key configured" or "No API key set"
   - Trailing: green checkmark circle if configured, "Configure" text (accent gold) if not
   - Footer: "Powers AI-driven relationship insights and suggestions."

4. **Scoring** (`scoringSection`)
   - `NavigationLink` → `ScoringSettingsView`
   - `SettingsRow` with icon `chart.bar.fill` (orange), subtitle: "Adjust scoring weights and thresholds"

5. **About** (`aboutSection`)
   - `SettingsRow` with icon `info.circle.fill` (gray), trailing: "1.0.0"

### SettingsIcon (Private Component)

- SF Symbol icon (14pt semibold, white) in 28x28 colored rounded rect (cornerRadius 6, continuous)

### SettingsRow (Private Component)

- `HStack(spacing: 12)`: SettingsIcon + VStack(title, optional subtitle caption secondary) + Spacer + trailing content
- `.contentShape(Rectangle())`

---

### ScoringSettingsView

**File:** `Blackbook/Views/Settings/SettingsView.swift` (same file)

**Purpose:** Adjust relationship scoring weights and fading threshold.

**Data sources:** `@AppStorage` bindings for each scoring weight and threshold, defaulting to `AppConstants.Scoring` values.

**Layout:** `Form` with `.formStyle(.grouped)`.

**Navigation title:** "Scoring"

**Sections:**

1. **Weights:**
   - `WeightSlider` for: Recency (blue), Frequency (green), Variety (orange), Sentiment (purple)
   - Each: label + percentage value + Slider (0–1, step 0.05)
   - Footer: total weight percentage — red and bold if not ~100%, secondary otherwise

2. **Thresholds:**
   - Fading Alert Threshold: label + int value + Slider (10–50, step 5, tinted fadingRed)
   - Footer: "Contacts scoring below this value will trigger a fading alert."

3. **Reset to Defaults:** Destructive button, centered, resets all values to `AppConstants.Scoring` defaults with animation.

### WeightSlider (Component)

- `VStack(alignment: .leading, spacing: 8)`: label (subheadline) + percentage (monospaced, secondary) + colored Slider
- Vertical padding: 2

---

### HiddenContactsView

**File:** `Blackbook/Views/Settings/SettingsView.swift` (same file)

**Purpose:** View and manage hidden contacts.

**Data sources:** `@Query(sort: \Contact.lastName)` — all contacts, filtered to hidden only

**Layout:** Conditional empty state or `List`.

**Navigation title:** "Hidden Contacts", inline on iOS.

**Empty state:** `ContentUnavailableView` — "No Hidden Contacts" / "Contacts you hide will appear here."

**List rows:** Avatar (40) + name + company + "Unhide" button (accent gold text).

**Search:** `.searchable(text:prompt:)` — "Search hidden contacts..."

**Toolbar:** Plus button → sheet `HideContactsView`

---

### HideContactsView

**File:** `Blackbook/Views/Settings/SettingsView.swift` (same file)

**Purpose:** Bulk-select contacts to hide. Presented as a sheet.

**Data sources:**
- `@Query(sort: \Contact.lastName)` — all contacts
- Local `selectedIDs: Set<UUID>`, `searchText`

**Layout:** `NavigationStack` > `List`:
1. Search `TextField` in headerless section
2. "All Contacts" / "Results" section with contact rows or empty state

**Contact row:** Avatar (36) + name + company + selection circle (`checkmark.circle.fill` / `circle`, accent gold)

**Toolbar:** Cancel + "Hide (N)" (disabled if none selected)

**macOS frame:** `minWidth: 450, idealWidth: 500, minHeight: 500, idealHeight: 600`

**Save logic:** Sets `isHidden = true` and updates `updatedAt` for all selected contacts. Saves context, dismisses.

---

### APIKeyEntryView

**File:** `Blackbook/Views/Settings/SettingsView.swift` (same file)

**Purpose:** Enter and save Claude API key. Presented as a sheet.

**Layout:** `NavigationStack` > `Form` with `.formStyle(.grouped)`.

**Navigation title:** "Claude API Key", inline on iOS.

**Sections:**
1. API key input: `SettingsIcon(key.fill, purple)` + `SecureField` with autocapitalization off, autocorrect off
   - Footer: "Your API key is stored securely in the system Keychain and never leaves this device."
2. Success feedback (after save): green checkmark + "API key saved successfully"

**Toolbar:** Cancel + Save (disabled if key is whitespace-only)

**Save logic:** Trims key, saves to Keychain via `KeychainService.save(service:account:)`, shows success, calls `onSave()` callback, auto-dismisses after 1 second.
