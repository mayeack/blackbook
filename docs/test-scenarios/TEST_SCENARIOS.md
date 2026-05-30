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

## 2026-05-22 — Sync heartbeat for sync-health observability

**Summary:** Added a server-side `POST /heartbeat` endpoint and client-side heartbeat pings sent at the start and end of every `performFullSync()` call (success, failure, or skip). Each heartbeat lands as a JSONL line in `<Application Support>/Blackbook/Logs/<sanitized_email>/heartbeats-YYYY-MM-DD.jsonl` on the macOS host so you can grep the file to verify both iOS and macOS are checking in.

**Setup:**
- Both apps signed in as `michaelyeack@gmail.com`.
- macOS Blackbook running and serving port 8765 (status of `lsof -i :8765` shows `Blackbook (LISTEN)`).
- Cloudflare tunnel `cloudflared-libersecretorum` running.

**Steps:**
1. Launch macOS app → within ~3s `tail -f ~/Library/Containers/com.blackbookdevelopment.app/Data/Library/Application\ Support/Blackbook/Logs/michaelyeack_at_gmail_com/heartbeats-$(date -u +%Y-%m-%d).jsonl` should show two entries: one `"status":"started"` and one `"status":"success"`, both `"platform":"macOS"`, `"device":"Michael's Mac mini"`.
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
- Both apps signed in as `michaelyeack@gmail.com`.
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
7. Tail `~/Library/Application Support/Blackbook/RemoteBackups/michaelyeack_at_gmail_com/Logs/heartbeats-YYYY-MM-DD.jsonl` → expect `"status":"success"` (was `"failed"`).
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
   - **Expected:** within ~1 second of foreground, a `POST /sync/changes` row with `status:200` and `email:michaelyeack@gmail.com`.
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
