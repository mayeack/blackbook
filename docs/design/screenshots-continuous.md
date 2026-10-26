<!-- Feasibility spike 2026-10-21. Follows docs/design/tickets-met-at.md §3 (contact screenshots via the Google Photos Picker). -->

# New contact screenshots without opening the Picker

> Can yeackbot find the owner's NEW contact-info screenshots continuously, without him opening the Google Photos
> Picker each time?

**Recommendation: build (b2), an iPhone Shortcut that drops new screenshots into an iCloud Drive folder the collector
reads.** It is continuous, uses only Apple-sanctioned features, sends only screenshots off the phone, costs nothing,
and plugs into the shipped OCR → extract → resolve pipeline unchanged. Prove the Shortcut on his phone before writing
any code (step 0 below): unattended Shortcut runs are the one weak point.

If the owner already has iCloud Photos turned on for his iPhone, (b1), a collector PhotoKit reader, is the stronger
choice and needs two Mac settings instead of a Shortcut.

Do not build (a), the sandbox browser on photos.google.com. Leave (c), Takeout, out too: it is not continuous, and the
Picker already covers a one-off backfill.

The Picker stays as it is: it is the way to pick older screenshots, and screenshots taken on any other device.

## Why "daily" is enough

The consumers run daily: `met-at` at 06:40 and the brief's `event_invite`, which looks 1–21 days ahead. A screenshot
that arrives within a day of being taken is as useful as one that arrives within a minute.

## The options

| | continuous | owner steps | ToS / account risk | fragility | privacy | cost |
|---|---|---|---|---|---|---|
| (a) sandbox browser on photos.google.com | yes | sign in to Google in the viewer, re-verify now and then | **high**: robots.txt disallows the paths, on his main Google account | **high**: undocumented page and RPCs | his whole Google account sits behind a loopback CDP port | $0 |
| (b1) iCloud Photos + PhotoKit | yes (minutes to hours) | iCloud Photos on, on iPhone and Mac; allow Photos access once | none | low (public API) | the whole library is mirrored to the Mac | iCloud+ tier if the library outgrows 5 GB |
| (b2) iPhone Shortcut → iCloud Drive | yes (on use, daily backstop) | build one Shortcut and its automations (~10 min) | none | medium (unattended runs can stop; a heartbeat catches it) | only screenshots leave the phone | $0 |
| (c) scheduled Google Takeout | no (every 2 months) | start the schedule; fetch each export | none | low | whole-library export | $0 |

### (a) The sandbox browser (`yb-browser`) on photos.google.com

**How it would work.**
1. The owner signs in to Google in the viewer.
2. A job attaches over CDP, as the Partiful adapter does, and opens Library → Documents → Screenshots in a page. That
   view is on the web at `/u/0/documents`.
3. It reads the newest tiles' keys and dates.
4. For each unseen key, it fetches the image from inside the page, so the cookies never leave the browser. Copied
   cookies would stop refreshing wherever Google's Device Bound Session Credentials are enforced.
5. It hands the bytes to the OCR step.

