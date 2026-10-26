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
- Both apps signed in as `owner@example.com`.
- Central sync server (`sync.libersecretorum.com` → this Mac:8765) reachable.
- Clean launch (quit before first scenario).

**Steps:**
1. Launch macOS app cold → in Console.app (subsystem `com.blackbookdevelopment.app`, category `BonjourBrowser`) expect `Configured sync server: https://sync.libersecretorum.com for owner@example.com` within ~1s.
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

## 2026-05-22 — Sync heartbeat for sync-health observability

**Summary:** Added a server-side `POST /heartbeat` endpoint and client-side heartbeat pings sent at the start and end of every `performFullSync()` call (success, failure, or skip). Each heartbeat lands as a JSONL line in `<Application Support>/Blackbook/Logs/<sanitized_email>/heartbeats-YYYY-MM-DD.jsonl` on the macOS host so you can grep the file to verify both iOS and macOS are checking in.

**Setup:**
- Both apps signed in as `owner@example.com`.
- macOS Blackbook running and serving port 8765 (status of `lsof -i :8765` shows `Blackbook (LISTEN)`).
- Cloudflare tunnel `cloudflared-libersecretorum` running.

**Steps:**
1. Launch macOS app → within ~3s `tail -f ~/Library/Containers/com.blackbookdevelopment.app/Data/Library/Application\ Support/Blackbook/Logs/owner_at_example_com/heartbeats-$(date -u +%Y-%m-%d).jsonl` should show two entries: one `"status":"started"` and one `"status":"success"`, both `"platform":"macOS"`, `"device":"Michael's Mac mini"`.
2. Wait 5 minutes → expect two more entries (next periodic tick).
3. Launch iOS app → expect two more entries with `"platform":"iOS"` and the iPhone's device name.
4. Disconnect macOS from the network, wait for a tick → expect a `"status":"failed"` entry with an `"error"` field after reconnect.
5. Sign out on iOS → no further iOS heartbeats until sign-in restored.
6. `cat heartbeats-*.jsonl | jq -r '[.receivedAt,.platform,.status] | @tsv'` gives a chronological health timeline by platform.

