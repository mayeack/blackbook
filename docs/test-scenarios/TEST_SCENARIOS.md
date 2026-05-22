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

## 2026-05-22 — macOS cloud sync + 5-minute periodic sync on both platforms

**Summary:** macOS client now syncs with `sync.libersecretorum.com` (it previously did not), and both iOS and macOS now perform a full sync every 5 minutes while foregrounded, in addition to the existing launch sync.

**Setup:**
- Both apps signed in as `michaelyeack@gmail.com`.
- Central sync server (`sync.libersecretorum.com` → this Mac:8765) reachable.
- Clean launch (quit before first scenario).

**Steps:**
1. Launch macOS app cold → in Console.app (subsystem `com.blackbookdevelopment.app`, category `BonjourBrowser`) expect `Configured sync server: https://sync.libersecretorum.com for michaelyeack@gmail.com` within ~1s.
2. Same launch → category `LocalSync` should log `Pushing N record(s)` / `Pulled N …` lines, then `Local sync completed`, ~1–3s after launch.
3. Wait 5 minutes with the macOS app foregrounded and untouched → expect a second `Local sync completed` line (and `Periodic sync started (interval: 300s)` should already be in the log from step 2).
4. On iPhone, add a contact "SyncTest-iOS-<HHmm>" → within ≤5 min the contact appears in the macOS Contacts list without quitting/relaunching.
5. On macOS, add a contact "SyncTest-mac-<HHmm>" → within ≤5 min the contact appears on the iPhone without relaunching.
6. Quit macOS app, relaunch → expect a fresh launch sync within ~1s, then a 5-minute tick afterward.

**Edge cases:**
- Network drop during a periodic tick → `LocalServerSyncService.performFullSync()` logs the error but the loop keeps ticking; on next reachability + tick the offline queue flushes (existing behavior, unchanged by this fix).
- App backgrounded on iOS for >5 minutes → the Swift Task suspends; on foreground a new tick happens on the next 5-min boundary (no missed-tick catch-up; launch sync covers cold returns).
- Two ticks overlapping with a manual sync from settings (if added later) → `performFullSync()` already guards on `isSyncing` and returns early.

**Platforms:**
- iOS: needs user run on physical iPhone (build verified for `generic/platform=iOS`).
- macOS: build verified (`xcodebuild ... -destination 'platform=macOS'` BUILD SUCCEEDED); needs user run to observe the 5-min tick.
- BlackbookServer: build verified; no behavior changes in this fix.
