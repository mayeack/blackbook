<!-- Owner request 2026-10-21. Amends PLAN.md (Gmail becomes a read-only source; Google Photos screenshots via the Picker). -->

# Tickets, "met at" and contact screenshots

> "Continuously scan my email, and keep a record of all concerts and events I have tickets for. Then, compare
> people I connect with on Instagram or add to contacts, and associate that I met them at an event around the same
> time. Also look in my Google Photos; anyone who I've taken a screenshot of their contact info should be
> prioritized for events similar to where I met them." (owner, 2026-10-21)

Four pieces, each usable on its own:

1. **Ticket ledger (Gmail).** A read-only Gmail source finds ticket emails, Haiku 5.5 reads them, and the ledger
   keeps one row per real event with a quantity state machine. Ticketed events feed the occasions build, so the
   Events page, briefs, attendee inference and follow-ups pick them up.
2. **Met at.** People the owner newly connected with (an Instagram follow or first DM, a new contact card, a contact
   screenshot) near an event he attended get a journaled, undoable `person_met_at` link.
3. **Contact screenshots (Google Photos).** The owner picks screenshots in the Google Photos Picker. Yeackbot
   downloads them, OCRs them on the Mac (collector, Apple Vision), pulls phones, emails and Instagram handles out
   locally, and links each one to a person. Nothing from a screenshot goes to an LLM.
4. **`event_invite` suggestions.** For an upcoming event the owner holds tickets to, the brief suggests people he
   met at a *similar* event. Screenshot people come first.

## What the research found (2026-10-21)

- Google Photos cannot be scanned continuously. Since 2025-03-31 the Library API reads only app-created media. The
  sanctioned way to read the owner's own photos is the **Picker API**: the owner opens a Google page, selects
  photos (up to 2,000 per session), and the app may download them for 60 minutes. The Apple Photos library on this
  Mac holds no screenshots: 0 subtype-10 assets, shared albums only.
- Gmail: the restricted `gmail.readonly` scope is needed, because `gmail.metadata` cannot search or read bodies. The
  existing OAuth client is "In production", so the owner sees the unverified-app screen once. About 900
  vendor-domain threads a year, ~75% marketing. Ticketmaster order mail is HTML-only, and reminders often land in
  Promotions, so Gmail category filters can't be used. One thread can hold several orders, so parse per message.
  The owner buys 4–6, transfers to friends and resells, so status is a quantity machine.
- Contact-add times: CNContact has no creation date. AddressBook's `ZCREATIONDATE` (readable by the collector, which
  holds FDA) is real, except for bulk days: 606 cards on 2026-03-03, when this Mac was set up. Yeackbot's own
  `addressbook_cards.first_seen_at` is the 2026-10-16 baseline for 694 cards.
- Instagram: the Beeper API has no chat-creation time. The first message counts only when that chat's history is
  fully read (`source_cursors.meta.complete`). Follow dates exist only in a DYI export (`instagram_follows`, 0 rows
  today), so the owner should request one.
- `identities.first_seen_at` and `people.created_at` are ingest-pass times for most sources. They are **not**
  connection times and must never be used as such.

## 1. Gmail source and ticket ledger

### Access

- The Google OAuth flow gains **products**: `calendar` (unchanged), `gmail` (`gmail.readonly`) and `photos`
  (`photospicker.mediaitems.readonly`). Each product is its own consent, with `include_granted_scopes: false`, and
  its own encrypted refresh token: `google.refresh_token` (unchanged), `gmail.refresh_token` and
  `gphotos.refresh_token`. A Gmail-scoped token dies on a password change; with separate tokens that cannot take
  Calendar down with it.
- `GET /google/connect?product=gmail|photos`; the default stays calendar. The pending state remembers the product.
  The callback requires that product's scope, stores that product's secret and redirects to
  `/settings?google=…`, `?gmail=…` or `?gphotos=…`. All products share one redirect URI, so GCP needs no new
  redirect.