**Edge cases:**
- Heartbeat endpoint unreachable mid-sync → sync still completes (heartbeat call is best-effort with 5s timeout, doesn't throw).
- Server unreachable for full sync → client sends `"status":"skipped"` with error `"server not configured"` *if* the URL is absent in Keychain; if URL is present but server is down, the heartbeat itself times out silently (no record written — which is itself a signal).
- Concurrent ticks — `performFullSync` guards on `isSyncing`, so only one heartbeat pair per actual sync execution.

**Platforms:**
- iOS: build verified (`xcodebuild build … -destination 'generic/platform=iOS'` BUILD SUCCEEDED); needs user run to observe `"platform":"iOS"` heartbeats land server-side.
- macOS: build verified; needs user run to observe heartbeats land in the JSONL file.
- BlackbookServer: build verified; new `/heartbeat` route is handled by the embedded server in the main app (BlackbookServer target shares the LocalSyncServer source).

## 2026-05-22 — Port /sync/changes into BlackbookServer (real iOS↔macOS sync)

**Summary:** Up to now the deployed sync server (`BlackbookServer.app`) only handled `/logs` + `/backups` + `/heartbeat`. Every `/sync/changes` request from any client returned 400 (missing `X-User-Email`) or 404 (route absent), silently. This change ports the sync handlers from the dead-code `Blackbook/Services/LocalSyncServer.swift` into `BlackbookServer/App/BackupServer.swift`, gives BlackbookServer its own SwiftData `ModelContainer` rooted at `~/Library/Application Support/Blackbook/Server/default.store`, and adds the missing `X-User-Email` header on the iOS and macOS Blackbook clients.

**Setup:**
- Both apps signed in as `owner@example.com`.
- BlackbookServer.app freshly built from this branch and installed at `/Applications/BlackbookServer.app`.
- Cloudflare tunnel `cloudflared-libersecretorum` running.

**Steps:**
1. Stop + reinstall + relaunch BlackbookServer:
   ```
   killall BlackbookServer
   xcodebuild -scheme BlackbookServer -destination 'platform=macOS' -configuration Release -derivedDataPath /tmp/blackbook-server-build build
   rm -rf /Applications/BlackbookServer.app
   cp -R /tmp/blackbook-server-build/Build/Products/Release/BlackbookServer.app /Applications/
   open /Applications/BlackbookServer.app
   ```
2. Master store exists: `ls -lT ~/Library/Application\ Support/Blackbook/Server/default.store` → file present.
3. Probe with valid password, no email header → expect `HTTP 400 Missing X-User-Email header`.
4. Probe with valid password + email header → expect `HTTP 200` and JSON `{"contacts":[],"tags":[],...}` (empty arrays on a fresh store).
5. On iPhone (new TestFlight build with the client-side X-User-Email change): sign out + back in.
6. Tail `~/Library/Application Support/Blackbook/Logs/_access/access-YYYY-MM-DD.jsonl` → expect `/sync/changes` rows with `"status":200` (no more 400s).
7. Tail `~/Library/Application Support/Blackbook/RemoteBackups/owner_at_example_com/Logs/heartbeats-YYYY-MM-DD.jsonl` → expect `"status":"success"` (was `"failed"`).
8. Next heartbeat reports `"pushPending":0` (15 records pushed through).
9. macOS Blackbook UI app: relaunch → its launch sync now succeeds, the 15 records pushed from iPhone appear in the UI within 5 minutes.

**Edge cases:**
- BlackbookServer launched without a usable ModelContainer → `/sync/changes` returns 503 "Master store unavailable"; `/backups` and `/logs` continue to work.
- Client without X-User-Email header → 400 (existing auth gate); not silently ignored.
- Sync push touches all 10 model types in dependency order; deletes are processed per-type after upserts.
- Cross-platform model schema match: BlackbookServer initializes a `Schema` matching `BlackbookApp.init`'s array, so JSON payloads round-trip cleanly.

**Platforms:**
- iOS: build verified (`xcodebuild build … -destination 'generic/platform=iOS'` BUILD SUCCEEDED). End-to-end behavior requires TestFlight install + manual run.
- macOS Blackbook app: build verified. Same TestFlight install caveat.
- BlackbookServer: build verified AND locally smoke-tested with curl through loopback — `/sync/changes` returns the right JSON envelope.

**Local-only deploy note:** BlackbookServer is NOT part of the TestFlight pipeline. After the PR merges, rebuild + reinstall it locally on this Mac:
```
killall BlackbookServer
git pull --rebase
xcodebuild -scheme BlackbookServer -destination 'platform=macOS' -configuration Release -derivedDataPath /tmp/blackbook-server-build build
rm -rf /Applications/BlackbookServer.app
cp -R /tmp/blackbook-server-build/Build/Products/Release/BlackbookServer.app /Applications/
open /Applications/BlackbookServer.app
```

## 2026-05-22 — Automatic bidirectional sync via server epoch + bootstrap

**Summary:** Even though `/sync/changes` now works (PR #36), iPhone and Mac stayed out of sync because the existing delta-only push only sends records marked `syncStatus != .synced`. After 18 days of silently-failing syncs, most records on both devices were marked `.synced` and never re-pushed, leaving the master with just a tiny subset. This change makes recovery automatic: BlackbookServer stamps every response with an `X-Server-Epoch` header (a UUID written next to the master store), and the iOS/macOS client detects a change in epoch — including its first-ever sync against a particular server — and performs a one-time bootstrap that marks every locally-`.synced` record as `.pending` so the next push uploads the full local store. No user-facing action required.

**Setup:**
- BlackbookServer rebuilt from this branch and reinstalled at `/Applications/BlackbookServer.app`.
- Both iOS and macOS Blackbook running new TestFlight build from this PR.
- Cloudflare tunnel `cloudflared-libersecretorum` running.

**Steps:**
1. Verify the epoch file exists: `cat ~/Library/Application\ Support/Blackbook/Server/epoch.txt` → a UUID.
2. `curl -i http://127.0.0.1:8765/sync/changes?since=2026-01-01T00:00:00Z` (with valid creds) → response includes `X-Server-Epoch: <uuid>` header.
3. Restart BlackbookServer → epoch UUID unchanged (persists across restarts).
4. On iPhone, foreground Blackbook → next 5-min tick (or earlier if just launched) emits `sync.bootstrap` action with `from:"nil"` and `to:"<uuid>"`. The `started` heartbeat reports the pre-bootstrap pushPending; the `success` heartbeat reports the post-bootstrap count (much higher).
5. Master store record count jumps from ~12 to the iPhone's full contact total. Verify:
   ```
   sqlite3 ~/Library/Application\ Support/Blackbook/Server/default.store "SELECT COUNT(*) FROM ZCONTACT"
   ```
6. On macOS, relaunch Blackbook → same `sync.bootstrap` fires once; master store gains any Mac-only records.
7. Within ~5 minutes of step 6 both UIs show the union of records.

**Edge cases:**
- Epoch unchanged across normal syncs → bootstrap is a no-op (idempotent); delta-only push continues to operate.
- Heartbeat fails (network blip) → no epoch detected → bootstrap deferred to next tick. Sync still proceeds; no data loss.
- BlackbookServer restarts but `epoch.txt` is present → epoch unchanged → no bootstrap.
- `epoch.txt` deleted manually + server restart → new epoch generated → clients bootstrap once on next tick. Confirms only genuine store reset triggers re-sync.
- Records in `.deleted`, `.modified`, or already `.pending` are NOT touched by the bootstrap sweep — only `.synced` → `.pending`. Deletion tombstones and in-progress edits preserved.
- Concurrent bootstrap on iPhone + Mac → both push their full local stores; server applies them in arrival order; existing `updatedAt`-based last-write-wins logic in `ModelSyncApply` handles overlaps.

**Recovery semantics (one-time):**
After the first bootstrap, the master holds the **union** of all contacts both devices knew about. Items that "vanished" during the pre-fix sync glitch may resurface; deliberate tombstone deletes (`.deleted`) stay deleted. The user can re-delete any unwanted duplicates after convergence.

**Platforms:**
- iOS: build verified (`xcodebuild build … -destination 'generic/platform=iOS'` BUILD SUCCEEDED). End-to-end requires TestFlight install.
- macOS Blackbook: build verified. Same TestFlight install caveat.
- BlackbookServer: build verified AND locally smoke-tested via curl — `X-Server-Epoch` header present, epoch persists across restarts, file written on first start.

**Local-only deploy note:** BlackbookServer is NOT part of the TestFlight pipeline. After this PR merges, rebuild + reinstall on this Mac:
```
killall BlackbookServer
git pull --rebase
xcodebuild -scheme BlackbookServer -destination 'platform=macOS' -configuration Release -derivedDataPath /tmp/blackbook-server-build build
rm -rf /Applications/BlackbookServer.app
cp -R /tmp/blackbook-server-build/Build/Products/Release/BlackbookServer.app /Applications/
open /Applications/BlackbookServer.app
```

## 2026-05-22 — Fast retry on sync failure + sync on app foreground

**Summary:** Transient mid-push network failures used to leave dirty records stuck for up to 5 minutes (the periodic timer interval), and foregrounding the iOS app after backgrounding didn't trigger a fresh sync. Today the user merged contacts on iPhone, hit a "network connection was lost" mid-push, and the 782 affected records sat pending. This change schedules a 30-second retry after any sync failure, and runs `performFullSync()` immediately when the app enters the active scene phase. Both triggers are automatic.

**Setup:**
- iOS + macOS Blackbook running the new TestFlight build from this PR.
- BlackbookServer running on this Mac on port 8765.

**Steps:**
1. Open Blackbook on iPhone, merge two duplicate contacts in `Contacts → tap a contact → Merge` (or any flow that creates `.pending` records).
2. Immediately background the app (Home gesture).
3. Wait 10 seconds, then foreground the app.
4. Tail server access log: `tail -f ~/Library/Application\ Support/Blackbook/Logs/_access/access-$(date -u +%Y-%m-%d).jsonl`.
   - **Expected:** within ~1 second of foreground, a `POST /sync/changes` row with `status:200` and `email:owner@example.com`.
5. To exercise the fast retry: enable Airplane Mode on iPhone, attempt a merge or other edit, watch for `status:"failed"` heartbeat with a network error.
6. Disable Airplane Mode within 30 seconds.
   - **Expected:** within ~30 seconds of disabling Airplane Mode, a follow-up `POST /sync/changes` with `status:200`. The new heartbeat entry reports `status:"success"` and `pushPending:0`.
7. On macOS, observe the next periodic tick (≤5 min after step 4 or 6) pulling the iPhone's merges.

**Edge cases:**
- Two rapid foreground events (quickly background + foreground twice) → `isSyncing` guard returns early on the second `performFullSync` call; no double push.
- Sync failure followed by stop (e.g., view torn down) → `stopPeriodicSync()` cancels the queued `failureRetryTask` and the periodic task; no leaked Tasks.
- Multiple sequential failures → each failure cancels and reschedules the retry task; at most one retry is queued at any time.
- App opened cold (first launch) → existing `configureAndStartSync` initial-sync path runs; subsequent foregrounding fires the same `performFullSync`, idempotent via `isSyncing` guard.

**Platforms:**
- iOS: build verified (`xcodebuild build … -destination 'generic/platform=iOS'` BUILD SUCCEEDED). Real-device verification depends on TestFlight install.
- macOS Blackbook: build verified. `.onChange(of: scenePhase)` fires on macOS too — equivalent benefit on Mac when window becomes key.
- BlackbookServer: build verified, no server changes in this PR.

**No local deploy step needed:** unlike PRs #36 and #37, no BlackbookServer changes here. The TestFlight pipeline ships the client change end-to-end.

## 2026-05-29 — Source-device provenance on every data record

**Summary:** Every model (Contact, Tag, Group, Location, Activity, Interaction, Note, Reminder, ContactRelationship, RejectedCalendarEvent) now stores `createdBy{DeviceId,Platform,DeviceName}` and `lastEditedBy{DeviceId,Platform,DeviceName}`. Set on local create (device that ran the init), refreshed on local edit via the new `markLocallyEdited()` helper. Sync layer round-trips all six fields, preserving the originator's identity rather than overwriting with the local device. No UI surface — data is queryable from SQL on the master.

**Setup:**
- BlackbookServer rebuilt from this branch and reinstalled at `/Applications/BlackbookServer.app` (server target compiles the model files via project.yml; schema migrates automatically).
- iOS + macOS Blackbook running new TestFlight builds.

**Steps:**
1. Confirm schema migrated cleanly: `sqlite3 ~/Library/Application\ Support/Blackbook/Server/default.store ".schema ZCONTACT"` → should show `ZCREATEDBYDEVICEID`, `ZCREATEDBYPLATFORM`, `ZCREATEDBYDEVICENAME`, `ZLASTEDITEDBYDEVICEID`, `ZLASTEDITEDBYPLATFORM`, `ZLASTEDITEDBYDEVICENAME`. Existing records carry NULL in all six (no backfill — confirmed accurate).
2. On Mac, create a new contact "Provenance Test 1". Wait one sync tick.
3. Query master:
   ```bash
   sqlite3 ~/Library/Application\ Support/Blackbook/Server/default.store \
     "SELECT ZFIRSTNAME, ZCREATEDBYPLATFORM, ZCREATEDBYDEVICENAME
      FROM ZCONTACT WHERE ZFIRSTNAME = 'Provenance Test 1'"
   ```
   → expect `Provenance Test 1 | macOS | Michael's Mac mini`.
4. On iPhone, after pull tick, open the contact, verify it's visible (UI doesn't show source).
5. Edit the contact on iPhone (e.g., add a phone). Wait one sync tick.
6. Query master again:
   ```bash
   sqlite3 … "SELECT ZFIRSTNAME, ZCREATEDBYPLATFORM, ZLASTEDITEDBYPLATFORM
              FROM ZCONTACT WHERE ZFIRSTNAME = 'Provenance Test 1'"
   ```
   → expect `Provenance Test 1 | macOS | iOS`. `createdBy*` unchanged (Mac), `lastEditedBy*` flipped to iPhone.

**Edge cases:**
- Pre-existing contacts (the 1288 records on the master before this PR) keep NULL provenance — confirmed by SQL count, no false attribution.
- `DeviceIdentity.installId` regenerates only if the app is uninstalled + reinstalled. Reinstalling on the same physical device creates a new installId for new records; previously-created records keep their original IDs.
- Schema migration is **automatic SwiftData lightweight migration** — no `currentSchemaVersion` bump, no store wipe. Verified locally: old store with 1288 contacts opened cleanly with 6 new columns appearing as NULL.
- `markLocallyEdited()` correctly skips records in `.deleted` state — preserves tombstone semantics.
- Sync apply uses **explicit nil**: a remote payload without the new keys overwrites the local-init defaults with nil, so records that pre-date this feature don't get falsely attributed to the receiving device.

**Diagnostic queries** the user can now run on the master:
- Which device created each duplicate of a contact: `SELECT ZFIRSTNAME, ZCREATEDBYPLATFORM, ZCREATEDBYDEVICEID FROM ZCONTACT WHERE ZFIRSTNAME LIKE '%Davina%'`.
- Count records by creating platform: `SELECT ZCREATEDBYPLATFORM, COUNT(*) FROM ZCONTACT GROUP BY ZCREATEDBYPLATFORM`.

**Platforms:**
- iOS: build verified (`xcodebuild build … -destination 'generic/platform=iOS'` BUILD SUCCEEDED). End-to-end requires TestFlight install.
- macOS Blackbook: build verified. Same TestFlight install caveat.
- BlackbookServer: build verified, AND locally smoke-tested — the upgraded server started cleanly against the existing 1288-record master store, all 6 new columns present, all existing records have NULL provenance as expected.

**Local-only deploy note:** BlackbookServer is NOT part of the TestFlight pipeline. After this PR merges, rebuild + reinstall:
```
killall BlackbookServer
git pull --rebase
xcodebuild -scheme BlackbookServer -destination 'platform=macOS' -configuration Release -derivedDataPath /tmp/blackbook-server-build build
rm -rf /Applications/BlackbookServer.app
cp -R /tmp/blackbook-server-build/Build/Products/Release/BlackbookServer.app /Applications/
open /Applications/BlackbookServer.app
```

---

## 2026-05-29 — iMessage Sync moved into BlackbookServer (un-sandboxed) + email matching, backfill, dedup, diagnostics

**Context:** Toggling "iMessage Sync" in the macOS app did nothing even with Full Disk Access. Root cause: the main macOS app is sandboxed (required for its TestFlight distribution), so it (a) resolved `chat.db` to a non-existent sandbox-container path and (b) couldn't read `~/Library/Messages/` even with FDA. De-sandboxing the main app would break TestFlight (App Store Connect rejects non-sandboxed macOS builds, ITMS-90296). Resolution: the iMessage reader was moved into **BlackbookServer**, which is already un-sandboxed, always-running (login item), holds the master SwiftData store, and syncs to all devices. Interactions it creates flow to iOS + macOS via `/sync/changes` (server pull serves by `updatedAt`).

The main app's iMessage Sync UI/service was **removed**. All iMessage controls now live in the BlackbookServer menu-bar popover.

### Setup (one-time)
1. Rebuild + reinstall BlackbookServer from this branch (see deploy note below). The menu-bar "server.rack" icon should appear.
2. Grant **Full Disk Access to "Blackbook Server"** (not "Blackbook") in System Settings → Privacy & Security → Full Disk Access. This is the key difference — FDA must be on the server app.
3. Click the menu-bar icon → toggle **"Log iMessages"** on.

### Scenario 1 — Toggle works in the server
1. Open the BlackbookServer menu. Flip "Log iMessages" on.
2. It should show "N logged" and "checked <time> ago". No red error.
3. If a red "Cannot open chat.db … Grant Full Disk Access to Blackbook Server" error appears, FDA isn't granted to the *server* app — fix via the "Open Full Disk Access" button, then re-toggle.

### Scenario 2 — Email-handle matching
1. Pick a contact whose iMessage thread is an `@icloud.com` Apple ID and confirm that email is on the contact. Send yourself a message from that thread on another device.
2. Within 30s the message should log. Verify on the Mac app (after the next sync pull) or iPhone: the contact's Interactions list shows it with a "message.fill" icon and the right direction arrow.

### Scenario 3 — 30-day backfill
1. In the server menu, tap "Sync Last 30 Days". Spinner shows "Importing…", then "N logged" jumps.
2. After the next client sync pull, open Nick Nguyen / Jose / any frequent contact on iPhone or Mac — Interactions from the last 30 days should be present with correct timestamps + direction.
3. Tap "Sync Last 30 Days" again — interaction count must NOT double (dedup guard).

### Scenario 4 — Unmatched-handles diagnostic
1. Clear the phone/email on a contact you message. Send yourself a message from that handle. Wait 30s.
2. Server menu shows "Unmatched handles (1)"; expand to see the verbatim handle.
3. Re-add the handle to the contact; on next poll it leaves the list and starts logging.

### Scenario 5 — Device round-trip
1. After Scenarios 2–3, wait for the iOS/macOS client's 5-min `LocalServerSyncService.performFullSync` (or foreground the app to trigger an immediate pull).
2. The iMessage interactions appear on every device; relationship score reflects the bumped `lastInteractionDate`.
3. Note: because the server runs 24/7, this now works **even when the Mac app is closed** — a strict improvement over the old main-app design.

### Platforms
- BlackbookServer (macOS, un-sandboxed): build verified clean; reinstalled to /Applications and running. iMessage reader compiled in.
- Blackbook main app (iOS + macOS): build verified clean; macOS sandbox **restored** (confirmed `com.apple.security.app-sandbox` present via `codesign -d --entitlements -`) → TestFlight unaffected.
- Tests: 13 Swift Testing tests pass.

### Local-only deploy note
BlackbookServer is NOT in the TestFlight pipeline. After this branch merges, rebuild + reinstall:
```
killall BlackbookServer
git pull --rebase
xcodebuild -scheme BlackbookServer -destination 'platform=macOS' -configuration Release -derivedDataPath /tmp/blackbook-server-build build
rm -rf /Applications/BlackbookServer.app
cp -R /tmp/blackbook-server-build/Build/Products/Release/BlackbookServer.app /Applications/
open /Applications/BlackbookServer.app
```
Then re-confirm Full Disk Access for "Blackbook Server" and toggle "Log iMessages" on.

## 2026-05-30 — BlackbookServer web console (localhost KPI dashboard + safe actions)

**Context:** Added a localhost-only web console to BlackbookServer for at-a-glance operational health. A second `NWListener` bound to `127.0.0.1:8766` (the Cloudflare tunnel maps only 8765, so the console is never internet-exposed and needs no password). Serves `console.html` + `GET /api/stats` (sync health, backups/storage, request/error log, record counts, iMessage stats) and two safe POST actions (`/api/imessage/backfill`, `/api/imessage/toggle`).

### Open it
- Menu-bar server.rack icon → **Open Web Console** (visible when the server is running), or browse to `http://127.0.0.1:8766`.

### Scenario 1 — Dashboard loads with live data
1. Open the console. Header shows a green dot + `port 8765 · console 8766 · epoch …`.
2. Four sections populate and auto-refresh every 5 s: Sync Health (per-device heartbeats), Backups & Storage, Data & iMessage (record counts + iMessage panel), Requests (today's status histogram + recent tail).

### Scenario 2 — Safe actions
1. **Sync Last 30 Days** button → toast "Backfill started"; iMsgs-Logged KPI rises (requires FDA granted to Blackbook Server + Messages present).
2. **Enable/Disable iMessage Logging** button flips `isRunning` in the Data panel on the next refresh.

### Scenario 3 — Security: NOT exposed off-loopback (the important check)
- `curl http://$(ipconfig getifaddr en0):8766/` → connection refused (status 000). Loopback-only bind confirmed.
- `curl https://sync.libersecretorum.com/api/stats` → 401 (hits the 8765 sync server's auth gate; the console route doesn't exist there). The console is not tunneled.
- Defense-in-depth: the console connection handler also rejects any non-loopback remote endpoint.

### Verification done
- BlackbookServer builds clean (Debug + Release); `console.html` confirmed bundled in `Contents/Resources/`.
- `GET /` → 200 text/html 12049 bytes; `GET /api/stats` → full JSON (Contacts 1288, backups 5/3.8 MB, 2 sync devices, 148 requests today). Verified with curl + a strict Python HTTP client.
- LAN:8766 refused; tunnel /api/stats → 401. Backfill endpoint → 202.
- 13 Swift Testing tests still pass.

### Note
The console only runs while the sync server is running (it starts/stops with the main listener). The main Blackbook app is unaffected — these are BlackbookServer-only changes, deployed locally (not TestFlight).

## 2026-06-01 — Harden bulk sync-apply against the SwiftData @Query faulting crash

**Context:** After the 95-message iMessage backfill, the macOS app crash-looped (4× `EXC_BAD_ACCESS` in 45s) the moment the 95 interactions bulk-synced in. Root cause: `LocalServerSyncService.pullRemoteChanges` applied all pulled records to the main context and saved once — a single 0→95 transaction made the dashboard's `@Query` re-render the entire new object graph at once, faulting the `Interaction↔Contact` relationship under Release optimization. (Debug + settled-data Release builds do NOT crash; it was a transient race during the one-time bulk insert.) Fix: apply each layer in chunks of 25 with intermediate saves (`applyInChunks`) so no single massive transition occurs.

### Scenario — fresh-device full sync of a large store
1. On a device with an empty/reset store, sign in and let the first full sync run (pulls all contacts + the 95+ interactions).
2. Keep the **Overview/Dashboard** in front during the sync.
3. Expect: no crash; interactions appear (possibly in visible chunks of ~25 as each intermediate save lands); relationship scores update.
4. Open a contact → Interactions tab → messages render.

### Notes / caveats
- The crash is timing/optimization-dependent and could not be reproduced on settled data, so this hardening is **defense-in-depth** — verified by build + test + reasoning, not by reproducing the original race.
- Chunked saves also improve failure semantics: a mid-pull error now preserves already-applied chunks (idempotent UUID-upsert heals the rest on the next sync) instead of losing the whole batch.
- Verified: macOS + iOS build clean; 13 Swift Testing tests pass.

## 2026-06-02 — iOS crash-on-load after partial pull: deferred Dashboard fetch + background-context pull

**Context:** Day after the macOS chunking fix (PR #42), the iPhone (TestFlight build 117) crash-looped at launch (~1.6s in, `EXC_BAD_ACCESS / SIGSEGV` deep in `SwiftData → _SwiftData_SwiftUI → Sequence.forEach`, top of stack inside the Dashboard's `ScrollView`). Chunking on the main context still let SwiftUI `@Query` observe partial-state transitions between intermediate saves; on iOS, all `TabView` children stay alive so multiple `@Query`s reacted simultaneously and faulted the `Contact.interactions` inverse during the bulk apply. Once the iPhone's store was in a partial state, even the next *launch* re-rendered the bad state and crashed before sync could heal it.

Two changes ship together:
1. **`DashboardView` no longer uses `@Query`.** It now keeps `allContacts` / `reminders` in `@State`, fetches via `FetchDescriptor` in a `.task` (with a 500 ms initial delay so any in-flight pull settles first), and re-fetches on a `.blackbookSyncDidComplete` notification. Body is gated on `hasLoadedOnce` (shows `ProgressView` until the first fetch). Result: the dashboard never observes a mid-sync transition.
2. **`pullRemoteChanges` applies on a fresh `ModelContext(container)` with autosave off** and saves once at the end. The main context (and its remaining `@Query`s in other tabs) only sees one settled commit, never partial state. Replaces the per-25-record `applyInChunks` from PR #42.

### Scenario A — iPhone recovery from existing partial-state crash loop
1. After build 118 lands in TestFlight, install it on the iPhone.
2. **Delete the existing Blackbook app first**, then install build 118 fresh (the existing store may still hold partial-state interactions from earlier crashes).
3. Open the app, sign in, let it sync.
4. Expect: dashboard shows `ProgressView` briefly, then the Overview cards render. No crash. Contacts arrive; interactions on a contact's Interactions tab show the iMessage history.
5. Background the app, foreground it — sync runs again, dashboard updates without flicker.

### Scenario B — fresh-device large bulk sync
1. On an iPhone or Mac with an empty store, sign in.
2. Watch the Overview tab during the first full sync (1300 contacts + 171 interactions).
3. Expect: `ProgressView` until ~500ms after first render; then the cards populate from the just-completed background apply. No `EXC_BAD_ACCESS`.

### Scenario C — pull failure mid-apply
1. Force a network failure mid-pull (e.g. airplane-mode toggle during a backfill push from the server).
2. Expect: `bgContext.save()` is never called → the main store stays at its previous settled state, no partial records visible to the UI. On the next sync, the same payload is re-pulled (idempotent UUID upsert in `applyRemote*`) and applied atomically.

### Notes / caveats
- The fix removes `applyInChunks` and the `applyChunkSize` constant from PR #42 — superseded by the single-atomic-commit approach.
- Dashboard auto-refresh on store mutations is gone; refresh happens on launch, on sync completion, and on a `.blackbookSyncDidComplete` notification. If you mutate the store from a sheet (e.g. logging an interaction), call `NotificationCenter.default.post(name: .blackbookSyncDidComplete, object: nil)` or accept that the dashboard updates on the next sync tick.
- Other views still use `@Query` — they're rendered only when their tab is selected, so a settled main store at that point keeps them safe.
- Verified by: iOS Simulator + macOS clean builds; 13 Swift Testing tests pass.
- Crash signature confirmed via `~/Downloads/Blackbook-2026-06-02-093228.ips` — frames 12-13 in `_SwiftData_SwiftUI` (`@Query`), frame 18 in `ScrollView.init`, frame 5 `Sequence.forEach`, into SwiftData fault on tagged address `0x8000000000000010`.

## 2026-06-02 — Silent sync drift fix: every contact edit now flips syncStatus to pending; iMessage handle lookup ignores merged-away

**Context:** User reported three divergences between iOS and macOS for the same Contact records: (1) Contact A shows as "Contact A" on iOS but "Contact A" on macOS, (2) Contact B is priority=1 on iOS but priority=0 on macOS, (3) Contact A's recent iMessages don't show on the Contact A contact detail. Root cause for (1) and (2): 17 edit sites across the iOS/macOS app wrote `contact.updatedAt = Date()` (or just mutated a syncable field) without calling `contact.markLocallyEdited()` to flip `syncStatus` to `.pending`. The next push filters by `syncStatus != .synced`, so silently-edited records never leave the device — server stays stale, the other device pulls the stale version. Audit on the user's macOS store found **643 contacts** with `updatedAt > lastSyncedAt && syncStatus = .synced` — silently-edited but never pushed. Root cause for (3): `BlackbookServer/App/IMessageSyncService.buildHandleLookup` fetched every Contact including merged-away ones, so when a live duplicate and a merged-away version shared a phone/email, the dict-assignment order could pick the merged-away one and attach incoming iMessages to a hidden record. Confirmed on server: 4 Contact A iMessages were attached to merged-away Z_PK 1210, not live Z_PK 313.

Changes:
1. **17 edit sites updated** to call `markLocallyEdited()` instead of direct `updatedAt = Date()` / unmarked field writes. Files: `ContactDetailView`, `ContactListView`, `ContactFormView`, `AddNoteView`, `LogInteractionView`, `ContactTagPickerView`, `ContactGroupPickerView`, `ContactLocationPickerView`, `DashboardView`, `SettingsView`, `ContactSyncService`, `SocialEnrichmentService`, `ContactMergeService`.
2. **`IMessageSyncService`** fetches contacts with `#Predicate<Contact> { !$0.isMergedAway && !$0.isHidden }` before building the handle lookup.

Server-side one-time SQL heal applied directly to the master store while the daemon was stopped:
- `UPDATE ZINTERACTION SET ZCONTACT=313, ZUPDATEDAT=<now> WHERE ZCONTACT=1210;` — relink 4 Contact A iMessages from merged-away Contact A to live Contact A.
- `UPDATE ZCONTACT SET ZLASTNAME='<last name>', ZUPDATEDAT=<now> WHERE Z_PK=313;` — restore the last name and force a re-pull.
- `UPDATE ZCONTACT SET ZUPDATEDAT=<now> WHERE Z_PK=1197;` — bump Contact B so macOS adopts the server's `isPriority=1`.

### Scenario A — single-edit propagation
1. On either device (build 119+), open any contact, change one field (last name, priority toggle, add tag), save.
2. Within 5 min the change appears on the other device's view of the same contact.
3. Watch the server access log: the source device's next `/sync/changes` push includes that record; the other device's pull response includes it.

### Scenario B — silent-edit backlog clears as users touch contacts
1. With build 119+ on macOS, open any of the 643 silently-edited contacts and make any change (or just toggle a flag and back).
2. That contact's next push reaches the server; the other device adopts it.
3. The full 643 backfill is opt-in — only contacts the user re-touches will sync. This avoids macOS-wins overwriting iOS edits that were also silent.

### Scenario C — iMessage attaches to live contact when duplicates exist
1. Have a contact with a live record (`isMergedAway=false`) and a merged-away duplicate (`isMergedAway=true`) sharing the same phone/email.
2. Receive a new iMessage from that handle.
3. Open the live contact → Interactions tab → the message appears. The merged-away contact gets nothing.

### Notes / caveats
- The fix is per-edit-going-forward. The existing 643-record backlog clears only as users naturally touch each contact (or via a deliberate one-time migration, which we deliberately skipped because it would overwrite iOS edits for any field where the two devices disagree).
- BlackbookServer is local-deploy only (not TestFlight). After this PR lands, rebuild + reinstall `/Applications/BlackbookServer.app` from main so the iMessage-lookup fix takes effect.
- Verified: iOS Simulator + macOS clean builds, BlackbookServer clean build, 13 Swift Testing tests pass.

---

## 2026-06-03 — Import-crash hotfix + 5 features (PRs #48 → #49 → #50)

### Hotfix (#48)
- **Import All no longer crashes:** Settings → Import from Contacts → **Import All**. The import completes; the app does not crash and relaunching works (no crash loop).
- **Recent interactions raise the score:** for a priority contact stuck at 20/"Fading" with recent texts (e.g. Contact A), after the next sync the score rises above 20 to reflect the recency. Works on whichever tab is visible (recalc runs after each sync pull).

### Suggested records (#49)
- Open a contact → **Introduced to** (or **Met via**) edit. With the search box empty, a **Suggested** section shows 3 contacts that share tags/groups/locations with the subject; the rest appear under **All Contacts**. Typing switches to a plain filtered search.

### Click-to-sort columns (#49)
- In Contacts (macOS / iPad regular width), click a column header (Name, Groups, Locations, Tags, Met via, Introduced to, Score). The list sorts by that column; the active column shows ▲/▼. Click the same header again to reverse. String columns put blanks last; Score sorts highest-first on first click.

### Hidden contacts everywhere (#49)
- Hide a contact (swipe → Hide, or Settings → Hidden Contacts). It must not appear in any picker: Introduced to, Met via, Merge, Met-via in the contact form, group/tag/location "add contact", network graph. (If it still shows on a *different* device, that's sync propagation — re-touch it or wait for the next sync.)

### Notifications chiclet (#50)
- Overview shows a **bell** chiclet (top-right) with a red count badge when there are active notifications.
- Tap it → a sheet lists suggestions newest-first. Tap a row (or swipe right/leading) → navigates to the related contact. Swipe left/trailing → **Dismiss** (it disappears and stays gone, across relaunch and sync).
- Fading suggestions appear for contacts whose score dropped into the fading band (0 < score < 30).

### Archive-on-import (#50)
- Remove a previously-imported contact from the system address book, then run **Import All**. An **Archive** suggestion appears in the bell list for that contact. Swipe → **Archive** hides them. Dismiss instead to keep them.

### Notes / required steps
- iOS Simulator couldn't run in the dev env (CoreSimulator drift); suite run on the macOS destination (232 tests green) — CI runs the iOS path.
- **After #50 merges:** rebuild + reinstall `/Applications/BlackbookServer.app` (Release) so the server relays `appNotifications`. The new `AppNotification` schema is additive (no store wipe).

---

## 2026-10-14 — Yeackbot foundation: TS monorepo, collector API, legacy migration dry-run, iMessage ingest, web shell

**Summary:** First slice of the agentic rebuild (`docs/design/PLAN.md`). The old public sync tunnel is disabled. Yeackbot
now has: a Node/Express server with the full schema, an undo journal, a scheduler and Cloudflare Access auth; the Swift
collector (inside the BlackbookServer target) serving a loopback API that decodes `attributedBody`; a legacy SwiftData
migration; iMessage ingest; and a PWA shell (People / Person / Sources / Today / Settings → Hidden).

**Setup:** Node 25, `npm install` at the repo root. The collector's SwiftPM tests and dev runner need only the Command Line
Tools. The app build needs Xcode.

### Scenario A — Automated suites
1. `npm run typecheck && npm test` → 32 files / 282 tests pass (also passes with `npx vitest run --sequence.shuffle`).
2. `npm run lint:pii` → "files clean" (the repo is public; any real phone/email/name in a tracked file fails).
3. `collector/run-tests.sh` → 64 Swift tests pass (synthetic chat.db built from the real schema).
4. `node scripts/build-server.mjs && npm run build -w packages/web` → both bundles build.

### Scenario B — Public endpoint closed (Day 0)
1. `curl -sI https://sync.libersecretorum.com` → HTTP 530 (no origin).
2. `launchctl print-disabled gui/$(id -u) | grep libersecretorum` → `disabled`.

### Scenario C — Real chat.db decode (aggregates only)
1. `cd collector && swift run yb-collector-verify` → last-90-day non-reaction messages: ≥99% of text-bearing rows decoded
   (measured 99.92%). `group_sends_from_me` equals the raw SQL count of `handle_id=0` group sends.

### Scenario D — End-to-end iMessage ingest into a scratch DB (no install)
1. `YB_DATA_DIR=<scratch> swift run yb-collector-dev` (from `collector/`). It listens on 127.0.0.1:4321 and writes a 0600 token.
2. `NODE_ENV=development YB_DATA_DIR=<scratch> PORT=4398 DEV_AUTH_BYPASS=1 node packages/server/dist/index.js`.
3. Within ~30 s, `messages` ≈ chat.db non-reaction rows (within 0.5%; measured +0.17%). `message_reactions` ≈ chat.db
   add-tapbacks (measured 13,628 / 13,670; the rest are parked in `pending_reactions` because their target never synced).
   Replies are linked (2,721 / 2,730). Zero error logs.
4. Stop both processes **by PID** and delete the scratch dir, which holds real message text.
- **Edge:** a tapback that syncs before its target (iCloud out-of-order rowids) waits in `pending_reactions` and attaches
  when the target arrives. Unresolved ones expire after 30 days in the nightly pass.
- **Edge:** with the collector down, `imessage-tail` logs `collector_unavailable` and retries. Nothing crashes.

### Scenario E — Legacy migration dry-run (counts only)
1. Server stopped → `npm run yb -- migrate-legacy --dry-run` → report shows every equation OK (people = ZCONTACT, merged
   649 = 654 − 5 orphans, tags/circles/locations links minus dupes) and a second pass inserts 0 rows. No names or handles
   appear in the output.

### Scenario F — Web shell + Access (local, dev bypass)
1. Run the scratch server as in D → open `http://127.0.0.1:4398/people`: sorted by last name A–Z, search works, and a hidden
   person never appears (only under Settings → Hidden, with Unhide).
2. A request carrying a `Cf-Ray` header gets 403 under dev bypass (tunnel traffic can never use the bypass).
3. `curl http://127.0.0.1:4398/healthz` → `{"ok":true}` only.

### Platforms / not yet verified
- No Xcode on the Mac mini (CLT only), so the BlackbookServer app build, `xcodebuild test` and the macOS Blackbook build
  were not run locally. The new CI `collector` job covers them.
- Not exercised: real iMessage send / note-to-self (spike a), Cloudflare tunnel + Access (spike c), iOS PWA push (spike g).

---

## 2026-10-15 — Sandbox browser (persistent Chromium on OrbStack for yeackbot jobs + Claude Code)

**Summary:** `deploy/browser/compose.yml` runs Chromium (linuxserver/chromium) plus a socat relay in OrbStack. The
profile persists in `$YB_DATA_DIR/browser`. There's a sign-in viewer on `https://127.0.0.1:4330` (basic auth; password in
`$YB_DATA_DIR/browser.env`, 0600) and Chrome DevTools Protocol on `http://127.0.0.1:4331`. Claude Code reaches it through
the user-scope MCP server `yb-browser` (`@playwright/mcp --cdp-endpoint`). Managed by `scripts/browser.sh`.

### Scenario A — Up and healthy
1. `bash scripts/browser.sh up` (idempotent) → "DevTools ready: Chrome/<version>".
2. `bash scripts/browser.sh status` → both services `running`.
3. `lsof -nP -iTCP:4330 -sTCP:LISTEN` and `:4331` → bound to `127.0.0.1` only.

### Scenario B — Viewer auth
1. `curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:4330/` → 401.
2. With the user `yeackbot` and the password from `browser.env` → 200. In Safari/Chrome, accept the self-signed
   certificate and you see the Chromium desktop.

### Scenario C — Sign-ins persist
1. In the viewer, sign in to a site (e.g. partiful.com).
2. `bash scripts/browser.sh down && bash scripts/browser.sh up`, then reopen the viewer → still signed in.
3. Reboot the Mac → OrbStack starts at login (`orbctl config show` → `app.start_at_login: true`) and the containers
   restart (`restart: unless-stopped`) → still signed in.

### Scenario D — Claude Code can drive it
1. `claude mcp get yb-browser` → Connected.
2. In a new Claude Code session, ask it to open a page in the yb-browser and read its title. The page shows up in the viewer.

### Notes
- Image size is ~4.5 GB. Keep an eye on free disk space.
- Anything on this Mac that can reach 127.0.0.1:4331 can act as you on the signed-in sites (same residual risk as the
  collector token). Never route 4330/4331 through a tunnel.

---

## 2026-10-16 — Source adapters: Instagram (Beeper + export), WhatsApp, Partiful, Google Calendar, Contacts, matcher, occasions

**Summary:** Every source feeds the same episode tables through `adapters/common/episodes.ts`. Cross-source identity
links are journaled pointer merges (undoable). Jobs register only when their config exists. Sources page cards show
health and how to fix it. The Events screen shows occasions with inferred attendees.

### Scenario A — Automated
1. `npm run typecheck && npm test` (60 files / 598 tests), `npx vitest run --sequence.shuffle`, `npm run lint:pii`, both builds.
2. Migrations 004–010 apply on a fresh DB and on a DB at schema version 3 (production's version before this deploy).

### Scenario B — Instagram via Beeper (after deploy)
1. Beeper running, Instagram connected, `BEEPER_TOKEN` in `.env`.
2. Within ~30 min the Sources → Instagram card shows Healthy with message counts. Instagram people show an Instagram badge
   under Linked accounts, and their timeline has Instagram sessions.
3. Disconnect Instagram in Beeper → the card shows "Needs you". iMessage/WhatsApp accounts in Beeper are ignored.

### Scenario C — Instagram export
1. Drop the "Download your information" zip into `~/Yeackbot Imports/`.
2. Within an hour the Instagram export card shows the imported threads. Accented/emoji names render correctly. The zip is
   neither moved nor deleted. Dropping it again imports 0 new rows.

### Scenario D — WhatsApp (official Mac app)
1. WhatsApp for Mac linked and running.
2. Within ~30 min the Sources → WhatsApp card shows Healthy. A contact you text on both WhatsApp and iMessage shows both badges
   and one interleaved timeline. Group members show up as connections.
3. Quit WhatsApp for 3+ days → the card turns Stale with "Open WhatsApp on your phone".

### Scenario E — Partiful
1. Signed in to partiful.com in the sandbox browser (https://127.0.0.1:4330).
2. After the 02:00 run (or `yb run-job partiful`), the Events → Past tab lists Partiful events. Guest lists fill in over
   several nights (~40 events/night). Co-attendees appear as connections.
3. Sign out of Partiful in the sandbox → the card shows "Sign in to Partiful in the sandbox browser". Sign back in → it
   recovers on the next run without a restart.

### Scenario F — Google Calendar
1. Sources → Connect Google Calendar → Google consent (Advanced → Go to yeackbot) → back on yeackbot as Connected.
2. Calendars listed with treatments: Personal + Partiful = attending, shared group calendar = candidate, holidays = excluded.
3. After the next sync and the 03:00 occasions run, a "Drinks w/ <name>" event shows that person as attendee (or "possible").
   A Gmail "Reservation at <venue>" plus your own event at the same time become one occasion. Maid/HOA/medical entries are
   not social.

### Scenario G — Contacts + matcher
1. On the first Contacts fetch, macOS asks "Yeackbot Collector would like to access your contacts" → Allow.
2. Address-book names replace masked handles. Instagram usernames from contact cards link to the right people.
3. Two different people with the same name are never merged on name alone. Undo a merge on Today and it isn't redone the
   next night.

## 2026-10-16 — LLM cost pass: Haiku 5.5 route table, caching, budgets

All LLM calls now go through the route table in `packages/server/src/llm/models.ts` (Claude Haiku 5.5, effort low,
thinking off except the Ask tool loop, 1 h cache on batch routes / 5 min on sync ones). Refusals are recorded and
skipped (no fallbacks on Haiku). Budgets default to $1/day, $10/month, $20 backfill.

**Setup**: worktree build; for B–D a server with `ANTHROPIC_API_KEY` (real calls — owner only).

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npm test && npm run lint:pii && node scripts/build-server.mjs && npm run build -w packages/web`.
2. `test/llm/models.test.ts`: route defaults, Opus rejected by `llm.route_overrides`, no sampling params / fallbacks on
   any Haiku route, cache_control placement + byte-stable bodies, 100K guard, pricing (cache, batch, >100K card), and
   the lint that no `claude-…` id appears outside `llm/models.ts`.

### Scenario B — Backfill dry run
1. `npm run yb -- backfill-extract --estimate`.
2. **Expected**: counts (conversations, messages, windows, tokens), "estimated cost ≈ $… (Claude Haiku 5.5, batch
   prices…)" and "allowance $20.00 (spent …, left …) · covers N of M windows". Nothing is sent; no rows are written.

### Scenario C — Spend and cache visibility
1. After a night with a key, open Sources → Pipeline cost.
2. **Expected**: Today / This month against $1 / $10 (sub-cent amounts show four decimals), "Model: Claude Haiku 5.5 ·
   nightly work batched (50% off)", and a cache hit rate for the last 7 days (it should climb well above 50% once the
   nightly extraction batch runs: its ~5k-token system prompt is read from the cache for every window).

### Scenario D — Route override (advanced)
1. `PATCH /api/v1/settings` with `{"values":{"llm.route_overrides":{"digest_compose":{"model":"claude-sonnet-5-5"}}}}`.
2. **Expected**: accepted; Sources shows "1 route overridden"; the next digest call is on Sonnet with `fallbacks`.
3. The same with an Opus model id → 400 "model must be one of claude-haiku-5-5, claude-sonnet-5-5".
4. Reset the key (`reset: ["llm.route_overrides"]`) to go back to Haiku everywhere.

**Edge cases**: a refused extraction window shows status `refused` and is not retried; a window whose prompt would pass
100K tokens is split before sending (never seen in practice: windows are ≤8k NEW tokens).
**Platforms**: server + web (desktop/mobile). Real API behavior (cache hits, refusals) still needs the owner's key.

---

## LLM cost pass — review fixes (100K guard, refusal re-runs, TTLs, estimates) (2026-10-16)

**What changed**: token estimates count every non-ASCII code point as ≥1 token (CJK/emoji can no longer slip past the
≤100K guard); the Ask session budget is counted in estimated tokens; the Ask tool loop sizes each next request from the
previous request's actual usage and swaps results that would cross 100K for the budget note; responses whose real
prompt exceeded 100K log `llm_prompt_over_limit`. On a Sonnet 5.5 override, refused batch items are re-run only for
`cyber` / `frontier_llm` declines and only while the route is still on Sonnet; tool loops drop the declined attempt's
thinking/tool_use blocks before a `fallback` marker and never stream its partial text. `digest_compose` and `intent`
send no cache marker; sync calls on batch routes write the cache at 5 min. Batch estimates assume 25% cache misses.
The Ask footer shows sub-cent costs with four decimals.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npm test && npm run lint:pii && node scripts/build-server.mjs && npm run build -w packages/web`.
2. `test/llm/models.test.ts` (TTLs incl. no-marker routes, estimates, `refusalRerunnable`, CJK token estimates),
   `test/llm/client.test.ts` (fallback echo, result dropping near 100K, `llm_prompt_over_limit`),
   `test/llm/batches.test.ts` + `test/extraction/pipeline.test.ts` (non-rescuable categories stay refused),
   `test/ask/tools.test.ts` (token-counted session budget).

### Scenario B — Ask cost footer
1. Ask a question on the web that needs at least one lookup.
2. **Expected**: the footer reads "N lookups · $0.000X" (four decimals under a cent; "<$0.0001" for tinier turns),
   never "$0.000".

### Scenario C — Digest request shape (owner, with a key)
1. Let the 07:30 digest run, then inspect the ledger row for kind `digest`.
2. **Expected**: `cache_creation` is 0 (no marker on the digest system prompt); the call costs plain input + output.

**Edge cases**: an Ask whose lookups return mostly CJK text stops adding results before the next request would pass
100K tokens (status `tool_limit` or an answer built from the kept results); a Sonnet-override `general_harms` batch
refusal is recorded `refused` with no synchronous re-run.
**Platforms**: server + web. Real-API behavior (fallback blocks, cache usage) needs the owner's key.

## Human-style texts: one suggestion per text (2026-10-17)

The morning brief is now one iMessage per suggestion, written in plain sentences with line breaks (greeting on the
first, "That's it! Reply…" + the one link on the last, a health issue as its own final text). Command replies (help,
why, draft, log, pause, status, acks) are full sentences on separate lines. Replying to a suggestion's own text with
just "done", "skip", "snooze 2w", "why" or "draft" acts on that item; `more` sends one more suggestion.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root (the root config installs the
   network guard; running vitest inside `packages/server` skips it).
2. `test/delivery/compose.test.ts` (exact texts, per-item fallback), `test/delivery/send.test.ts` (one text per item
   in order, digest_ordinal recorded, a brief cut off after two texts resumes past catch-up with no repeats),
   `test/commands/executor.test.ts` (inline "done" / "skip this one" / "snooze 2w" on the echo row, "why" with no
   number), `test/commands/grammar.test.ts` (number-less item verbs).

### Scenario B — Preview (web)
1. yeackbot.com → Settings → Digest → **Preview today's text**.
2. **Expected**: one bubble per suggestion (plus a "Heads up" bubble when a source is unhealthy); the caption says
   "N texts · N items"; no "·" separators inside the bubbles.

### Scenario C — Real brief (owner's phone)
1. With the daily brief on (or Settings → Digest → **Send today's brief to me**), watch the self thread at 08:00.
2. **Expected**: one text per suggestion (plus a "Heads up" text if a source is unhealthy), in order, each starting
   with 🅨; the first greets, the last suggestion's text ends with
   "That's it! Reply "done 2", "skip 2" or "snooze 2" anytime." and yeackbot.com/today.
3. Long-press text 3 → Reply → "done". **Expected**: "✓ Nice, marked <name> done." on its own line, then
   "(Text "undo" to take that back.)".
4. Text "yb help". **Expected**: a bulleted list, one command per line.

**Edge cases**: a reply to the brief's echo row (the grey copy) binds to the same item; a bare "done" with several
open items asks "Which one? Reply "done 1", or reply to that suggestion's text with just "done"."; "why?" as an
inline reply explains that item.
**Platforms**: server + web; the inline-reply binding needs a real iPhone/Mac Messages reply to verify end to end.

---

## Ask works again + "who do I know in …" answers with people only (2026-10-18)

**What changed**: every Ask request (web and iMessage `yb …?`) failed with HTTP 400 because the six strict tool schemas
had 24 nullable (anyOf) parameters and the API allows at most 16 (it also caps optional parameters at 24). Filters are
now optional properties and only the result caps stay required + nullable (4 union, 20 optional). The LLM client
refuses an over-limit tool set locally (`bad_request_shape`). The Ask system prompt now says "who" questions are
answered with people, never events, reservations, flights or venues. The plain-search fallback (no Claude) lists only
people for "who …" questions and no longer repeats a city that equals the person's top fact ("London · London¹").

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root.
2. `test/llm/models.test.ts`: the old 24-union shape is flagged; the Ask tools fit both limits.
3. `test/ask/tools.test.ts`: omitted filters are accepted. `test/ask/engine.test.ts`: the "who" fallback lists no events or
   message quotes, no "Austin · Austin" over iMessage; non-"who" questions still show events.
4. Claude ran the real engine against a copy of the production DB with the live API: "who do I know in London" →
   2 tool calls, $0.0007, an answer naming only the two people who live in London.

### Scenario B — iMessage (owner, after deploy)
1. Text yourself `yb who do I know in London`.
2. **Expected**: within ~30 s a reply that names people (no "Claude isn't reachable" lead), with at most 3 footnotes and a
   yeackbot.com/ask link. No flights, restaurant reservations or event titles.

### Scenario C — Web Ask (owner, after deploy)
1. On yeackbot.com → Ask, ask "Who do I know in Austin?" (or any city you have friends in).
2. **Expected**: a streamed answer listing people with citations; the footer shows lookups and a cost under a cent.
3. Ask "What did we do in London?". **Expected**: events can appear here (only "who" questions are people-only).

**Edge cases**: with Claude off or the budget spent, "who do I know in X" shows "Here’s who a plain search found:" and
only people; nobody found → "A plain search found nobody for that." A future tool parameter that pushes the schemas
over 16 union / 24 optional parameters fails `test/llm/models.test.ts` instead of 400-ing in production.
**Platforms**: server (iMessage + web). Not yet deployed: production still runs the old code until merge + restart.

---

## Two-way texting — addressed texts are never silently dropped (2026-10-18)

**What changed**: a self-thread text addressed to the bot ("yb …", or an inline reply to a yeackbot text) that the
intent parser classified as `note` used to be ignored with no reply. The parser now gets an `ADDRESSED: yes|no`
section supplied by the app (kept separate from the untrusted note) and is told never to pick `note` when it's yes;
if it still does, the executor replies "Didn't get that · try help" instead of staying silent. Plain notes to self
(not addressed, outside the window rules) stay silent as before.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root.
2. `test/commands/executor.test.ts`: "text addressed to the bot is never dropped as a note" (yb + inline reply, both
   get a reply, packet carries `### ADDRESSED\nyes`); the existing window test asserts `### ADDRESSED\nno` and silence.

### Scenario B — Live text (owner)
1. In the note-to-self thread, text `yb prioritize inviting this person to parties, is a great DJ` (no screenshot needed).
2. **Expected**: within ~20 s a 🅨 reply arrives, either "Didn't get that · try help" or, if the parser reads it as
   a fact, "Couldn't find this person · …". Never silence. The `inbound_commands` row is `handled` with a non-null
   `response_outbound_id`.
3. Text `pick up dry cleaning` with no yb and no bot text in the last 12 h.
4. **Expected**: no reply (status `ignored`, reason `not_addressed`).

**Edge cases**: an inline reply to an old bot text (>12 h) that reads like a note still gets a reply; `log:` texts
are always sent with ADDRESSED yes.
**Platforms**: server. Real classification needs the owner's AI key; actually acting on screenshots and party
preferences is separate work (its own session).

---

## 2026-10-18 — extract-collect EgressBlocked: back-to-back @handles + per-request egress blocks + backfill resume

**What changed**: the pseudonymizer replaces @handles until none is left (back-to-back handles like "@a@b" left the
second one raw, and pseudonymize()'s own re-scan threw) and runs the handle pass again after the digit-run/address
passes. Extraction now fails closed per request: a window whose packet egress refuses (at render, or its user turn right
before submit) is dead-lettered with its messages still covered, recorded in `extraction_items` as `skipped` /
`egress_blocked`, counted (`egress_blocked` in the job stats) and raises one `extraction:egress_blocked` alert. The
rest of the batch/run goes on. The same applies to a consolidation request (that person is skipped). A backfill whose
window build stopped part-way (no `stats.built_at`) finishes building on the next advance before anything else.

### Scenario A — Automated (Claude verified)
1. From the repo root: `npm run typecheck && npx vitest run && npm run lint:pii`.
2. `test/llm/egress.test.ts`: back-to-back handles, a known IG handle next to an unknown one, chains, and a digit run
   before an "@" all scrub cleanly and pass the scanner.
3. `test/extraction/egressBlocked.test.ts`: the root cause with the real egress; a render-time block in the backfill;
   the stuck 2026-10-16 state resuming on collect (real and strict egress); a pre-submit block leaving the rest of the
   batch intact; a split follow-up that re-renders with an @handle; a blocked consolidation request. All seven fail on
   the pre-fix code with `egress blocked: handle×1`.

### Scenario B — Production after deploy (owner)
1. Restart the service from `~/Blackbook` main once the fix is merged.
2. Within ~5 min the next `extract-collect` should finish (`job.finished`, not `job.failed`) and
   `job_state.consecutive_failures` for it goes back to 0.
3. **Expected**: that first collect finishes building the backfill's windows (counts `build_resumed`), then submits
   the pending historical windows from the backfill pool (`llm_requests` kind `historical` appear; the spend shows in
   Settings → LLM). `windows` with mode `historical` move from `pending` to `submitted`.
4. `sqlite3 -readonly <data dir>/yeackbot.db "select count(*) from extraction_items where outcome='egress_blocked'"`
   is 0 with the scrubber fix; any non-zero row is a window that was skipped, not a failed job.

**Edge cases**: a window blocked at render is never re-sent automatically (it stays `dead_letter`); a whole-batch
`excluded` refusal by the client is not covered by the per-request check (only egress findings are).
**Platforms**: server only. Production behavior (backfill submit, real Haiku results) is not verified by Claude.

---

## 2026-10-18 — Extraction requests accepted by the API: one window, two requests (grammar-size fix)

**What changed**: every extraction request was refused with HTTP 400 "The compiled grammar is too large…" (all 45
batch items of 2026-10-16/17; the single `Extraction` output schema had 86 grammar nodes). A window is now read by two
structured-output requests over the same user turn: knowledge (summary, facts, mentions, relations, self_id, topics;
58 nodes) and obligations (commitments, needs_reply; 29 nodes), the second only when obligations can still be kept
(not for historical windows older than 30 days). Both go out in one batch and are merged before validation, so a
window still has one item, one apply and one undo. New prompt version (`7e37e334` → `73a9fc73`). Windows dead-lettered
as `invalid_request` under an older prompt version go back to pending once (nightly submit / backfill step).
`llm/client.ts` refuses any request over 64 grammar nodes locally; `yb llm-smoke` checks every schema.

### Scenario A — Automated (Claude verified)
1. From the repo root: `npm run typecheck && npx vitest run && npm run lint:pii` (1,298 tests green on 2026-10-18).
2. `test/llm/outputSchemas.test.ts`: the node counter matches the live calibration points; the one-request schema
   (86) is refused locally; knowledge 58 / obligations 29 are pinned; every schema in `src/llmSchemas.ts` passes
   `requestIssues` on its route; an LLM call site with an unregistered `schema: X` fails the test.
3. `test/extraction/parts.test.ts`: custom_id pairing, merge (each part only its own keys), failure precedence, a
   refused or errored obligations request deciding for the window, revive under an old version (and no revive under
   the current one).

### Scenario B — Live API smoke (Claude verified on 2026-10-18)
1. `ANTHROPIC_API_KEY=… npm run smoke:llm-schemas` (or `npm run yb -- llm-smoke --live`).
2. **Expected**: 11 lines, every one `200 end_turn` (ExtractionKnowledge, ExtractionObligations, Consolidation, the
   other route schemas and the Ask tool set), then `11/11 accepted by the API`. `--model claude-sonnet-5-5 --only
   ExtractionKnowledge,ExtractionObligations` → both 200 as well. Without `--live` nothing is sent (node counts only).

### Scenario C — Production after deploy (owner)
1. Merge (after #59), `git pull` in `~/Blackbook`, `bash scripts/service.sh restart`.
2. At the next 03:10 `extract-submit`: counts show `revived_invalid_request` (the dead-lettered steady windows) and
   `submitted`; `llm_requests` gets two rows per steady window (custom_ids `x73a9fc73-…-N` and `…_o-N`).
3. **Expected**: the following `extract-collect` reports `applied` > 0 and no `dead_letter_invalid_request`; facts,
   commitments and reply verdicts appear with `prompt_version = 73a9fc73`.
4. `sqlite3 -readonly <data dir>/yeackbot.db "select outcome, count(*) from extraction_items where prompt_version='73a9fc73' group by 1"`
   shows `ok` rows and no `invalid_request`.

**Edge cases**: a window whose obligations request is refused is refused whole (nothing from its knowledge answer
applies); a missing or errored part retries the whole window; the shadow eval's `--system-file` replaces only the
knowledge prompt.
**Platforms**: server only. Real extraction results (quality of the split prompts) are not verified by Claude.

---

## Screenshots in self-thread commands + "prioritize inviting X to parties" (2026-10-18)

**What changed** (replies use the plain-sentence style from #60): a `yb …` text sent with a screenshot (or a screenshot sent up to 3 min before it) now carries the
image to the intent step. The collector serves it from a new route, `GET /v1/imessage/attachment` (note-to-self thread
only, images only, downscaled JPEG ≤1568 px), and the LLM client sends it on the `intent` route (Haiku 5.5, ≤2 images)
through the egress choke point, which lets out only image bytes the client approved for that request. The model reads
the profile's username and display name; "this person" (ref `IMG`) is matched locally against identities by Instagram
username (key or raw), or added as a **roster-only** person with an `instagram_username` identity (journaled). A new
intent, `set_preference`, puts people in a reserved user circle **Party invites** (signature `pref:party_invites`);
facts like "great DJ" go in as `add_fact` facts. Party invites people lead pre-event brief and follow-up lists, and
pre-event / follow-up / intro suggestions about them score ×1.3 ("Why this?" shows it). New setting: Settings → Agent →
"Read screenshots in commands" (default on). Everything is in the command's run, so `undo` reverts it.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1302 tests; the one failure seen was
   `pipeline/occasions/run.test.ts` matching `/555/` inside a random UUID (pre-existing flake, passes on rerun).
2. `collector/run-tests.sh`: 68 Swift tests, including the "attachment images" suite (self-thread PNG → JPEG at
   `max_edge`, DM photos / stickers / PDFs / undecodable / missing files / paths outside the root refused).
3. `npm run eval -- intent` with the key (synthetic notes + `packages/server/src/eval/fixtures/intent-profile-screenshot.png`):
   6/6 passed on Haiku 5.5 for $0.0022, including reading `yb.eval.rowan` off the screenshot.

### Scenario B — New person from a screenshot (owner, after rebuilding the collector and deploying)
**Setup**: rebuild + re-sign BlackbookServer.app (new route), restart yeackbot from `~/Blackbook` main.
1. Screenshot the Instagram profile of someone yeackbot doesn't know. In your note-to-self thread send the screenshot
   with the text `Yb prioritize inviting this person to parties, is a great DJ`.
2. **Expected** within ~30 s: `🅨 ✓ Noted for <First L.> (new, from your screenshot).` / `Noted: “great DJ”` /
   `Prioritized for party invites.` / `(Text "undo" to take that back.)`
3. yeackbot.com → Circles → **Party invites** lists them. (They are roster-only, so People and suggestions leave them
   out until they qualify, e.g. a DM; the circle membership stays and applies then.)
4. Text `undo`. **Expected**: `✓ Undone: note for <First L.> + prioritized for party invites`; the circle no longer lists them.

### Scenario C — Someone you already know
1. Send a profile screenshot of a contact whose Instagram is already linked (Beeper) with `yb always invite this person to parties`.
2. **Expected**: `✓ Noted for Sam R.` / `Prioritized for party invites.`; no new person appears.

### Scenario D — By name, no screenshot
1. `yb prioritize inviting Sam to parties` with two Sams in your contacts.
2. **Expected**: `Which Sam did you mean?` with `1. Sam R.` / `2. Sam K.`; reply `2` → `✓ Noted for Sam K.` /
   `Prioritized for party invites.`

### Scenario E — Ranking
1. With a Party invites person at one of today's events, read the morning brief. **Expected**: they lead the
   pre-event item's people. The morning after, the follow-up lists them first in their group; "Why this?" on a
   pre-event / follow-up / intro item about them shows "In Party invites ×1.3".

**Edge cases**: Settings toggle off → `Reading screenshots is off (Settings → Agent). Tell me who it is by name.` and
nothing is fetched or sent; the file not synced to the Mac yet → `I couldn't open the screenshot yet. Send it again in
a minute.`; no username visible and no unique full-name match → `I couldn't tell who that screenshot shows. …`; a business /
service account → refused; sending the same screenshot again adds nothing twice; a DM photo can never be fetched (the
collector refuses non-self chats); a screenshot sent alone with no `yb` text is never read.
**Platforms**: server + collector (Swift) + web (one toggle). Not deployed: needs the collector rebuild + signing and a
server restart; until then the route 404s and commands stay text-only.

---

## LLM API errors are diagnosable without content (2026-10-18)

**What changed**: the one Ask 400 in the ledger (2026-10-18 23:42 UTC) was traced to the pre-#57 tool set: its
prompt_version `b99f5720` hashes to the #56 Ask tools, which had 24 nullable (anyOf) filters against the API's limit
of 16 union-typed parameters across strict schemas. #57 had already fixed it; the next Ask after the redeploy
succeeded. New here: a failed API call now records a content-free classification instead of a bare
`BadRequestError:400`: `llm_call_failed` carries `error_code` (`{API error type}:{code from a fixed list of known
messages}[:{field path from fixed words}]`, e.g. `invalid_request_error:strict_union_limit:tools.3.custom`),
`request_id` (`req_…`) and, in the tool loop, `counts.turn`. The ledger's `error_type` for that row is
`api_error:{error_code}`. `llm_batch_results` counts errored items per code. The API's message is never logged or stored.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root.
2. `test/ask/request.test.ts`: real client, real Ask system prompt and tools, both routes (ask_imessage 2500 /
   ask_web 4000 max_tokens), first request and the request after two tool results pass `requestIssues`; the
   pre-#57 tool set (24 nullable filters) is refused locally and nothing reaches the API.
3. `test/llm/client.test.ts`: a 400 whose message carries a marker word → outcome, log line and ledger row hold the
   code and request id, never the marker; `errorBodyCode` table; a tool-loop failure logs `counts.turn = 1`;
   batch errored items counted per code.

### Scenario B — Live (owner, after deploy)
1. `grep llm_call_failed ~/Library/Application\ Support/Yeackbot/logs/server-$(date +%F).jsonl` after any failure.
2. **Expected**: `error_code` names the cause (e.g. `strict_union_limit`, `grammar_too_large`, `prompt_too_long`);
   `request_id` can be looked up in the Claude Console logs for the full message. `unrecognized` = a message outside
   the known list (look the request id up, then add a pattern to `API_ERROR_CODES`).
3. `yb llm-usage` / the ledger: an errored sync row shows `error_type` like `api_error:invalid_request_error:…`.

**Edge cases**: a mid-stream SSE error has no HTTP status (`error_class` `APIError`) but still gets a type/code;
connection errors stay `APIConnectionError` with no code; an echoed prompt word can at worst pick the wrong code
(fixed vocabulary), never leak text.
**Platforms**: server. Not deployed; no live API call was made for this change.

## 2026-10-18 — Unambiguous names in the brief and suggestion copy (collision-aware "First L.")

**What changed**: copy shortens names to "First L."; when that short form reads the same as the owner's own (the
owner's names: the 'me' row and records merged into it, its Contacts card fields and Contacts identity display
name) or as another person's in the same brief (or the same suggestion), the full last name is used instead:
"Check in with Sam Rivera" rather than "Check in with Sam R.". Everywhere else "First L." is unchanged. Applies to
template copy, the LLM composer (local de-tokenization; the packet still never carries a last name), the `more`
reply, the reply acks ("✓ … (Sam Rivera)"), "Why this?", the suggestion history headlines and the learner's person
label. In the LLM packet, a person whose first name is ambiguous (the owner's own first name, or shared with
someone named in full) is given as a token only, and the grounding validator sends a headline/body with such a bare
first name back to template copy. Openers keep first names (they are addressed to the person).

### Scenario A — Automated (Claude verified)
1. From the repo root: `npm run typecheck && npx vitest run && npm run lint:pii`.
2. `test/identity/ownerNames.test.ts`: owner collision, same-short-name pair, unchanged default, no-last-name and
   display-name-only people, the owner's name sources (card identity, card fields + nickname, merged records; the
   "Me" placeholder ignored).
3. `test/delivery/names.test.ts`: template brief texts and reply-ack labels, the `more` path, LLM packet (token-only
   lines, tokenized plain version, no last names), de-tokenized long names, a bare ambiguous first name falling back
   to template, longest-name-first tokenization, the validator rule.
4. `test/pipeline/suggestions/names.test.ts`: "Why this?" summary, history headline and person label for an owner
   collision; an intro between two people with the same short name.

### Scenario B — Production after deploy (owner)
1. Merge, `git pull` in `~/Blackbook`, `bash scripts/service.sh restart`.
2. On a day the brief names a friend whose first name and last initial match yours, open yeackbot.com/today (or the
   iMessage brief). **Expected**: the item reads "… with <First> <full last name>", not "<First> <initial>.".
3. Reply "done N" to that item. **Expected**: the ack names the friend the same way.
4. Any other friend (no shared short name) still reads "<First> <initial>.".

**Edge cases**: two friends with identical full names keep the full name (nothing else to tell them apart); a friend
with no last name stays the first name alone; the push notification body (first names only, when turned on) is not
changed; Ask answers and log/note command acks are not changed by this work.
**Platforms**: server only. Not checked against a live brief or live Haiku output.

## 2026-10-18 — "Who to invite" suggestions for parties you host (party_invite)

New suggestion kind `party_invite` (generator `intel/invites.ts`, migration **023 party_invite** rebuilds
`suggestions` to widen its kind CHECK). For a party or event the owner hosts 2–14 days out — a Partiful event where
he is host / co-host, or a social calendar occasion he organizes (his own calendar copy, not "Kit's …"; a hosting title
like "at mine" / "my birthday" / "housewarming", or calendar invites he sent: ≥1 for a party-like title, ≥3 for
anything social) — one item suggests up to 5 people not yet on the guest list: **Party invites** circle members
first (strongest tie first), then strong ties (T ≥ 40) who came to ≥ 2 of his social happenings in the last year or
to one he hosted. Anyone with a guest-list row in any status (going, maybe, invited, declined, waitlist, rejected), a
calendar invite or an occasion-candidate match is left out, as are hidden, roster-only and service people, people
muted for the kind, and people resting after ignored suggestions. Items about Party invites people score ×1.3.
Acting = texting one of them, or one of them joining the guest list, within 7 days.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1397 tests pass, 905 files clean.
2. `packages/server/test/intel/invites.test.ts` (hosted-event detection, ordering, every exclusion, the stage storing
   boosted items, guest-list reward, copy), `test/pipeline/suggestions/migration.test.ts` (023 keeps rows, columns,
   indexes and foreign keys; new kind accepted, unknown kinds refused), `test/delivery/template.test.ts` (brief copy).

### Scenario B — A Partiful party you host (owner, after deploy)
**Setup**: deploy (migration 023 runs on start), at least one person in Circles → Party invites, and a Partiful event
you host 2–14 days out that has synced.
1. Next morning's brief (or yeackbot.com/today after the nightly run). **Expected**: a text like
   `Who to invite to <event title>` / `You're hosting on Sat. Sam R., Priya S. and Lee K. aren't on the guest list
   yet. Sam is on your Party invites list.`
2. Check the people: Party invites members come first; nobody already on the Partiful guest list (including people
   who declined or were only invited) is named.
3. Reply `why` to that text. **Expected**: "You're hosting in N days and … aren't on the guest list yet. …" plus up
   to four reasons (e.g. "Starts in", "Going so far"); the web's "Why this?" lists all of them, including
   "From Party invites" and "In Party invites ×1.3".
4. Invite one of them on Partiful. **Expected**: after the next Partiful sync + hourly rewards job, the item is done
   (actedVia `guest_list`) and the learner credits the kind.

### Scenario C — A calendar event you organize
1. Create a calendar event "Game night at mine" 5 days out on your own Google calendar (no invites needed), or
   "BBQ" with one invitee. **Expected** after the nightly run: a "Who to invite" item for it; the invitee is not named.
2. Create "Dinner w/ <one friend>" with only that friend invited, or put "<Friend>'s birthday party" on your calendar.
   **Expected**: no invite suggestion for either.

**Edge cases**: event 0–1 days or ≥15 days out → nothing; everyone eligible already on the list → no item; a
cancelled Partiful event → nothing; muting the kind (Settings → learner muted kinds) stops it; a Party invites member
who is **roster-only** (e.g. added from a screenshot of someone you've never texted) is not suggested until they
become an active contact; shown once per event.
**Platforms**: server + web label ("Invite"). Not deployed; not checked against the live database.

---

## Owner's own records never become suggestions; owner-confirmed merge into me (2026-10-18)

**What changed**: a user merge (`method: 'user'`) may fold a person record into the `me` person (agents still can't;
`me` never merges into anyone). `identity/self.ts` defines "my records": `me`, everyone merged into it, and any
person still holding one of my handles (`settings.self_handles` plus the phones/emails on me; Gmail aliases by
dots/`+tag` count). Tie stats, the suggestion chokepoint (`normalizeCandidate`), memories, circle activity and
detection, intel attendees, intro candidates and trip/location matching all skip them. The nightly matcher first
runs a self-link pass (`identity/selfLink.ts`): an agent-made duplicate of me moves to me whole and is retired; on an
established record only my handle moves. An unseen handle of mine from any source attaches to me, and a Contacts
card counts Gmail aliases toward "two of my handles".

### Scenario A — Automated (Claude verified)
1. From the repo root: `npm run typecheck && npx vitest run && npm run lint:pii`.
2. `test/identity/self.test.ts` (self set incl. aliases, shared and unlinked handles; self-link absorb vs. handle-only
   move; undo blocks the handle from me; new keys of mine; Contacts card), `test/pipeline/selfExclusion.test.ts`
   (ties, suggestions stage, memories, circle activity, intel), `test/merge.test.ts` (user-only merge into me, undo),
   `test/pipeline/circles/circles.test.ts` (no circle membership or suggested additions for a record of mine).

### Scenario B — Undo an owner merge into me
**Setup**: a person record that was merged into you (Activity shows "Merged … into you").
1. Activity → that batch → Undo.
2. **Expected**: the record is back as its own person in People, and a do-not-merge pair is written so it isn't
   folded in again automatically.

### Scenario C — A stray handle of mine (after deploy, owner)
1. Have a contact record carry a Gmail `+tag` alias of your own address (any established record).
2. Wait for the nightly `identity-match` run (or `npm run yb -- run-job identity-match`).
3. **Expected**: Activity shows "Linked o•••@… to you"; the alias is on you, the rest of the record stays put, and the
   record gets no tie stats or digest items while it still holds a handle of yours. Undoing that batch moves the
   alias back and it stays there on later nights.

**Edge cases**: a handle marked shared, or one you unlinked from yourself (undo), is never treated as yours; `+tag`
aliases outside Gmail are not assumed to be yours; an agent (deterministic/probabilistic/LLM) merge into me is
refused with `me_mismatch`.
**Platforms**: server only. Verified against a read-only snapshot of the live DB: 3 records of mine, 0 stray
handles, self detection ~10 ms. The production merge was done with the journaled path; the code itself is not deployed yet.

## 2026-10-18 — Extraction enums: enforced by the grammar, and an out-of-set value costs one item, not the window
Three backfill windows failed validation (`schema_invalid`) because one commitment had owner `"P66"` / `"P22"` or
kind `"text"`: the SDK's `zodOutputFormat` moved every `enum` into a description, and one bad value failed the whole
window. Each was re-sent whole (a paid retry) and applied on attempt 1; a second miss would have dead-lettered it. Now `outputFormat` (llm/caching.ts) puts the enums back into the grammar, and `parseExtraction`
(extraction/schema.ts) drops only the item holding an out-of-set string (`dropped_<item>_bad_enum`).

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1356 tests green. New tests:
   `test/llm/outputSchemas.test.ts` "enums in the output format" (every zod enum reaches the grammar, $defs / oneOf /
   nullable, no "{enum:" description left, pinned sizes still 58 / 29); `test/extraction/validate.test.ts`
   "enums (parseExtraction)"; `test/extraction/parts.test.ts` "an obligations answer with a value outside an enum"
   (owner "P66" → facts + the other commitment applied, `dropped_commitment_bad_enum: 1`; a missing key next to it
   still fails the window).
2. `npm run yb -- llm-smoke --live` (key from ~/Blackbook/.env): 11/11 schemas 200 on Haiku 5.5.
3. One-off live probe (not committed): asked for owner "P66" / kind "text" with the obligations schema. SDK-only
   format → 3/3 answers `P66` / `text`; with enums → 3/3 `ME` / `other`. Knowledge schema margin with enums: +16
   extra fields 200, +17 400 (before: +16 200, +18 400).

### Scenario B — After deploy (owner)
**Setup**: merge, `git pull` + `scripts/service.sh restart` in ~/Blackbook. Extraction prompt version becomes
`aa4ba557` (was `73a9fc73`); consolidation `2bed667a`, adjudication `cf134f0a`.
1. After the next nightly collect, `yb run-job extract-collect` summary / `llm_batch_results`: no new
   `dead_letter_schema_invalid` for enum values; any `dropped_*_bad_enum` count should be 0 (the grammar enforces them).
2. `SELECT outcome, count(*) FROM extraction_items WHERE prompt_version = 'aa4ba557' GROUP BY 1` → `ok` dominates,
   no `schema_invalid`.

**Edge cases**: a missing key or a wrong type (number / null in an enum field) still fails the window (retry, then
dead letter); a bad `needs_reply` enum drops only the verdict (no verdict, not `n_a`); two bad fields in one
commitment count as one dropped item. The 3 windows hit on 2026-10-18 were retried and applied (live DB, attempt 1):
nothing to recover.
**Platforms**: server only. Not deployed.

## 2026-10-18 — Extraction revive: schema_invalid dead letters under an older prompt get one more try
`reviveDeadLetters` (extraction/run.ts, was `reviveInvalidRequests`) now also sends back to pending a window whose
last item was dead-lettered as `schema_invalid` under an older extraction prompt version (as an out-of-enum value
did before enums were enforced), once per version, at the nightly steady submit and at the backfill step while a
backfill is running. Counts are per outcome: `revived_invalid_request`, `revived_schema_invalid`. A window at its last
attempt (`MAX_ATTEMPTS`) is no longer revived (it was set straight back to dead_letter every night).

**Live check (read-only, 2026-10-18 22:45 PDT):** the 3 historical windows that answered `schema_invalid` under
`73a9fc73` were NOT dead-lettered: each was retried once (attempt 1) and applied. All 3,092 historical windows are
`applied`, the backfill is `done`, and the only dead letters are the 111 steady `invalid_request` / `7e37e334`
windows (all at attempt 0) that the existing revive picks up at the next 03:10 submit. So nothing is recovered by this
change today; it is a safety net for later schema failures.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1,395 tests green. New tests in
   `test/extraction/parts.test.ts` "windows whose answer failed the schema under an older prompt" (synthetic world):
   a schema_invalid dead letter under `73a9fc73` is revived (`revived_schema_invalid: 1`), resent at attempt 2 under
   the current version and applies; a revived window that fails again is dead at once (no second schema retry) and
   is not revived the next night; one dead-lettered under the current version stays dead; one at its last attempt
   stays dead; a consolidation item (person, no window) is never revived in either mode.
2. Mutation check: narrowing the query back to `invalid_request` fails 2 of the new tests; dropping the attempt bound
   fails 1.

### Scenario B — After deploy (owner, with #69)
1. After the first 03:10 extract-submit on the new version, the run summary shows `revived_invalid_request` for the
   111 steady windows and no `revived_schema_invalid` (there are none today).
2. `SELECT w.mode, i.outcome, i.prompt_version, count(*) FROM windows w JOIN extraction_items i ON i.custom_id =
   w.last_custom_id WHERE w.status = 'dead_letter' GROUP BY 1, 2, 3` → only rows under the current version remain
   after the next submit.

**Edge cases**: historical windows are revived only while a backfill is `running` / `budget_exhausted`. After the
backfill is `done` (as now), a historical dead letter is not picked up by any job. Every later prompt-version change
gives old dead letters one more try (one window's cost each). Consolidation dead letters are never revived.
**Platforms**: server only. Not deployed.

## 2026-10-18 — Unambiguous names in Ask answers over iMessage and in log/note/screenshot acks

**What changed**: two more places switch "First L." to first name + full last name when the short form reads the same
as the owner's own (their Contacts card identity, card fields or merged records; the "Me" placeholder never counts)
or as another person's in the same reply. Ask answers over iMessage (model answers, people lists one line per
person, and the plain-search fallback): the longer form is applied locally when the answer is de-tokenized; the
model still only ever sees tokens and "First L.". Command acks ("✓ Logged coffee with …", "✓ Noted for …",
including a person from a profile screenshot), their journal titles and the "Undone: …" summary: the same rule
against the owner and among the people the command names. Web Ask answers already show full names; everything else
keeps "First L.".

### Scenario A — Automated (Claude verified)
1. From the repo root: `npm run typecheck && npx vitest run && npm run lint:pii`.
2. `test/ask/names.test.ts`: `answerNames` default / owner collision / same-short pair; iMessage answers for each
   case, the model's user turn carrying "Jess K." and never the full last name, a people list naming a same-short
   pair in full on every line (details too), the web unchanged, and the plain-search fallback over iMessage naming
   the owner-colliding person in full.
3. `test/commands/names.test.ts`: `commandLabels` default / owner collision / same-short pair / display-name-only
   person; a `log:` with an owner-colliding friend (ack, journal title, undo summary), a `log:` naming two "Sam R."s,
   and either one alone back to "Sam R.".
4. `test/commands/screenshot.test.ts`: a new person from a profile screenshot whose "First L." is the owner's own →
   `✓ Noted for <full name> (new, from your screenshot).`, and the note / Party invites journal titles likewise.

### Scenario B — Production after deploy (owner)
1. Merge, `git pull` in `~/Blackbook`, `bash scripts/service.sh restart`.
2. In your note-to-self thread, `log: coffee with <first name>` for a friend whose first name and last initial match
   yours. **Expected**: `🅨 ✓ Logged coffee with <First> <full last name> today.`
3. `log: dinner with <Friend A> and <Friend B>` for two friends with the same first name and last initial.
   **Expected**: both named in full. `undo` → `✓ Undone: log for <both full names> (…)`.
4. `? where does <that friend> work` over iMessage. **Expected**: the answer names them in full; ask about any other
   friend and the answer reads "<First> <initial>.".
5. `? who do I know in <a city where both same-initial friends live>`. **Expected**: one line per person, those two
   in full.

**Edge cases**: two friends with identical full names keep the full name; a friend with no last name stays the
first name; clarification options ("Which Sam did you mean?") keep their own rule (full last name only when two
options collide); the plain-search fallback may use the full name when a colliding person was found but cut from the
text by the length cap.
**Platforms**: server only. Not checked against live Haiku output or the production DB.

## 2026-10-18 — "Who to invite" never suggests someone already invited (Partiful cross-check)

Owner: "Always cross check who to suggest to invite against currently invited people on partiful, to ensure im not
told to invite duplicates". Three gaps closed:
1. **Freshness.** New job `partiful-hosted-guests` (every 30 min) re-reads the guest lists of Partiful events you host
   in the next 15 days (read-only `getGuests`, same allowlist and rate gate; no hosted event → no calls). A party_invite
   item for a Partiful event needs a complete read within the last hour; otherwise there is no item. Before the brief
   sends (and on Today), an item whose list went stale or that now names someone on it is dropped.
2. **Identity gaps.** Candidates sharing an identity with a guest on another record are left out: a phone inside a
   WhatsApp id, Gmail addresses differing in dots or +tags, an @handle on a Beeper/Instagram record, the same Partiful
   user, or an open "maybe the same person" match.
3. **Name-only guests.** Candidates whose first + last name matches any name on the list (same last name; first names
   in one nickname family like Will/William) are left out — including SMS invitees with no Partiful account, now kept
   by name for events you host (migration **024 partiful_guest_names**), and names on the calendar invite.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root, all green.
2. `test/adapters/partiful/ingest.test.ts` "partiful-hosted-guests" (only hosted lists in the next 15 days are read,
   SMS invitees kept by name and forgotten when removed, a failed read is marked error, nothing hosted → no calls);
   `test/intel/invites.test.ts` "never a duplicate invite" (stale / failed / partial / unread list → no item; phone,
   Gmail, @handle and maybe-match gaps; names incl. nickname, SMS invitee and calendar name; single first names and
   other families don't count; the brief drops a stale item or one naming someone invited after the ranking).

### Scenario B — Live (owner, after deploy)
**Setup**: a Partiful event you host 2–14 days out, Party invites people or close party-goers not on it yet.
1. Next morning, note who "Who to invite to <event>" names. In Partiful, invite one of them (or text-invite them by
   phone through Partiful) before 07:00 the next day. **Expected**: the next brief doesn't name them.
2. Invite someone named in today's item between 07:16 and the brief's send time. **Expected**: within 30 minutes the
   refresh job reads the list and the item is dropped from the brief / Today.
3. Sign out of Partiful in the sandbox browser (the refresh fails). **Expected**: within an hour no "Who to invite"
   item for the Partiful event appears; Sources shows Partiful needs a sign-in. Sign back in → items return.

**Edge cases**: calendar-only hosted events (no Partiful) aren't gated on freshness; a guest named only "Sam" (no last
name) doesn't block anyone; a matcher pair marked separate doesn't block.
**Platforms**: server only. Not deployed; not run against the live Partiful API.

---

## Partiful guest records linked to your contacts ("two records for one person") (2026-10-18)

**What changed**: a Partiful guest arrives as its own person (a `partiful_user` identity, usually roster-only). When only
the name tied it to a contact, the matcher kept them apart (a name alone never merges), so the same friend showed up
twice: in invite suggestions, briefs and on person pages. A new pass in the nightly matcher
(`identity/partifulLink.ts`) merges the Partiful-only record into your contact when **all** hold: the full name
(first + last, no initials) belongs to exactly one other person in the whole book and to no other Partiful record; the
guest was on a Partiful event you hosted or went to; the contact is a real one (Contacts card, 1:1 conversation or a
logged interaction); and the matcher's guards pass (not both on one guest list, no "not the same" / undo history,
distinct Contacts cards). Your contact always survives. Each link is a journaled merge (undo splits it and keeps them
apart for good) and counts against the nightly merge cap (25).

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1417 tests, 911 files clean.
2. `test/identity/partifulLink.test.ts`: link + survivor + evidence + undo/do_not_merge; ambiguous names; a stranger
   contact, a declined event, a first name alone; same guest list (G2) and a dismissed pair; the nightly cap.
3. Dry run on a copy of the live database (2026-10-18): 381 Partiful-only guests from your events with a full name →
   24 linked (all into active contacts with a Contacts card), 19 left apart as ambiguous, 4 whose namesake isn't a
   real contact.

### Scenario B — After deploy (owner)
1. The morning after the deploy, open yeackbot.com → Today's activity feed: up to 25 entries like "Merged <name> into
   <name> (same full name, Partiful guest of yours)".
2. Open one of those people: their Partiful events now appear on the contact you know.
3. If one is wrong, undo it from the feed. **Expected**: the two split again and are never re-linked.

**Edge cases**: two contacts with the same name, or a second Partiful record with it → no link (the invite cross-check
still treats a matching guest name as already invited); a hidden or priority person is never absorbed; with more than
25 eligible links, the rest follow on later nights.
**Platforms**: server only. Not deployed.

## 2026-10-18 — Closeness 1–10 instead of shown vs. background

Every person now has a closeness score from 1 (acquaintance) to 10 (closest), computed from the nightly tie numbers:
1 = the background (seen only: a guest-list or group-roster name — the old "roster-only" — plus hidden, merged and
service rows), never shown or suggested; shown people get 2–10 from max(T, H/2) (10 ≥ 80, 9 ≥ 65, 8 ≥ 50, 7 ≥ 40,
6 ≥ 30, 5 ≥ 22, 4 ≥ 15, 3 ≥ 7, else 2). The person page shows "7/10" next to the state, People rows show the number
and People has a **Closest** sort. Rules follow it (party-invite regulars need 7+), with the owner's own asks as
exceptions: priority people skip the minimum, and someone named in a text command (a screenshot) is brought out of
the background at once (journaled; `undo` reverts it).

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1454 tests pass.
2. `test/pipeline/ties/closeness.test.ts` (mapping, background = 1, merged ids, exceptions), `test/routes/people.test.ts`
   (scores on rows and the person, Closest sort + paging), `test/intel/invites.test.ts` (7+ for regulars, priority
   exempt), `test/commands/screenshot.test.ts` (roster-only / new / suppressed person named by screenshot → shown),
   `packages/web/test/person-logic.test.ts` (labels).

### Scenario B — Web (owner, after deploy)
1. yeackbot.com → People → sort **Closest**. **Expected**: your closest people at the top with 10, 9, …; most of the
   list at 2–4; each row shows its number left of the state dot.
2. Open a close friend. **Expected**: the header line reads e.g. "● Strong 9/10 · usually every ~4d · last 2d ago";
   hovering the ring says "Strong · closeness 9 of 10".
3. Open someone you used to talk to a lot but haven't in months. **Expected**: a middle score (e.g. 6/10), not 2.

### Scenario C — Exceptions
1. Text `yb prioritize inviting this person to parties` with an Instagram screenshot of someone yeackbot has only seen
   on a guest list. **Expected**: they show up in People (New), with closeness 2+, and can be suggested in "Who to
   invite"; `undo` puts them back in the background.
2. Mark a party-goer with a low score (under 7) as priority. **Expected**: the next "Who to invite" for a party you
   host can include them.

**Edge cases**: a person with no stats yet shows 2/10; hidden people never appear in any sort; an old Closest-sort
cursor from before the deploy still pages (closeness optional in the cursor).
**Platforms**: server + web. Not visually checked in a browser; not deployed.

## 2026-10-21 — Circles are friend groups and shared interests, not Partiful events

Auto circles used to come from Partiful guest lists and take an event's title (the party's name, or "<party> crew").
Now: co-attendance counts only between people who shared ≥ 2 events / get-togethers; Partiful organizer accounts
(venues, promoters: known only through Partiful, host-only) are never members; names come from group chats, shared
interests ("Rock climbing crew") or first names, never event titles (the LLM gets only a count of shared gatherings).
Each interest held by 3+ people (tentative/confirmed facts) becomes an auto circle ("Skiing"), or suggested additions
for the owner's own circle of that name. On the first weekly run, auto circles named after an event are renamed if
still detected, otherwise retired (undoable from Activity), unless the owner ever edited them.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root.
2. `test/pipeline/circles/socialGroups.test.ts`: one party → no circle, two → a circle named without the title; LLM
   packet has no event titles; a chat titled like the party lends no name; "Rock climbing crew"; organizer excluded;
   interest circle kept by signature (join / retract / owner removal / owner delete); "Running" user circle gets
   "Shares this interest" suggestions; legacy event circles renamed / retired / undo respected / owner-touched kept /
   retired circle doesn't block. `test/pipeline/circles/circles.test.ts`: LLM name already taken → deterministic name.
3. Dry run on a copy of a live snapshot (no LLM): 2 event-named circles retired, 1 renamed, no event-titled names, 2
   interest circles created, owner's Skiing / Running circles get suggestions.

### Scenario B — Web (owner, after deploy and the Sunday circles run, or `yb` run of job `circles`)
1. yeackbot.com → More → Circles. **Expected**: no auto circle named after a party; auto circles show group-chat names,
   "<Interest> crew", interest names like "Skiing", or LLM names such as a friend-group description.
2. Today / Activity feed. **Expected**: "Renamed an auto circle that was named after an event" and "Retired an auto
   circle that was named after an event" entries, each with Undo.
3. Undo a retirement. **Expected**: the circle comes back with its members and stays on later weekly runs.
4. Open your Skiing (or Running) circle. **Expected**: Suggested additions marked "Shares this interest".
5. Open a person who used to be in a party-named circle. **Expected**: that chip is gone; their friend-group circles
   (group chats) remain.

**Edge cases**: a recurring party series still forms a circle (repeated co-attendance) but is named by interests or
first names; an event-named circle you renamed, locked or edited is never touched; deleting an interest circle keeps it
gone; candidate or sensitive interests never make a circle.
**Platforms**: server + web copy. Web not visually checked; not deployed.

## 2026-10-21 — Places are place names ("Los Angeles, CA", "Berlin, Germany")

A person's Places (Overview → Facts & interests) show only real cities and towns in one form: "City, ST" in the US,
"City, Country" elsewhere. Nicknames are spelled out ("LA" → "Los Angeles, CA"), neighborhoods fold into their city
("Silver Lake" → "Los Angeles, CA", "Brooklyn" → "New York, NY"), and venues, homes, addresses, vague areas ("Bay
Area"), states or countries alone and "where they are not" never show. Trips moved to their own **Trips** group.
Extraction writes place names from now on (prompt + a deterministic normalizer, no extra LLM call); the
`places-tidy` job (daily 03:05) fixes what the agent stored before, as one undoable batch. Facts and Places
collections the owner entered change only through `places-tidy-owner`, after the owner agrees.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1471 tests pass, lint clean.
2. `test/intel/placeNames.test.ts` (nicknames, neighborhoods, namesakes, unlisted towns with a state, non-places,
   first names and street names never read as cities, every gazetteer name reads back as itself),
   `test/intel/placeTidy.test.ts` (rename / fold / close in one batch, undo, owner data untouched, owner run manual
   only), `test/extraction/validate.test.ts` + `pipeline.test.ts` (normalized at extraction, `fact_not_a_place`, old
   "la" block still blocks, "Portland, OR" ≠ "Portland, ME", "ME" in a place is Maine), `test/routes/personExtras.test.ts`
   (chips, hidden non-places, starters), Ask/`log:` tests (place names in answers and acks),
   `packages/web/test/person-logic.test.ts` (Trips group).
3. `npm run yb -- llm-smoke`: schemas unchanged (ExtractionKnowledge 58 nodes ≤ 64).
4. Dry run on a read-only copy of the live DB: 131 of the agent's place facts renamed, 13 duplicates folded, 84
   non-places closed; apply → second run (no-op) → undo restores all.

### Scenario B — Web (owner, after deploy and one `places-tidy` run)
1. **Setup**: `npm run yb -- run-job places-tidy` (or wait for 03:05).
2. Today → activity feed. **Expected**: one line "Wrote places as place names: … renamed, … duplicates folded, …
   that weren't places closed" with Undo.
3. Open a friend whose Places said "Currently in LA" (an inferred fact). **Expected**: "Currently in Los Angeles, CA".
4. Open someone whose Places showed a home or a vague area ("lives with you as roommate", "Bay Area"). **Expected**:
   it's gone from Places and from History.
5. Overview → Conversation starters for someone in LA. **Expected**: "Hey <name>, how's life in Los Angeles?"; for a
   move: "How's the move to <city> coming along?".
6. Ask "who do I know in LA?". **Expected**: people listed with "Los Angeles, CA".

### Scenario C — Your own entries (only after you say yes)
1. `npm run yb -- run-job places-tidy-owner`.
2. **Expected**: your legacy "Currently in LA" facts read "Los Angeles, CA" in the data too; Places collections named
   after a city ("LA", "SF", "NYC") get place names; ones named after a state or country stay exactly as they are. One
   undoable feed line.

**Edge cases**: until the owner run, the owner's legacy "LA" facts already *display* as "Los Angeles, CA" (nothing stored
changes); "Venice" alone is the LA neighborhood ("Venice, Italy" stays Venice, Italy); a friend named like a city
("lives with Charlotte") or a street ("Hollywood Blvd") is never a place; a two-city value ("Calabasas or Santa
Monica") is not a place.
**Platforms**: server + web. Not visually checked in a browser; not deployed; no live LLM run of the new prompt.

---

## Calls on the person timeline + round avatar in the tie ring (2026-10-21)

The collector serves the Mac's call log (`GET /v1/calls`, CallHistory.storedata, read-only). The `calls` job (every
5 min) stores every call (`calls`, `call_handles`, migration 025) and turns answered calls with a known person into
derived `call` interactions (tie strength, "last talked", commitments). The person Timeline shows calls (answered and
missed) from the call log with Phone / FaceTime filters; Sources has a "Phone & FaceTime calls" card. The Mac only logs
calls that rang or were placed on it: incoming iPhone calls via Continuity and FaceTime, with no length for calls
answered on the iPhone and no outgoing iPhone calls. The header avatar is now a circle inside the circular ring.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1466 tests pass.
2. `collector/run-tests.sh` (72 Swift tests, incl. `CallHistoryTests`: paging, participants join found by suffix,
   missing store / unknown layout / bad params) and `xcodebuild build test -scheme BlackbookServer` succeed.
3. `test/adapters/calls/ingest.test.ts` (mapping, normalization, linking, missed/unknown/me/service excluded, cursor
   paging + rebuilt-store reset, later contacts pick up past calls, job error handling), `test/routes/people-sources.test.ts`
   (calls on the timeline once each, channels + filters + paging), `test/migrate.test.ts` (025 dedupe key).
4. `swift run yb-collector-verify` against the real call log (counts only): 1,204 calls, 548 answered, 33 FaceTime.
5. Local preview on a migrated copy of the live DB: 1,204 calls stored, 209 linked as interactions; a person's Timeline
   shows "Call from …" / "Missed call from …" cards and Phone / FaceTime chips; Sources shows the Calls card healthy.

### Scenario B — Web (owner, after deploying the server AND swapping in the rebuilt collector)
1. yeackbot.com → Sources. **Expected**: a "Phone & FaceTime calls" card, Healthy, with a Calls count within ~5 min.
   (Before the collector swap it reads "The Mac helper needs an update to read calls.")
2. Open someone you talk to on the phone → Timeline. **Expected**: phone-call cards between the chats ("Call from
   <first name>", "Missed call from …", "You called …"), and Phone / FaceTime chips that filter to calls only.
3. Call yourself from another phone (or FaceTime a friend), wait 5 minutes, reload. **Expected**: the new call on top.
4. Look at the avatar at the top of any person page. **Expected**: a round avatar centered in the ring, no square corners.

**Edge cases**: a call from a number that later becomes a contact shows up on that person once the next calls run
links it; a group FaceTime shows on each known participant; a missed call never changes tie strength; a call
from a hidden person never appears on anyone's page.
**Platforms**: collector (Swift) + server + web. Not deployed.

## 2026-10-21 — Attendee clues on hover; clues weighed against the owner's other plans

Hovering an attendee on an event page (or tapping **Clues**) shows why yeackbot listed them: each clue in plain words,
its strength, and the message behind it with when it was sent relative to the event, plus the AI review's score. The
deduction now weighs every time-based clue ("thanks for coming", "omw", photos, "tonight?") against the owner's other
plans that day: a thank-you right after a friend's own show ("Spotlight for <friend>") no longer puts that friend at a
wine tasting two nights earlier. Recurring listings (weekly entries on the "Recurring Events" calendar) need a message
about that listing; venue addresses, day names and everyday words no longer count as "talked about it"; the AI review
can lift a message-only candidate one tier at most; its rows for people who lost all their clues are withdrawn.
`yb eval attendance` grades the clues against Partiful guest lists of past events (held out).

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root.
2. `test/pipeline/occasions/plans.test.ts`: thank-you after the friend's own show → no candidate on the listing and the
   old AI row withdrawn; listing needs a message about it, lands on the nearest week; two plans share a vague
   "great seeing you", a plan naming the person takes it; "last night" and "brunch" pick the right plan; no other
   plans → unchanged; everyday words ("sunset") are no mention. 4 of these fail with the plans switched off.
3. `test/intel/adjudicate.test.ts`: packet has `### other plans` and `listing:`; a 0.45 message-only candidate given
   0.95 by the model is stored as possible at 0.74. `test/routes/events.test.ts`: clues endpoint (text only there,
   excluded chats omitted, hidden person 404). `test/eval/attendance.test.ts`, `test/eval/cli.test.ts`.
4. On a copy of live data: the Oct 1 wine-tasting listing has no attendee; `yb eval attendance` reports
   possible 36 calls (9 confirmed) vs 152 (15) before, attended 5 (3) vs 25 (6).
5. Browser (local copy, desktop + 375px): hover card on an event's inferred rows; tap opens it in the list; no horizontal
   scroll; no console errors.

### Scenario B — Web (owner, after deploy and the next 03:00 occasions run)
1. yeackbot.com → Events → Past → the wine-tasting listing on Thu, Oct 1. **Expected**: the friend whose own show was the
   next night is no longer listed.
2. Open an event with inferred people (e.g. a brunch or dinner). Hover a person's row. **Expected**: a card "Why
   <name> is listed" with each clue, the quoted message, "You · <date> · 2 h before it", and "AI review … % sure".
3. On the iPhone, tap **Clues** on a row. **Expected**: the card opens under the row; tapping the row itself still
   opens the person.
4. Look at a few weekly "Recurring Events" listings (the jazz and comedy nights). **Expected**: few
   or no people, and only people who texted about that listing.
5. Terminal: `npm run yb -- eval attendance`. **Expected**: counts and rates only, no names or message text.

**Edge cases**: a row with no clues has no Clues button; a Partiful-only guest shows "Going on Partiful"; an unsent
message shows "Unsent message"; an excluded conversation's messages never appear; ties and co_attend edges drop for
the withdrawn rows after the effects job runs.
**Platforms**: server + web. Verified locally on a copy of live data; not deployed.
## 2026-10-21 — Tickets from Gmail, "met at" an event, contact screenshots, "Invite to a show"

Four connected pieces (design: `docs/design/tickets-met-at.md`):
- **Ticket ledger.** A read-only Gmail source keeps every concert and event ticket, with bought, sent, sold and
  refunded counts and a status. Tickets you hold become events.
- **Met at.** Someone you newly connected with near an event you went to gets a "Met at <event>" link: an
  Instagram follow or first DM, a new contact card, or a contact screenshot.
- **Contact screenshots.** Screenshots you pick in Google Photos are read on the Mac (the collector, Apple Vision),
  and the people in them are linked.
- **Invite to a show.** For a show you hold tickets to, suggests up to 3 people you met at a similar event.
  Screenshot people come first, and nobody already going is suggested.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii && npm run build` from the repo root: 1876+ tests pass,
   995 files clean, build OK. `collector/run-tests.sh`: 89 Swift tests pass. `xcodebuild -scheme BlackbookServer`
   builds.
2. Migration 026 (written as 025, renumbered after #79 took 025 for calls) on a copy of the production DB: applied in < 1 s, row counts of llm_requests / suggestions /
   occasion_sources unchanged, foreign_key_check empty, quick_check ok.
3. Met-at dry run on that copy, with real contact creation dates loaded:
   - 597 bulk-imported cards excluded;
   - 183 cards skipped as people already known;
   - 12 links to comedy, jazz, lounge and Halloween events, each added the night of or the morning after.
4. Triage over 30 real recent inbox subjects:
   - kept as candidates: orders, transfers, resale sales, mobile-entry reminders, a registration and club RSVP
     reminders;
   - rejected: presales, "tomorrow!" upsells, Spotify, "You're invited to".
5. Two real ticket emails were masked and parsed by Haiku 5.5 (on the DB copy, $0.0006):
   - masking: the owner's name became `<me>`, addresses `<addr>`, long numbers `<num>`;
   - DICE order: 2 tickets, venue, 10 PM local;
   - Ticketmaster resale: 2 sold.

### Scenario B — Owner setup (one time)
1. Google Cloud console (project "My First Project"): enable **Gmail API** and **Google Photos Picker API**.
2. yeackbot.com → Settings → **Email & photos** → **Connect Gmail**. Google shows "Google hasn't verified this app";
   choose Advanced → continue, then allow read-only Gmail. **Expected**: back on Settings with "Gmail connected"; Sources
   shows a **Gmail** card.
3. Same panel → **Connect Google Photos** (same unverified-app screen). **Expected**: "Google Photos connected".
4. Deploy the collector update (Vision OCR + contact creation dates). **Expected**: Sources → Collector ok; after the
   next address-book pass, `created_at_filled` > 0 in the job stats.
5. Optional: Settings → Agent → Features → **Extra ticket senders**: add your club's sender domain
   (`gmail.extra_senders`), so its event registrations count as tickets, not only its "RSVP Reminder" mails.
6. Optional: request an Instagram "Download your information" JSON export (followers and following) and drop the zip
   in `~/Yeackbot Imports`, so Instagram follow dates exist.

### Scenario C — Ticket ledger (after Gmail is connected)
1. Wait one or two `gmail` runs (every 30 min) and one `ticket-parse` + `llm-collect` cycle, then open
   **Events → Tickets**. **Expected**: upcoming and past shows. Each shows a status pill, "You hold N · bought …" and
   a link to its event.
2. A show you bought 4 tickets for and transferred 2: **Expected**: holds 2. Transferred all 4: **Expected**: "Gave
   away", and the event drops off Events unless your own calendar has it.
3. A show you resold (Ticketmaster "your listing just sold" / StubHub "You sold"): **Expected**: "Sold".
4. A presale or "tomorrow!" marketing email: **Expected**: never a ticket.
5. A cancelled show, then a "rescheduled" email: **Expected**: one row, on the new date, holding.
6. Settings → Gmail → **Disconnect** while Calendar is connected. **Expected**: Calendar stays connected; tickets stay
   (unless "delete data" was chosen); nothing more goes to the model until you reconnect.

### Scenario D — Met at
1. Add a new contact on your phone the night of a show you have tickets for (or follow someone on Instagram and
   export DYI). The next morning, after 06:40, open that person. **Expected**: header reads
   "Met at <show> · <date> · via contact added"; the Met at section lists it.
2. Tap **Wrong?** → It's wrong. **Expected**: the line disappears and never comes back (undo in Today brings it back).
3. Add a card for an old friend (someone you've texted before) during a show. **Expected**: no Met at link.
4. Follow the headliner's account at the show. **Expected**: no link (performers are skipped).

### Scenario E — Contact screenshots (Google Photos)
1. Settings → Email & photos → **Pick screenshots**. In the Google tab, search "screenshots" and select a few
   screenshots of Instagram profiles or contact cards, then press Done. **Expected**: the panel shows open →
   downloading → reading → linked N.
2. Open a linked person. **Expected**: a new or existing person with the screenshot's phone, email or handle.
3. A screenshot of a group chat or a flyer with several numbers. **Expected**: counted as ambiguous; nobody is
   created.
4. **Expected** on disk: nothing stays in `~/Library/Application Support/Yeackbot/screenshots/` after reading (at
   most 7 days if the collector is too old).

### Scenario F — Invite to a show
1. Hold tickets to a show 1–21 days out. Someone you screenshotted was met at a similar show (same artist or genre).
   **Expected**: the brief / Today shows "You have tickets to <show> on <day>. Invite <name>? You met <name> at
   <similar show>." Screenshot people are listed first.
2. Transfer them a ticket (or they RSVP on Partiful). **Expected**: they drop out of the next brief; selling your
   tickets drops the whole item.
3. **Wrong** on a one-person item. **Expected**: that Met at link is rejected. On a multi-person item it only cools
   down.

**Edge cases**:
- Gmail grant revoked → the Gmail card reads auth_required, with no retry storm.
- A collector too old for OCR → the Photos panel says "update the collector" and files wait up to 7 days.
- A hidden person is never shown in Met here chips or suggested.
- Sensitive events never appear on /tickets.

**Platforms**:
- Server, web and collector (Swift).
- Not deployed. Not checked in a browser or on the live Gmail / Google Photos APIs.
- Haiku parse quality was checked on 2 real emails only.

---

## 2026-10-21 — Texts read for meaning: local model first (Ollama), social intents

**Why:** "Yb I don't know who Jake M is, deprioritize him" and then "No - DEPRIORITIZE Jake M" both came back
"✓ Noted for Jake M. Prioritized for party invites." The intent schema had one preference (party invites), so the
model forced "deprioritize" into it. Now a local model (Ollama, Meta's `llama3.1:8b` by default) reads free-text commands first,
Claude only when it is unsure or unavailable, and the schema has social intents: invite first, stop inviting,
prioritize, deprioritize, stop suggesting, suggest again, hide, and reminders. Each is journaled; `undo` reverts it.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1467 tests pass.
2. `test/commands/social.test.ts` (deprioritize read locally and never sent to Claude, the "No - DEPRIORITIZE" correction,
   unsure → Claude, model missing → Claude, setting off → Claude only, no key → the unsure local answer stands,
   reminder → commitment + undo, every action's circles/flags), `test/llm/local.test.ts` (Ollama requests and every
   failure as an outcome), `test/intel/invites.test.ts` + `test/pipeline/suggestions/stage.test.ts` (who is left out
   or lowered).
3. Live, synthetic notes only: `eval intent` → 13/13 on Haiku 5.5 ($0.006); `eval intent --engine local` → 11/11 on
   llama3.1:8b (2 screenshot cases skipped: it doesn't read images), twice; `--engine auto` → 13/13 (11 local, 2 on
   Claude, $0.0012); `llm-smoke --live --only IntentSchema` → 42 nodes, accepted.

### Scenario B — Local model (owner, after deploy)
1. `ollama list` shows `llama3.1:8b` (pulled 2026-10-21). `npm run yb -- eval intent --engine local`. **Expected**:
   11/11 `[local]`, the 2 screenshot cases skipped.
2. Settings → Privacy → **On this Mac**: "Read commands on this Mac first" is on, model `llama3.1:8b`.

### Scenario C — iPhone (owner)
1. Text `yb I don't know who Jake M is, deprioritize him` (use a real low-priority contact). **Expected**:
   `✓ Deprioritized Jake M.` (plus "and took them off Party invites" if they were on it). On yeackbot.com → Circles,
   they're in **Deprioritized** and not in **Party invites**.
2. Text `undo`. **Expected**: `✓ Undone: note for Jake M. + deprioritized…`; the circles are as before.
3. Text `yb stop suggesting <name>`. **Expected**: `✓ I'll stop suggesting <name>.`; they're in **Don’t suggest** and
   no brief item names them. `yb you can suggest <name> again` reverses it.
4. Text `yb remind me to call <name> Friday`. **Expected**: `✓ I'll remind you about <name> on Fri …: call.`; Friday's
   brief has "Reminder for <name>: call".
5. Quit Ollama and text `yb prioritize <name>`. **Expected**: still handled (Claude reads it); Today shows the change.

**Edge cases**: a screenshot command goes to Claude (the default model doesn't read images); people excluded from the
AI are never sent to either model; an open "Which Sam?" clarification from before the deploy still applies its party
invite.
**Platforms**: server + web (Settings). Not deployed; evals ran against the real llama3.1:8b, not the iPhone flow.

## The whole brief in one text, nothing left to the app (2026-10-25)

Owner: "This wasn't four things, it was one thing. Always include everything you want me to see each day in the
text, not just the app." The 2026-10-25 brief went out as four texts, so the first one read "4 things for today"
above a single item. The brief is now one text: greeting, every item (blank line between them), the health line,
then the closing and the one link. An event today no longer says "There's a quick brief in the app": up to three of
its people get a line each (when you last talked, the first thing open between you, one recent fact). A name with
emoji in it ("Zed ⚡️") reads as "Zed", not "someone". Sensitive items still say "The details are in the app."

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root.
2. `test/delivery/compose.test.ts` (the exact one-text brief, health line before the closing, `parts` = [null]; a
   one-item brief's text carries its item), `test/delivery/send.test.ts` (one text, every item delivered; a stored
   one-text-per-suggestion brief that never went out is recomposed into one; one that was part-way out finishes as
   stored), `test/intel/events.test.ts` (the event's people lines), `test/delivery/template.test.ts` (emoji names).
3. Dry run on a copy of the live database for 2026-10-25 (template copy, nothing sent): one text, no outbound-rule
   problems, the event item lists three of its people with when you last talked; the reply item names the person
   instead of "someone".

### Scenario B — Preview (web)
1. yeackbot.com → Settings → Digest → **Preview today's text**.
2. **Expected**: one bubble; the caption says "1 text · N items"; every item is numbered inside it; an event item
   has a line per person and no "in the app" line.

### Scenario C — Real brief (owner's phone)
1. Next morning at 08:00 (or Settings → Digest → **Send today's brief to me**), watch the self thread.
2. **Expected**: a single 🅨 text whose count matches the numbered items in it, ending with
   "That's it! Reply "done 2", "skip 2" or "snooze 2" anytime." and yeackbot.com/today.
3. Text "done 2". **Expected**: "✓ Nice, marked <name> done." Reply to the brief text with just "done" while several
   items are open. **Expected**: "Which one? Reply "done 1"."
4. On a day with only one item, long-press the text → Reply → "done". **Expected**: that item is marked done.

**Edge cases**: a stored brief from the one-text-per-suggestion days that is part-way out at deploy time finishes as
stored; a person's line is dropped (not the item) if it would break an outbound rule; an attendee with nothing known
gets no line.
**Platforms**: server + web. Not deployed; the real 08:00 text needs the owner's phone to confirm.

## 2026-10-25 — Promises ranked by stakes ("Bringing tomatoes isn't important")

**Why:** the morning brief's item 3 was "You told <a friend> you'd bring tomatoes". Every promise the owner made scored the
same top base (1.0), whether it was rent, a landlord reference or tomatoes. Now each promise carries stakes: the
extraction labels new ones high / normal / low, and older rows are guessed from their description. Low-stakes
promises never take a brief slot, Today's preview or a "did this happen?" ask. High ones (money, housing, bookings,
intros) outrank normal ones.

### Scenario A — Automated (Claude verified)
1. `npm run typecheck && npx vitest run && npm run lint:pii` from the repo root: 1999 tests pass.
2. `test/pipeline/obligations/stakes.test.ts` (guess rules), `loops.test.ts` (no low candidate or lapsed ask, high 1 /
   normal 0.8, Today's preview without low ones, lists keep them last), `commitments.test.ts` (stored, raised never
   lowered), `test/extraction/validate.test.ts` (label passes through; an answer without `stakes` reads normal; an
   out-of-set value drops the item), `test/llm/outputSchemas.test.ts` (obligations schema 30 grammar nodes).
3. Dry run on a copy of the live database (migration 027 applied): 10 of 116 live promises read low (tomatoes, a broom,
   a costume, an arrival time…), none of them a candidate; money/notice/booking promises lead at 1.0.

### Scenario B — Live schema (Claude verified)
1. `npm run yb -- llm-smoke --live --only ExtractionObligations`. **Expected**: 30 nodes, accepted (2026-10-25: 200,
   end_turn).

### Scenario C — Morning brief (owner, after deploy)
1. Read the next morning brief. **Expected**: no "bring tomatoes" / "get a broom" style item; promises shown are
   things like rent, deposits, notices, bookings or plans with people.
2. On yeackbot.com → a person with a low-stakes promise. **Expected**: the promise is still listed on
   their page; on Today it sits after the other promises and is not in the top preview.
3. After a night of new texts with a small promise ("I'll bring chips"), check that person's page. **Expected**: it
   is recorded but never appears in the brief.

**Edge cases**: a repeat of a promise in more serious words raises it, never the reverse; a money word wins over a
small-task verb ("bring the deposit check" is high); meet-ups and calls are never guessed low.
**Platforms**: server only (no web change). Not deployed; the new prompt has not read real texts yet.