- **Pros**: no phone work; reaches every screenshot already in Google Photos, from any device; $0.
- **Cons**:
  - **ToS.** Google's Terms bar "automated means to access content … in violation of the machine-readable
    instructions on our web pages". photos.google.com's robots.txt disallows `/photo/`, `/search/`, `/collections` and
    `/albums` for every user agent. Staying on `/u/0/documents` slips past those prefixes by the letter only.
    Google closed the Library API to exactly this use on 2025-03-31, and there is no sanctioned web API.
  - **Account risk lands on his primary Google account** (Gmail, Calendar, Drive, Photos, every "Sign in with
    Google"). Google's sign-in help says it may block sign-ins from browsers "controlled through software
    automation". A lock or forced re-verification would also stop the Gmail ticket source and Calendar.
  - **Security.** Today the sandbox holds a Partiful session. A Google session there would let anything on this Mac
    that can reach 127.0.0.1:4331 act as him on every Google service. The compose file already names this residual
    risk, and a Google session would make it the largest one in the system. A cookie-name check in this spike was
    refused as credential exploration, a fair preview of how this route would be treated.
  - **Fragility.** The page's DOM is obfuscated and its `batchexecute` RPC ids are undocumented. Open-source scrapers
    of the web UI (gphotos-cdp, rclone's gphotosdl) say they need constant updating and report stalls and logouts.
    The Screenshots auto-album is ML-sorted, so it lags and misses some.
  - **Rate.** A few page loads a day is light. The risk is automation being detected, not volume.
- **Verdict: do not build.** It works until Google notices, and the failure lands on his main account.

**Not tested live.** The owner has not signed in to Google in the sandbox: its only tab is a new-tab page. Loading his
photo grid would put real photos on screen, which this spike may not do without his OK.

### (b1) iCloud Photos sync + a collector PhotoKit reader

**What it takes:**
- iCloud Photos on, on the iPhone and on this Mac (Photos → Settings → iCloud → iCloud Photos, with "Optimize Mac
  Storage"). Open Photos once so the background sync starts.
- The collector (BlackbookServer.app: a signed .app LaunchAgent, unsandboxed, hardened runtime) gains the
  `com.apple.security.personal-information.photos-library` entitlement and an `NSPhotoLibraryUsageDescription`.
- The owner allows Photos access once. A bare launchd binary would be denied silently, so this has to be the
  collector.

- **Pros**:
  - background sync with no phone-side automation;
  - `PHAssetMediaSubtype.photoScreenshot` (macOS 10.11+) marks screenshots exactly;
  - `fetchPersistentChanges(since:)` (macOS 13+) makes it incremental;
  - `isNetworkAccessAllowed` fetches a full-size image that "Optimize Mac Storage" left in iCloud;
  - it also sees the older screenshots already in iCloud Photos.
- **Cons**:
  - The Mac's library holds shared albums only today, so iCloud Photos is off on this Mac at least. If it is off on
    the iPhone too, turning it on uploads his whole library to iCloud. Above 5 GB that needs iCloud+ (50 GB $0.99,
    200 GB $2.99, 2 TB $9.99 a month), and it duplicates Google Photos. Sync pauses at quota.
  - The collector gets read access to every photo, and the always-on Mac holds thumbnails of the whole library.
  - Sync latency is unpublished. It pauses in Low Power and Low Data modes and on a poor network.
- **Verdict: best if iCloud Photos is already on for his iPhone.** Then the owner steps are one Mac toggle and one
  Allow. Otherwise (b2) gets the same result without the cost and the full-library mirror.

### (b2) An iPhone Shortcut that drops screenshots into iCloud Drive

**What it takes:** one Shortcut and its automations on the iPhone. iCloud Drive is already on on this Mac, and the
Shortcuts iCloud container (`~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/`) exists.

- **Pros**:
  - no new account, endpoint or cost;
  - only resized screenshots leave the phone, into his own iCloud Drive;
  - the Mac side needs no new TCC grant, because the collector holds Full Disk Access;
  - Apple-sanctioned end to end.
- **Cons**:
  - The owner builds the Shortcut by hand (steps below).
  - Unattended runs are the weak point. Forum reports describe time-of-day automations that don't fire, or can't
    read files, on a locked phone. So the main triggers fire while the phone is in use (see below), and a heartbeat
    file turns a silent stop into a source-health error.
  - Shortcuts' own "Extract Text from Image" returns text without positions, which the name heuristic needs. So the
    phone sends the image and the Mac does the OCR, as now.
  - Deleted inbox files sit in iCloud Drive's Recently Deleted for 30 days.
  - Screenshots taken on another device are not covered; the Picker still is.
- **Verdict: build this**, after step 0 proves it on his phone, unless (b1) is free for him.

### (c) Scheduled Google Takeout

- **Pros**: official and complete; JSON sidecars carry `photoTakenTime`.
- **Cons**:
  - Up to two months of latency defeats "met at".
  - Six exports a year, and each one is a full copy: there is no date range.
  - Each export's links expire in about 7 days and may ask him to sign in again.
  - Automatic fetching would need a Drive scope this app doesn't have. The Data Portability API has no Photos scope.
- **Verdict: do not build.** For a one-off backfill, the Picker already takes up to 2,000 picks per session.

## Owner steps for (b2)

**First, one question.** Is iCloud Photos on for your iPhone (Settings → your name → iCloud → Photos → "Sync this
iPhone")? If yes, choose (b1) instead.

**Shortcut "Yeackbot screenshots".** The heartbeat file doubles as the cursor, so each run sends only what is new:

1. **Current Date** → Set Variable `Started`.
2. **Get File** `Shortcuts/Yeackbot Inbox/heartbeat.txt` (Error If Not Found off) → **Get Dates from Input** →
   Set Variable `Since`. **If** `Since` has no value: **Adjust Date** (Current Date, subtract 3 days) → Set Variable
   `Since`.
3. **Find Photos** where *Is a Screenshot* is true and *Date Taken* is after `Since`; sort by Date Taken, oldest
   first; limit 200.
4. **Repeat with Each** item:
   1. **Format Date** (*Date Taken* of Repeat Item), custom format `yyyyMMdd'T'HHmmssxx`.
   2. **Resize Image** (Repeat Item) by longest edge to 1280.
   3. **Convert Image** to JPEG, quality 0.85, metadata off.
   4. **Set Name** to `<Formatted Date>_<Name of Repeat Item>.jpg`.
   5. **Save File** to `Shortcuts/Yeackbot Inbox/` (Ask Where to Save off, Overwrite If File Exists on).
5. **Format Date** `Started` as ISO 8601 → **Save File** to `Shortcuts/Yeackbot Inbox/heartbeat.txt` (overwrite on).

**Automations.** Set each one to Run Immediately, with Notify When Run off:
- **Screenshot** (iOS 27+): fires right after a screenshot is taken, while the phone is unlocked. Use it only if
  Shortcuts offers Run Immediately for it. Apple's list of automations that can run without asking doesn't include
  it yet.
- **App → Is Closed** → Instagram, Messages, Contacts: where contact screenshots get taken; the phone is in use.
- **Time of Day**, daily at 21:00: the backstop. In the Shortcut's details, turn on Privacy → Allow Running When
  Locked.

Run the Shortcut once by hand first, so iOS asks for Photos access.

**Step 0: prove it before any code.** Take a test screenshot, open Instagram and close it. Within a few minutes, a
`.jpg` and `heartbeat.txt` should appear on the Mac in Finder → iCloud Drive → Shortcuts → Yeackbot Inbox. Check the
heartbeat again the next morning, to see whether the backstop ran overnight.

**Then:** deploy the collector update (it carries the inbox routes), and turn on Settings → Email & photos → iPhone
screenshots.

## Implementation sketch (b2), plugging into `contact_screenshots`

Everything after "a row is `downloaded` and its file is in `<dataDir>/screenshots/`" is already source-agnostic.
`screenshots/process.ts` reads any `downloaded` row, and the gphotos job's 7-day expiry and stray-file cleanup cover
every row. So a new source only has to land files and rows.

**Migration 027** (`027_screenshot_inbox.ts`):
- `widenTableCheck(db, 'contact_screenshots', 'source', ['shortcut'])`, using 023's helper. Add `'photokit'` too if
  (b1) is ever built.
- `source_ref` is the inbox file name: the taken time with its UTC offset, plus the iPhone's `IMG_nnnn`.
- `session_id` stays NULL.

**Collector** (Swift, `collector/Inbox/`):
- It reads with Full Disk Access through NSFileCoordinator.
- File names must match `^\d{8}T\d{6}[+-]\d{4}_[A-Za-z0-9_-]{1,40}\.jpe?g$`; anything else is ignored and never read.
- `GET /v1/inbox/screenshots` → `{heartbeatAt, files: [{name, bytes, local}]}`. `local: false` is an iCloud
  placeholder; the collector starts its download (`startDownloadingUbiquitousItem`).
- `GET /v1/inbox/screenshots/<name>` → the image bytes (≤ 8 MiB, else 413).
- `DELETE /v1/inbox/screenshots/<name>`.
- Logs carry counts only.

**Node** (`adapters/screenshotInbox/`, job `screenshot-inbox`, every 15 min; a no-op when the setting is off):

1. **List.** A heartbeat older than 3 days → `source_health('screenshot_inbox')` error "The iPhone Shortcut hasn't run
   since {date}". No heartbeat ever → `disabled`.
2. **Land.** For each local file with no `contact_screenshots` row (`source 'shortcut'`, `source_ref` = name), ≤ 200
   a pass:
   - Parse `taken_at` from the name; it carries its UTC offset.
   - The Picker may already have brought the same screenshot. If a `gphotos` row has a `taken_at` within ±2 s, skip it
     (no row) and delete the inbox file.
   - Otherwise GET the bytes. Then `writeScreenshot(dataDir, id, bytes)` and insert the row as `downloaded`, in one
     synchronous step (as the gphotos download does). Then DELETE the inbox file.
   - A file over 4 MiB → `failed`, `payload_too_large`.
3. **OCR** moves out of the gphotos job (its step 3) into its own job `screenshots-ocr`: every 60 s, a no-op when
   nothing is `downloaded`. Then two jobs never OCR the same rows.

**Fix the Photos disconnect first.** `disconnectGphotos` (adapters/gphotos/jobs.ts) prunes every screenshot file, and
deletes or expires every `contact_screenshots` row. With a second source, it must touch only `source = 'gphotos'` rows
and their files.

**Web.** Settings → Email & photos gains an "iPhone screenshots" panel: on/off, the last heartbeat, counts, and the
setup steps above. Sources gains a `screenshot_inbox` card. Turning it off deletes the waiting inbox files.

**Unchanged:** extract, resolve, met-at and `event_invite`. A `linked` row from any source makes a screenshot person,
and its `taken_at` is a met-at signal. Nothing from a screenshot reaches an LLM.

**Tests:**
- a fake collector serving synthetic names and a generated PNG;
- migration 027 on a 026 database;
- the Picker-duplicate skip;
- the heartbeat health states;
- the scoped disconnect.

**Effort:** about a day (Node ≈ 300 lines + tests, Swift ≈ 150 + tests, the migration, the web panel), plus a
collector redeploy.

### If (b1) instead

It is the same Node job, with `source 'photokit'` and `source_ref` = the PhotoKit cloud identifier. The collector:
- lists `.photoScreenshot` assets changed since a persistent change token (`GET /v1/photos/screenshots?after=<token>`);
- renders each one at about 1280 px (`GET /v1/photos/screenshots/image?id=…`, `PHImageManager` with
  `deliveryMode = .highQualityFormat` and network access allowed).

Owner steps: iCloud Photos on for the Mac, then allow the collector's Photos prompt. Test the sync latency once.

## Findings (2026-10-21, public pages only, nothing signed in)

- **photos.google.com/robots.txt** (`User-agent: *`) disallows, among others: `/photo/`, `/search/`, `/collections`,
  `/albums`, `/album/`, `/shared`, `/things`, `/people`. `/` and `/documents` are not listed.
- **Google Terms** ("Don't abuse our services"): no automated access that violates a page's machine-readable
  instructions, e.g. robots.txt. The Photos service-specific terms add no scraping clause. Sign-in help: Google may
  block sign-ins from browsers controlled through software automation.
- **Web Documents view**: Library → Documents (`/u/0/documents`, 2024). Its auto-albums include Screenshots. They are
  ML-sorted.
- **DBSC**: binds Google session cookies to a device key. It is on by default in Chrome for Windows (GA in 146), and
  rolling out on macOS (147). Linux isn't announced. Cookies copied out of the browser stop refreshing where it is
  enforced.
- **Web scrapers today**: gphotos-sync was archived in 2024. rclone's googlephotos backend only reaches media it
  uploaded itself. gphotosdl and gphotos-cdp drive Chrome and report stalls, logouts and constant upkeep.
- **PhotoKit**: `.photoScreenshot` macOS 10.11+; `PHPersistentChangeToken` / `fetchPersistentChanges` macOS 13+;
  `isNetworkAccessAllowed` macOS 10.13+. It needs the Photos TCC grant held by an app bundle.
- **Shortcuts**:
  - Find Photos has an *Is a Screenshot* filter.
  - iOS 27 added a Screenshot trigger, but Apple's run-without-asking list doesn't name it yet. iOS 26 and earlier
    have no screenshot or new-photo trigger.
  - Extract Text from Image returns text only, without positions.
  - Save File can write into a fixed path under iCloud Drive → Shortcuts without asking.
- **Takeout**: every 2 months for a year (6 exports), each a full copy; links expire in ~7 days. Delivery by email
  link, Drive, Dropbox, OneDrive or Box. The Data Portability API has no Photos scope.