- `guardedFetch` additions, read-only:
  - GET `https://gmail.googleapis.com` `/gmail/v1/users/me/(profile|messages)` and `/gmail/v1/users/me/messages/<id>`;
  - POST/GET/DELETE `https://photospicker.googleapis.com` `/v1/sessions` and `/v1/sessions/<id>`, plus GET
    `/v1/mediaItems`;
  - GET on `https://lh<N>.googleusercontent.com` (Picker base URLs).
  Nothing else: no Gmail modify, send, trash or watch.
- Owner steps, which Claude cannot do: enable the Gmail API and the Photos Picker API in the GCP project, then
  Settings → Email & photos → Connect Gmail / Connect Google Photos (the unverified-app screen once each).

### Sync (`adapters/gmail/`, job `gmail`, every 30 min)

- **List.** `messages.list` with `q = after:<epoch s> {from:<vendor domains>… subject:<ticket words>… filename:pkpass}`.
  Messages already in `gmail_messages` are skipped.
  - Cursor `source_cursors('gmail','list')`: `high_water_at` is the newest internalDate seen; each run re-lists
    from `high_water_at − 2 days`.
  - Backfill: `meta.backfill_before` walks back to `now − gmail.backfill_days` (default 1095), one page budget per
    run.
- **Triage** on the metadata (From, Subject, Date; `format=metadata` costs 20 units), with no LLM:
  - `candidate`: a vendor domain from the allowlist or `gmail.extra_senders` AND a transactional subject; or any
    sender with a registration/ticket subject AND an `.ics`/`.pkpass` part; or a forwarded ticket subject.
  - `marketing`: a vendor domain with a marketing subject (presale, on sale, just announced, wait list:, buy now:,
    you're invited to, how was it, rate, tomorrow!, want to see, …).
  - `ignored`: everything else, and the owner's own sent mail.
- **Fetch** candidates only, `format=full` (60 units). Cap: ≤300 metadata and ≤100 full fetches per run, sequential.
- **Clean.** Use text/plain unless it is a stub (<200 chars) or a template dump (`map[`), else HTML → text: drop
  style, script and head, decode entities, collapse whitespace, ≤3,500 chars from the top.
  - Pull refs out deterministically (vendor event URLs → `vendorEventId`; `Order #/Confirmation #` → `orderRef`;
    JSON-LD EventReservation fields) into `gmail_messages.refs`.
  - Transfer counterparties come from subject/body patterns ("<Name> sent you", "sent to <Name>", "is on its way to
    <Name>", "<Name> accepted your", "<N> tickets to <Full Name> (<email>)", "<First> transferred") into
    `ticket_parties`. Their names are masked as `<person>` in the LLM text. The owner's own names are masked too.
- **LLM.** Route `ticket_parse` (Haiku 5.5, batch, 1 h cache, LlmKind `ticket`, custom-id letter `g`), with an
  egress-pseudonymized packet:
  `FROM DOMAIN / SUBJECT / EMAIL DATE (local, weekday) / OWNER TZ / STRUCTURED DATA (JSON-LD, if any) / TEXT`.
  Schema `TicketEmail` (~16 grammar nodes):
  `{kind, title, performers[], category, genres[], venue, city, start_local, end_local, timezone, quantity}`, where
  - `kind` is one of order, registration, delivery, reminder, transfer_in, transfer_out, transfer_back,
    resale_listed, resale_sold, refund, event_cancelled, event_changed, marketing, not_ticket;
  - `category` is one of concert, club, festival, comedy, theater, sports, party, talk, member_event, other;
  - `start_local` is the venue's wall time `YYYY-MM-DDTHH:MM`, with the year inferred from the email date;
  - `genres` is ≤3 broad tags the model knows for the performers ("house", "indie rock"), may be empty, and is
    marked inferred.
  - EgressBlocked → `blocked` (no retry). Refusal → `failed`. Pool `backfill` while backfilling, else `steady`.
- **Apply** (batch consumer `ticket`): each parsed message joins a `ticket_events` row or creates one.
  - Same event when: the same `vendorEventId`; or the same venue local date AND (title-token Jaccard ≥0.5, or the
    same venue_key with start ±3 h, or a shared performer).
  - Counts are kept per distinct `(kind, orderRef ?? thread_id)` using the max quantity (null → 1 for order and
    registration). `held = bought + received − sent − sold − refunded`.
  - Status: `cancelled` (event_cancelled) > `refunded` (refunded ≥ bought + received > 0) > `sold` (sold > 0 and
    held ≤ 0) > `gave_away` (sent > 0 and held ≤ 0) > `holding`.
  - `event_changed` moves the start. Re-derived from all of the event's parsed messages on every change, so it is
    idempotent.
- **Health.** `recordSourceHealth('gmail', …)`. 403 insufficientPermissions → `auth_required` (no backoff).
  invalid_grant → `auth_required`. Logs carry counts only.

### Tables (migration 025)

`gmail_messages` (E), `ticket_events` (D, stable ids, pointer merge), `ticket_parties` (E). See the migration
header for columns. Bodies are never stored.

### Occasions integration (`pipeline/occasions`)

- `CalEvent` gains `source: 'calendar' | 'ticket'`. `loadTicketEvents` turns every live `ticket_events` row with
  status `holding` (any age) into a ticket copy: treatment `attending`, social, not a reservation.
- Clustering: a ticket copy joins a calendar copy when they share a venue_key within ±3 h, or share title tokens
  (≥0.5) on the same local day, or the calendar copy is a fromGmail reservation within ±3 h. Two ticket copies
  never join.
- Primary: the owner's own event, then the ticket copy, then a reservation. `ticket_count` = held, when calendar
  text gives none. Classification `social` 0.9, rule `ticket` (after medical).
- `occasion_sources.source` gains `ticket` (source_ref = ticket_events.id). Orphan retirement covers ticket sources:
  a ticket that was sold, transferred or cancelled retires its ticket-only occasion.

## 2. Met at (`intel/metAt/`, job `met-at`, daily 06:40, after identity-match and occasions)

**Signals**, one per canonical person, each with a time `t`:

| signal | time | trusted when |
|---|---|---|
| `contact_screenshot` | `contact_screenshots.taken_at` | status linked |
| `contact_added` | `addressbook_cards.created_at` (collector ZCREATIONDATE), else `first_seen_at` | the day is not a bulk day: ≥15 cards from that source on one local day; never the first dump |
| `instagram_follow` | `instagram_follows.followed_at` | always |
| `instagram_dm` | first message of a direct IG conversation | Beeper cursor `meta.complete`, or a DYI-matched thread |

**Events**: `attendedEvents()` (social, active, non-sensitive occasions, including ticket occasions, plus Partiful
going events), past only. Window `[start − 2 h, end + 36 h]`; end defaults to start + 4 h (club 6 h, festival 10 h).

**New-acquaintance guard**: the person is "known before" event E if, across all canonical members, any of these
happened before `E.start − 12 h`:
- an interaction (dm/group session, call, meeting, text_log, manual, legacy_text);
- counted attendance at an earlier event;
- a legacy-origin person;
- any trusted signal above.
Known people never get a met-at link for E.

**Choice and confidence**:
- Pick the event whose window holds t: one that contains t first, else the most recent one that ended before t.
- Two candidates within 3 h of each other → confidence × 0.6.
- Base confidence: screenshot 0.85, contact_added 0.8, instagram_follow 0.75, instagram_dm 0.65.
- Gap factor: inside the event 1.0; up to 2 h before it 0.8; after the end ≤12 h 0.9, ≤24 h 0.8, ≤36 h 0.7.
- Ticket or Partiful events × 1.0, other social occasions × 0.85.
- Several signals on one event combine as 1 − Π(1 − c), capped at 0.95. Written when ≥ 0.5.
- At most one active link per person: the earliest event.

**Writes**: `person_met_at` (J, journaled `met_at` batches in a nightly run).
- New → insert. Changed or no longer derived → status `withdrawn` (agent retraction).
- `rejected` is the owner's sticky "Wrong" or an undo; a rejected (person, target) is never re-created.
- A roster-only person with an active link ≥ 0.6 is brought forward to provisional (journaled), so they show up and
  can be suggested. Hidden, merged and self people are skipped.
- Reads go through person_canon and occasionChain.

## 3. Contact screenshots (`adapters/gphotos/`, `screenshots/`)

- **Session.** `POST /gphotos/session` → Picker `sessions.create` → `{sessionId, pickerUri}`. The web opens
  `pickerUri + '/autoclose'` in a new tab; the hint says "Search 'screenshots', select the contact ones".
- **Job `gphotos`** (every 60 s; a cheap no-op when no session is open):
  - poll open sessions (`sessions.get`; respect pollInterval/timeout); once `mediaItemsSet` is true, page
    `mediaItems.list`;
  - for each photo not already in `contact_screenshots` (source `gphotos`, source_ref = the persistent item id):
    download `baseUrl=w1280-h1280` with the bearer token into `<dataDir>/screenshots/<id>.img` (0600), record it as
    `downloaded`, then `sessions.delete`.
- **OCR** (same job, separate step, ≤50 per run): collector `POST /v1/vision/ocr` (Apple Vision `.accurate`,
  on-device) → lines `{text, confidence, x, y, w, h}`. The file is deleted after OCR, or after 7 days whatever
  happens. Collector without the endpoint → health "update the collector"; the files wait.
- **Extract**, deterministic and in Node:
  - phones via libphonenumber `findNumbers` (default region from tz/US);
  - emails;
  - `@handles` and `instagram.com/<handle>`;
  - an IG profile layout (a username line near the top, plus posts/followers/following);
  - name = the tallest name-like line in the top 45% (2–4 words, letters, not UI words).
  - kind: instagram_profile / contact_card / social_profile / message / other.
  - `no_contact` when nothing is found.
- **Resolve**:
  - phone, email or IG handle identity → canonical person (several different people → `ambiguous`; the owner →
    `self`);
  - else a new provisional person through `attachExternalIdentity(source 'screenshot')` with the name.
  - Journaled run kind `import`.
- **The flag is the linked row itself.** A screenshot person is any visible canonical person with a `linked`
  contact_screenshots row. Its `taken_at` is also a met-at signal.

## 4. `event_invite` suggestions (`intel/eventInvites.ts`, `intel/similarity.ts`)

- **Subjects**: occasions with a `ticket` source whose ticket event is `holding`, starting in 1–21 local days, not
  sensitive. One item per event: subjectKey `occ:<id>`, maxShowings 1, no cooldown, actWindow 7 d, at most 3 people.
- **Similarity** `sim(M, U)` over features:
  - category (ticket category; Partiful → party; title regex for others);
  - performers;
  - genres;
  - venue_key;
  - idf title tokens.
  A shared performer gives 1.0. Otherwise `0.35·genreJaccard + 0.25·sameCategory + 0.2·sameVenue + 0.2·titleJaccard`.
- **People** with an active met_at link (≥0.6) to a past event M where `sim(M, U) ≥ 0.35`:
  - tier A: screenshot people, score `0.6 + 0.3·sim + 0.1·conf`;
  - tier B: everyone else with `sim ≥ 0.5` and conf ≥ 0.7, score `0.4 + 0.3·sim + 0.1·conf`.
  - Closeness minimums don't apply: these are new acquaintances.
- **Never** anyone already going:
  - an attendee row on U's chain (any status but declined or rejected);
  - a ticket_parties counterparty of U's ticket event;
  - a calendar invitee;
  - an identity or name match like `guestCheck`;
  - also never self, hidden, muted or resting people.
- **Payload**: ids and numbers only, `{metOccasionIds[], sims[], screenshot[], daysOut}`; evidence `occ:` refs.
  Base 0.75 with a tier-A person, else 0.6.
- **Copy**: "You have tickets to {U} on {day}. Invite {names}? You met {first} at {M}." The template fallback names
  M. The composer's packet includes M's title, so grounding passes.
- **Delivery and feedback**:
  - The delivery stale check drops people who have since joined U, and the whole item if U is no longer `holding`.
  - "Wrong" rejects the met-at links behind the item (journaled).
  - Acted = a 1:1 message to one of them within 7 days.

## Web and API

- `GET /tickets?when=upcoming|past&cursor=&limit=` → TicketList, with a "Met here" chip list. Page `/tickets`,
  linked from Events.
- `GET /people/:id/met` → MetAtList. `POST /people/:id/met/:linkId/wrong` → BatchRef. Shown on the person page as
  "Met at {event} · {date} · via {signal}".
- `GET /gmail/status`, `POST /gmail/disconnect`, `GET /gphotos/status`, `POST /gphotos/session`,
  `GET /gphotos/session/:id`, `POST /gphotos/disconnect`. Settings "Email & photos" panels. Sources cards `gmail`
  and `gphotos`.
- Today: the KIND_LABELS entry "Invite to a show".

## Privacy and cost

- **Never sent to an LLM**: screenshots, OCR text, transfer counterparty names, the owner's names, or raw
  identifiers. The egress scanner stays fail-closed.
- **Stored**: parsed ticket fields and subjects locally. Email bodies are never stored. Downloaded screenshots are
  deleted after OCR.
- **Logs**: counts and error classes only. Fixtures are synthetic: `.example`/`.test` domains, 555-01xx, sender
  addresses assembled at runtime.
- **Cost**: ≈300 candidate emails a year × ~2k tokens ≈ $0.06/year steady; the 3-year backfill ≈ $0.15 (batch, 50%
  off). Screenshots: $0.

## Owner steps

1. GCP console: enable the Gmail API and the Google Photos Picker API in the project.
2. Settings → Email & photos → Connect Gmail, then Connect Google Photos (the unverified-app screen once each).
3. Deploy the collector update (Vision OCR plus contact creation dates), so the Mac keeps the TCC grants.
4. Optional: request an Instagram DYI JSON export (followers and following) into `~/Yeackbot Imports`.
5. Pick contact screenshots now and then: Settings → Email & photos → Pick screenshots.

## Review amendments (2026-10-21, three-lens design review; these override the sections above)

Tags name the owning module: [gmail] ledger, [occ] occasions integration, [met] met-at, [shots] screenshots, [col]
collector + address book, [inv] event_invite, [web] routes + web, [lead] wiring.

**Ledger quantities and dates [gmail]**
- Count by flow class, not by kind:
  - Acquisitions (order, registration) are keyed `orderRef ?? message id`, taking the max within an orderRef.
  - Outflows (transfer_out, resale_sold, refund) count once per message.
  - New kind `transfer_accepted` covers "<Name> accepted your transfer", "you're all set", claim confirmations. It
    is never counted.
  - `transfer_back` subtracts from sent.
  - A resale_sold followed within 14 d by a transfer_out of ≤ the same quantity to someone who is not a known person
    is one outflow.
  - A secondary-market order (StubHub, Vivid, SeatGeek, viagogo) followed within 14 d by a transfer_in of ≤ its
    quantity is one inflow.
  - An order forwarded from a non-vendor sender is a transfer_in of 1.
- A null quantity is unknown:
  - a null refund refunds that whole orderRef;
  - a null transfer_out or resale_sold counts as ≥ 1;
  - when outflows reach inflows and any inflow quantity was null, the status stays `holding` with `held = NULL`.
  - Take quantities from JSON-LD numSeats, a pkpass count or seat lines before trusting the LLM.
- Status order:
  - `cancelled` only when no later-dated event_changed, delivery or reminder exists;
  - then refunded > sold > gave_away;
  - `holding` needs bought + received > 0, or a delivery / pkpass;
  - anything else is `unconfirmed`, which never becomes an occasion.
- Dates (a deterministic post-check after the LLM):
  - prefer JSON-LD startDate;
  - for order, delivery, reminder and transfer kinds, pick the year that puts start in [email date − 1 d, email
    date + 18 mo] and matches a weekday named in the text;
  - a null timezone → the owner's tz, with `ticket_events.tz` left NULL (guessed), so joins use title/performer on
    the local date and never the ±3 h rule.
- `ends_at` = end_local, else start + 6 h (club), 10 h (festival) or 4 h (anything else). Messages joined by
  vendorEventId span [min start, max end]. Separate orders for different days of one festival stay separate rows.
- `partiful.com/e/<id>` links found in the mail go to `ticket_events.partiful_ids`.

**What reaches Anthropic [gmail]** (the scanner enforces identifiers only; names rely on these steps)
- Cut the text at the first forward/reply marker ("---------- Forwarded message", "Begin forwarded message:",
  "On … wrote:"). Drop header-style lines (From:, To:, Cc:, Sent:, Date:).
- Mask labelled name lines (Name, Attendee, Ticket holder, Purchaser, Billing / Bill to / Ship to) and transfer
  counterparties as `<person>`. Mask the owner's names via `identity/ownerNames.ts`.
- JSON-LD: send only reservationFor.name / startDate / endDate / location.name /
  location.address.addressLocality / performer[].name. Never send underName, ticketToken, ticketNumber,
  reservationNumber or any URL.
- Pre-check each item before `submitBatch`: egress scan plus the `llm.excluded_person_ids` tokens. A failing item
  becomes `blocked` or `skipped`; the rest are submitted. One bad item must not fail the batch.
- A test asserts that no synthetic counterparty surname, underName or owner name appears in any packet.

**Jobs [gmail][lead]**
- Source job `gmail` (every 30 min): list, triage, fetch, clean, refs, counterparties → `gmail_messages.clean_text`,
  status `pending`.
- LLM job `ticket-parse` (agent llm group, every 30 min, skips without an API key or budget): submit pending items
  as a batch, register the `ticket` consumer, clear clean_text at a final state.

**Occasions [occ]**
- syncOccasions is keyed by `(e.source, e.id)` everywhere: claims (sourceOf/roleOf), the owner-move delete,
  insert, keep-set cleanup (stale ticket rows included). Ticket ids resolve through `ticket_events.merged_into_id`
  first.
- Orphan retirement: `EXISTS … source IN ('calendar','ticket')`; excluded_src counts calendar rows only.
- Ticket copies load over the same [from, to] window as calendar events, not at any age.
- Each ticket copy attaches to at most ONE calendar cluster (its best match) after the calendar copies cluster; no
  union-find chaining.
- A cluster whose only other sources are fromGmail reservations, matched by a ticket that is no longer holding
  (sold, gave_away, refunded, cancelled), becomes `excluded`.
- `ticket_count` = bought + received − sold − refunded (sent is not subtracted). Resolved ticket_parties people
  feed inference as named `ticket_holder` signals.
- The ticket rule runs before the medical rule when the category is concert, club, festival, comedy, theater,
  sports or party.
- A live ticket source overrides `classified_by='llm'` (never 'user'). The adjudication apply
  (intel/adjudicate.ts) never turns an occasion with a live ticket source non-social.
- The ticket copy's partifulIds come from `ticket_events.partiful_ids`.
- routes/events.ts: list sources come from occasion_sources; detail joins ticket_events; EventSourceView gains
  `'ticket'`.

**Met at [met]**
- Score every candidate event as base × gap × source weight and take the max.
  - Merge candidates first when they overlap in time and share a venue_key, performer or title token: they are one
    happening.
  - Tie → the shortest event that contains t.
  - ×0.6 only when the runner-up scores ≥ 0.9 × the best AND is at a different venue_key.
- Events: Partiful RSVP must be going / approved / checked_in / attended / host. An occasion linked to a 'maybe'
  RSVP weighs × 0.85.
- Signals:
  - instagram_follow counts only direction `following` (or mutual), never follower-only. Use min(followed_at) per
    identity: dyi.ts keeps the earliest follow time instead of overwriting it.
  - A burst of ≥ 10 follows within 30 min is dropped.
  - instagram_dm is trusted only when the thread is DYI-matched, or the chat was born while watched
    (conversations.created_at − first_message_at ≤ 1 d) AND the owner sent ≥ 1 message in its first session.
  - contact_added needs a given or family name on the card. A bulk is ≥ 5 creation times within 2 min, or the first
    dump.
  - Drop any signal whose handle or name matches the event's performers, venue or title tokens, or any ticket
    performer.
  - Drop IG-profile screenshots showing ≥ 5k followers (`found.followers`).
  - kind must be 'person', not service.
- Known before (in addition):
  - an open match_candidates partner (pending, possible_duplicate, held) with history before the cutoff (the
    guestCheck "maybe" rule);
  - a ticket_parties counterparty on an earlier ticket event;
  - co-membership of a group of ≤ 12 members whose member row predates the cutoff;
  - any address-book card with min(created_at, first_seen_at) before the cutoff, trusted or not.
  - Group sessions and attendance in groups or events of > 50 people don't count.
- Writes:
  - Same (person, target) → update in place: active ↔ withdrawn allowed, `rejected` never revived.
  - A target change withdraws the old row and upserts the new one.
  - Targets are the surviving occasion. Rejection matching spans the occasion chain and treats `e:<id>` and
    `o:<occasion whose event_id = id>` as the same happening.
- A person promoted only by met-at (provisional, no interactions or other links) is journaled back to roster_only
  when the link is withdrawn.

**Screenshots [shots][col]**
- Collector body limit is per route: 8 MiB for POST /v1/vision/ocr only, 1 MiB everywhere else (Swift test for
  both).
- Node keeps raw images ≤ 4 MiB (it re-requests `=w960-h960` when over). A 413 is a final `failed`
  (payload_too_large), not a wait.
- Files are named `<contact_screenshots.id>.img`, never the Picker id.
- A download refused by guardedFetch (unknown host or a redirect: guardedFetch now sets `redirect: 'error'`) →
  gphotos health warning, and the session is kept.
- Resolve creates a provisional person only for contact_card / instagram_profile / social_profile with ≤ 1
  distinct phone, ≤ 1 email and ≤ 1 handle. Everything else with identifiers → `ambiguous`.
- Record the IG follower count in `found.followers`.
- Guarantee, narrowed: images and OCR lines never reach an LLM; a linked person's name follows the composer's
  normal rule (token + first name).

**Address book [col]**: every ingest pass sets `created_at = coalesce(created_at, card.created_at)` for every card in
the dump, on both fast paths (one batched UPDATE), outside content_hash. Force one pass after the collector update.

**event_invite [inv]**
- Never anyone already going:
  - reuse `guestCheck` / `alreadyInvited` as they are (all statuses, the maybe set, identity keys, names);
  - if U links a Partiful event, require a fresh guest list or emit nothing;
  - ticket_parties on every ticket_event on U's chain or on the same local date and venue_key, matched by email key,
    full name, or first name alone (firstNameScore ≥ 0.9) when that is all there is. When in doubt, leave them out.
- Skip U when it is a hosted event (`hostedEvents`), since party_invite owns it.
- subjectKey `tkt:<ticket_event survivor id>`.
- Payload `metRefs` carries `o:`/`e:` keys; evidence `occ:` / `event:` refs.
- "Wrong" on an item rejects met-at links only when the item names exactly one person; otherwise the normal cooldown
  applies. Wrong on the person page rejects that link.

**Disconnect [web]**
- A product's disconnect deletes only that product's secret, cursors and health. It calls `revoke` only when no
  other Google product secret remains, because Google revokes the whole project grant.
- Whenever revoke runs (from any route, including /google/disconnect), delete all three secrets and set all three
  health rows to `disabled`.
- `{deleteData?}`:
  - Gmail: delete gmail_messages, ticket_parties and ticket_events. Their ticket occasions retire on the next
    occasions pass.
  - Photos: always delete the files under `screenshots/` and cancel open sessions; with deleteData, also delete
    contact_screenshots.
- `/tickets` is agent-loop style (zod + AGENT_ROUTES), registered before eventsRouter. The web shows a `ticket`
  source badge on events.

**Fixtures**: Gmail bodies (`payload.parts[].body.data`) are built at runtime with base64url. Synthetic Picker baseUrls
are short and low-entropy (`https://lh3.googleusercontent.com/test-1`).

**Open-PR hygiene [all]**
- Leave `SourceConfigKeys` and the existing job lines alone and append. gmail.* settings go in their own block.
- The event_invite template case goes right after party_invite. All event_invite logic stays in
  intel/eventInvites.ts.
- intel/invites.ts is NOT edited: import from it.
