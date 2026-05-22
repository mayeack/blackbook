# Blackbook Test Scenarios

Running, append-only log of manual test scenarios for completed features and bug fixes. Maintained automatically — every time a feature is finished, a new dated section is added.

## Conventions

- **Append only.** Never rewrite earlier sections. If a scenario is superseded by later work, add a new dated section that references the old one.
- **Heading style:** `## YYYY-MM-DD — <feature title>` (mirrors `work_log.md`).
- **Each section includes:**
  - One-line **Summary** of what was built/fixed.
  - **Setup** — preconditions (signed-in account, data state, platform, build flavor).
  - **Steps** — numbered, specific user actions.
  - **Expected** — what success looks like for each step.
  - **Edge cases** — second-order things to verify (empty states, offline, permission denials, large data, multi-device, etc.).
  - **Platforms** — which platforms Claude built/ran vs. which still need a real-device run by the user. Be explicit about gaps.
- Keep scenarios reproducible: name exact tap paths, exact toolbar items, exact expected text. Avoid vague phrases like "verify it works".

## Section template

```
## YYYY-MM-DD — <feature title>

**Summary:** <one line>

**Setup:**
- <preconditions>

**Steps:**
1. <action> → <expected>
2. ...

**Edge cases:**
- <case> → <expected>

**Platforms:**
- iOS: <verified by Claude / needs user run>
- macOS: <verified by Claude / needs user run>
- BlackbookServer: <verified by Claude / needs user run / N/A>
```

---

<!-- Append new dated sections below this line -->

## 2026-05-22 — Unify Suggested Activities list styling

**Summary:** Removed the explicit `.listStyle(.plain)` on the Suggested Activities list so it inherits the iOS default `.insetGrouped`, matching the top Activities list and the rest of the app's tab roots.

**Setup:**
- Signed-in account with Google Calendar connected (`Settings → Google Calendar → Connected`).
- At least 1 existing Activity and at least 1 upcoming calendar event surfacing in suggestions (e.g., create a calendar event for tomorrow on a synced calendar).
- iOS 17+ device or Simulator (iPhone 17 simulator preferred).

**Steps:**
1. Open the Activities tab → both the top "Activities" list and the bottom "Suggested Activities" list render inside identical rounded grey card chrome with the same horizontal insets.
2. Inspect the rows in both sections → 36×36 gradient icon (yellow for activities, blue for suggestions), title in `.body.weight(.medium)`, subtitle in `.caption .secondary`. Row anatomy is visually identical between top and bottom.
3. Pull down on the top list → spinner appears, calendar refreshes.
4. Pull down on the bottom (Suggested) list → spinner appears, calendar refreshes (event list updates if new events landed).
5. Swipe right on a suggested row → full-swipe commits the green "Add" action, the event is inserted as an Activity and disappears from suggestions, then appears in the top list.
6. Swipe left on a suggested row → full-swipe commits the red "Archive" action, the event is rejected and disappears from suggestions.
7. Tap an activity in either list → navigates to its detail view.
8. Scroll the whole screen → header bar above Suggested ("📅 SUGGESTED ACTIVITIES … From your Google Calendar") still renders above the new card; the Divider between sections is still visible.

**Edge cases:**
- No activities yet → top half shows `ContentUnavailableView` ("No Activities") with the "New Activity" button; bottom half unchanged.
- Google Calendar not configured → bottom half shows "Connect Google Calendar" empty state with Configure-in-Settings button; no list chrome at all.
- Google signed-in but loading → bottom half shows `ProgressView("Loading suggestions…")`; no list chrome.
- Google signed-in with no suggestions → bottom half shows "No Suggestions" empty state; no list chrome.
- Long activity title (2+ lines) → row still respects `lineLimit(2)`, trailing accessory (contact/group counts) still right-aligned and clipped to 200pt max width.
- Other tabs (Contacts, Tags, More, Groups, Locations) → render unchanged from before.

**Platforms:**
- iOS: built clean by Claude (`xcodebuild build` on iPhone 17 simulator). UI verification on a running Simulator/device needs user run.
- macOS: not exercised (Activities tab on macOS uses the same SwiftUI). Build untouched; should still compile, but a quick build is worth running.
- BlackbookServer: N/A.
