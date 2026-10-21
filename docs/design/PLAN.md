<!-- Approved plan, 2026-10-14. Source of truth over the other design docs. -->

# Yeackbot: Blackbook rebuilt as an agentic web app at yeackbot.com

## Context

Blackbook today is three pieces:
- a SwiftUI iOS/macOS CRM;
- the `BlackbookServer` menu-bar sync server;
- an iMessage poller.

It needs a lot of manual upkeep, and research turned up serious defects:
- **The iMessage reader drops ~99% of recent messages.** It reads only `message.text`; macOS now keeps the body in `attributedBody`.
- **It ignores group chats.** It never reads `chat` or `chat_handle_join`, and it drops Michael's own group sends.
- **It logs tapbacks as interactions.**
- **"Fading" is recency-only**: anyone not contacted in about 24 days counts as fading.
- **The relationship table is empty**: 0 `ContactRelationship` rows.
- **The legacy sync server has to be locked down first** (Phase 0: loopback-only, no LAN advertisement, tunnel retired).

Michael wants an agentic rebuild that does the work for him:
- **Web app** at **yeackbot.com**.
- **Daily ingestion** of iMessage, WhatsApp, Instagram, Partiful and Google Calendar. From these it automatically creates and dedupes contacts, attaches accounts to one master person, logs interactions and interests, and infers person↔person relationships: group-chat co-membership, event co-attendance, and who was at which calendar event.
- **Daily iMessage brief** of suggestions. These include fading relationships, plus the agentic extras listed below.
- **Self-learning**: suggest more of what he acts on and less of what he ignores, with occasional random "wildcard" suggestions.

## Decisions (made with Michael, 2026-10-13/14)

| Topic | Decision |
|---|---|
| Native apps | **Replace with web.** PWA on the iPhone. Migrate the SwiftData data once, then retire the iOS/macOS apps, the sync layer and TestFlight. |
| Hosting | **Mac mini + Cloudflare Tunnel.** Node + better-sqlite3, local-first. Single user behind **Cloudflare Access** (Google SSO, <owner-email>). |
| Autonomy | **Fully automatic.** Every agent write is journaled and undoable (per change and per run). An activity feed shows what the agent did. |
| iMessage | chat.db, through a signed collector app (decodes `attributedBody`, reads group chats). |
| WhatsApp | Official **WhatsApp for Mac**. Read snapshot copies of its local SQLite. No Beeper; no ban risk. |
| Instagram | **Beeper Desktop** (on-device Instagram only, read-only) local API, plus a one-time **"Download your information" export** for history. |
| Partiful | **Unofficial API**: daily, read-only, with a stored refresh token. Plus **Partiful texts parsed from chat.db**. |
| Google Calendar | **Google Calendar API** (OAuth, read-only, incremental sync). Infers attendees and cross-references with messages. |
| Gmail (added 2026-10-21) | **Gmail API, read-only** (`gmail.readonly`, its own consent and token): a ticket ledger of every concert and event he holds tickets to, which feeds occasions. Design: `docs/design/tickets-met-at.md`. |
| Google Photos (added 2026-10-21) | **Google Photos Picker** (owner-initiated; Google offers no continuous library read since 2025-03-31). Screenshots of contact info are OCR'd on the Mac by the collector (Apple Vision) and never reach an LLM; those people rank first for shows like the one where he met them. |
| Digest sender | **His own Apple ID → himself** (silent note-to-self thread, accepted), plus a **Web Push ping** from the installed PWA. |
| LLM | **Claude Haiku 5.5** on every route (owner, 2026-10-16: cheapest model first, maximize caching). Effort `low`, nightly work in Message Batches (50% off), byte-stable prompts cached. A route moves to Sonnet 5.5 only if the eval says Haiku isn't good enough; Opus is not selectable. Identifiers are pseudonymized before anything leaves the Mac. |
| UI | **Agent-first core**: Today, People/Person, Ask, Network, Circles/Tags/Locations, Events, Sources, Settings. |
| Features | Core (contacts, dedup, accounts, interactions, interests, relationships, cadence-aware fading); **reply debt & commitments**; **two-way texting**; **event & travel intel**; **ask your network**; **auto circles + intros**; **conversation starters**; **push ping**; **self-learning + wildcards**. Not built: life-event and birthday detection. |
| Old server | **Close `sync.libersecretorum.com` on Day 0.** Native apps stop syncing; the data stays intact. |
| Reboots | **Keep FileVault**, plus `pmset autorestart 1`, manual macOS updates, `fdesetup authrestart` for planned restarts, and an external uptime monitor. |

## Architecture

```
Cloudflare Access (Google SSO) → cloudflared (LaunchAgent com.cloudflare.yeackbot) → 127.0.0.1:4320
┌─ Node server (LaunchAgent com.yeackbot.server) ── Express 5 API + PWA, scheduler, pipeline, adapters, LLM, journal ─┐
│  SINGLE WRITER → ~/Library/Application Support/Yeackbot/yeackbot.db (WAL)  · admin CLI over unix socket admin.sock │
└──┬─────────────────────────────┬───────────────────────┬──────────────────────────────────────────────────────────┘
   │ Bearer, 127.0.0.1:4321      │ Bearer, :23373 (GET)  │ HTTPS out: api.anthropic.com, api.partiful.com,
┌──▼─────────────────────────┐ ┌─▼──────────────────┐    securetoken.googleapis.com, www.googleapis.com (Calendar),
│ Collector = BlackbookServer│ │ Beeper Desktop     │    gmail.googleapis.com (read-only), photospicker.googleapis.com +
│ .app evolved in place      │ │ (Instagram only)   │    lh*.googleusercontent.com (Picker), web push services
│ owns ALL TCC: FDA, Contacts│ └────────────────────┘
│ Automation→Messages        │──▶ chat.db · WhatsApp group container · CNContactStore · Messages.app send
│ + Vision OCR (on-device)   │    · AddressBook store (card creation dates, read-only)
└────────────────────────────┘    Login Items (GUI session): collector, Messages, WhatsApp, Beeper
```

**Why a Swift collector holds the permissions.** TCC grants are keyed to the app's signature. A Homebrew `node` started by launchd:
- never receives an FDA or Automation grant (sends fail with -1743);
- loses grants on every `brew upgrade`.

**Why evolve `BlackbookServer` rather than make a new app.** The installed app's signing requirement pins bundle id `com.blackbookdevelopment.server` and the leaf CN "Apple Development: <owner> (<cert-id>)", which already holds FDA. No Developer ID certificate is needed. `scripts/collector.sh` checks `codesign -d -r-` before and after every install.

**Ports**: 4320 (Node) and 4321 (collector), both loopback only. 8765 goes loopback-only in Phase 0 and is deleted at retirement.

**Repo**: built in this repo. npm workspaces at the root, copying the "Financial Independence" pattern:
- `packages/shared` (`@yb/shared`): zod DTOs, the collector contract, phone/email/name normalizers.
- `packages/server` (`@yb/server`): Express 5, helmet, express-rate-limit, zod 4, better-sqlite3, esbuild bundle.
- `packages/web` (`@yb/web`): React 19, Vite, react-router, TanStack Query, sigma.js + graphology, vite-plugin-pwa.
- `collector/`: Swift sources added to the BlackbookServer xcodegen target, plus SPM `openclaw/imsg` 0.16.0 (`IMsgCore`).
- `deploy/` (plists), `scripts/` (`service.sh`, `collector.sh`), `docs/`.
- Production runs from a **stable checkout** (`~/Blackbook` on `main`), never from `.claude/worktrees/...`.

### Detailed design specs to carry into the repo

The design panel produced full specs. Copy them into `docs/design/` as the first implementation step:
- `/Users/mayeack/.claude/projects/-Users-mayeack-Blackbook--claude-worktrees-agentic-social-tracker-6d54cc/0c4b9bad-27fd-4459-9993-beffce23460d/subagents/workflows/wf_bbf94226-ea3/journal.jsonl` contains:
  - `architecture`: full DDL, collector API, undo engine, migration mapping, testing;
  - `intelligence`: matcher weights, tie formulas, extraction schema, ranker, two-way grammar, Ask tools, evals;
  - `delivery`: phases, screens, digest format, risk register;
  - `critique`.
- `.../wf_dd9c7150-d57/journal.jsonl` contains the research reports (iMessage, WhatsApp, Instagram, Partiful, Beeper, agentic features).

**Where this plan and those specs disagree, this plan wins.** The critic's resolutions are applied below.

## Data model (summary)

**Conventions**
- STRICT tables. UUIDv7 text ids; legacy `ZID`s are kept.
- Unix-ms timestamps. `messages.id` is an INTEGER so citations stay short (`m:8812`).

**Three table classes**
- **Episodes** (append-only, idempotent on a natural key, never journaled): `messages`, `message_reactions`, `conversations`, `conversation_members`, `membership_events`, source event rows.
- **Derived** (rebuilt): `sessions`, derived `interactions`, `person_stats`, `edge_evidence`, `trips`, `person_canon`.
- **Journaled** (every write goes through `change_batches` + `change_log` with before/after): `people`, `identities`, `merges`, `facts`, `edge_labels`, `commitments`, `reply_debts`, `circles`, `tags`, `locations`, `notes`, `settings`, attendee inferences.

**Merge model: pointers, not rewrites**
- A merge sets `merged_into_id` and rebuilds `person_canon`. Child rows never move; every read joins through canon.
- Undo clears the pointer and writes `do_not_merge`, which is a hard constraint.
- Weak identities (IG, Partiful, DYI names) start on a `provisional` person. Linking them to a real person is therefore a merge, using the same undo path.
- Tombstone, never delete. Undo writes blocks (`identity_blocks`, `fact_blocks`, sticky `rejected` edges, `circle_members.excluded`) so re-ingestion can't redo a decision.

**Critic fixes applied to the architecture DDL**
- Open-ended `edges` types, split into `edge_evidence` (derived) and `edge_labels` (journaled).
- `facts.type` gains `location_current`, `location_next`, `travel_plan`, `hometown`, `role`, `school`, `food_drink` and `activity_pref`. `facts` also gains `status` candidate/tentative/confirmed, `support`, `prompt_version` and `retracted_at`.
- `people.kind` gains `me`; `people.status` gains `roster_only` and `service`. `identities` gains `shared` and `status`.
- Suggestion kinds: + `cooling`, `dormant`, `circle_neglect`, `travel_overlap`, `wildcard`, `memory`. `commitments` gains `due_start`, `due_end` and `lapsed`.
- New tables:
  - pipeline: `windows`, `alias_obs`, `match_candidates`, `pending_mention_facts`;
  - self-learning: `learner_arms`, `suggestion_outcomes`;
  - calendar: `calendar_events` (raw), `occasions`, `occasion_sources`.
  - `event_attendees` gains `source`, `confidence` and evidence.
- No NULLs inside UNIQUE keys. Use computed `dedupe_key` columns or partial unique indexes.
- FTS5 external-content tables only over INTEGER-rowid tables. `facts` and `notes` get integer surrogates, and FTS is rebuilt after any restore.
- `custom_id` = `{kind}{ver}-{window}-{attempt}`.

## Ingestion (per source)

### iMessage (collector `GET /v1/imessage/messages?after_rowid`)
- **Connection**: persistent, read-only, **not** `immutable` (so WAL writes are visible).
- **Query**: LEFT JOIN `handle`, `chat_message_join` and `chat`.
- **Decoding** via IMsgCore: `attributedBody`, reactions folded as `message_reactions`, link-preview merge.
- **Filtering**: drop `is_spam`, chatbot and URL-balloon duplicates. Membership events come from `item_type`/`group_action_type`.
- **Overlap**: a 10 s tail plus a 48 h re-read and a `date_edited` re-scan nightly.
- **Partiful texts** (`urn:biz:29896aa3…`, short code 39781, login code +18449460698) go to a parser for invite/RSVP/reminder/blast templates, yielding an event id, title, inviter and RSVP.
- **Phones**: E.164 via libphonenumber-js, only in Node. Never last-10-digits.

### Address book (collector `GET /v1/contacts`, CNContactStore)
- Social profiles read from `value.service`. This fixes the label bug in `ContactSyncService.swift:391-399`.
- The address book is the highest-precedence name source.
- Name locks apply only to user edits made in yeackbot.

### WhatsApp (collector `POST /v1/whatsapp/snapshot`, every 30 min, skipped if mtime is unchanged)
- Copy `ChatStorage`, `ContactsV2` and `LID` `.sqlite` plus `-wal`. **Never `-shm`.** Run `wal_checkpoint(TRUNCATE)` and `quick_check` on the copy.
- Node parses by `Z_PK` watermark. If `MAX(Z_PK)` drops, do a full re-upsert.
- LID→phone via `LID.ZWAZACCOUNT`.
- Group rosters come from `ZWAGROUPMEMBER`, deduped after mapping.
- `NULLIF` the empty name columns. Pushnames come from `ZWAPROFILEPUSHNAME`.
- Run a schema guard (expected columns) on every snapshot.

### Instagram
**Beeper adapter**:
- GET-only wrapper with a path allowlist, plus an undici interceptor that rejects non-GET requests to `:23373`.
- Filter `accountIDs` to Instagram. Per-chat cursors, polled every 30 min.
- Participants supply IG id, username and fullName.

**DYI importer**:
- Reads from the `~/Yeackbot Imports` folder. Fixes mojibake (`latin1→utf8`).
- Matches threads to Beeper threads on ≥3 messages (±2 s, same text hash).
- Imports followers/following dates.

### Partiful (daily 02:00)
**Auth**: Firebase refresh token (plus uid and the public web API key, captured once from partiful.com DevTools). Refresh via `securetoken.googleapis.com` with `Referer: https://partiful.com/`.

**Hard-coded read-only function allowlist**:
- `getMyRsvps`, `getMyUpcomingEventsForHomePage`, `getMyPastEventsForHomePage`, `getPublishedEvents`
- `getEventInfo`, `getGuests` (paged; respect `showGuestList`)
- `getUsers` (`socials.instagram`), `getContacts`/`getMutuals` (weekly)

**Tolerance**:
- zod `.passthrough()`.
- Contract alert when a call fails, or when chat.db texts mention an event id the API didn't return.
- First guest-list pass over ~300 past events is trickled across several nights.

### Gmail tickets and Google Photos screenshots (added 2026-10-21)
Full design and review amendments: `docs/design/tickets-met-at.md`.
- **Gmail** (job `gmail`, every 30 min; LLM job `ticket-parse`):
  - a vendor allowlist plus deterministic triage, then a Haiku 5.5 batch over masked, pseudonymized excerpts;
  - the `ticket_events` ledger keeps a quantity state machine (bought, received, sent, sold, refunded) and a
    status;
  - holding tickets become occasions (`occasion_sources.source = 'ticket'`).
- **Met at** (job `met-at`, 06:40): a new Instagram follow or first DM, a new contact card, or a contact screenshot
  close to an event he attended becomes a journaled `person_met_at` link.
- **Contact screenshots** (job `gphotos`):
  - the owner picks screenshots in the Google Photos Picker, and the collector OCRs them on-device
    (`POST /v1/vision/ocr`);
  - phones, emails and @handles are extracted locally and linked to people;
  - nothing from a screenshot reaches an LLM.
- **`event_invite`**: for a show he holds tickets to 1–21 days out, people he met at a similar event. Screenshot
  people come first, and nobody already going is suggested.

### Google Calendar (new)
**Access**
- `googleapis` OAuth web client, scope `calendar.readonly`, offline access. The callback `/api/v1/google/callback` sits behind Access.
- Refresh token encrypted in the `secrets` table.
- Publish the OAuth consent screen as **"In production"**; in "Testing" mode refresh tokens expire after 7 days.

**Sync**: `events.list` per calendar with `syncToken` (on 410 → full resync), `singleEvents=true`, initial window −400 to +60 days, every 30 min.

**Calendars** (configurable in Settings):

| Calendar | Treatment |
|---|---|
| Personal | Attending |
| Partiful (subscribed feed) | Attending; linked to Partiful events |
| Shared community calendars | Candidate only; counts when corroborated by messages or RSVP |
| Recurring Events | Included, then classified |
| US Holidays | Excluded |

**Observed shape of his calendar**:
- Almost all events are self-created with **no attendees**. People appear in the title ("Drinks w/ X", "Dinner w/ <group nickname>") or the notes ("<A> & <B>", "<Name> has my ticket", "4 tickets").
- Partiful copies carry `partiful.com/e/<id>`.
- Gmail-created "Reservation at <venue>" events duplicate his own events.
- Logistics and appointments are mixed in.
- The pipeline below is built for this shape.

## Intelligence pipeline

### Schedule (one table; scheduler tick 10 s, each job runs "if due")

| Job | Cadence |
|---|---|
| `imessage-tail` (ingest + command poll) | 10 s |
| `commands` | After each tail with new self-thread rows |
| `collector-health` | 60 s |
| `beeper`, `whatsapp`, `gcal`, `gmail`, `ticket-parse` | 30 min |
| `gphotos` (Picker sessions + OCR) | 60 s (no-op without an open session or pending file) |
| `met-at` | 06:40 |
| `addressbook` | 60 min |
| `partiful` | 02:00 |
| `backup` | 02:15 (`db.backup()`, paged; not `VACUUM INTO` on the writer) |
| `nightly` | 02:30: overlap re-read → identity resolution → sessionize (2 h DM / 1 h group) → deterministic signals → windows → submit batch |
| `nightly-collect` | Every 5 min until done: validate → apply → occasions/attendees → ties → candidates → rank |
| `compose` | 07:30 |
| `digest-send` | 08:00 (setting). Catch-up until 11:00, then Today only. |
| `circles` | Weekly, Sun 04:00 |
| `partiful-contacts` | Weekly |

### Identity resolution and auto-dedup
Spec: intelligence §1.

**Deterministic keys**
- E.164 phone, email, WA LID→phone, IG numeric id, `partiful_user`, address-book id.
- Partiful `socials.instagram` linked to a unique IG username.
- **Shared-identity detection runs first**: a household landline or couple's email is never used as a merge key.

**Service filter**: ≤6-digit short codes, `urn:biz`, spam, OTP/marketing senders, Partiful senders. Their messages are stored but never become people.

**New people**:
- A `provisional` person is created when Michael sent ≥1 message, or the handle sent ≥2, or it posted in a group with known people.
- Roster-only group members are hidden, with graph weight ×0.25.

**Probabilistic matcher** (Fellegi–Sunter, in bits): name frequency, IG handle ⊇ name, shared groups/events, neighbor Jaccard, self-id, city.
- Co-presence is a −20 hard veto.
- Auto-merge needs **p ≥ 0.98 and ≥2 evidence families**.
- An LLM tie-break is called only when p ≥ 0.85 and ≥2 families are present. It sends name tokens only; **no raw IG usernames leave the Mac**.

**Guards**:
- G1: name-only evidence never merges.
- G2: co-presence vetoes.
- G3: `do_not_merge` is respected transitively.
- G4: two different address-book cards are never probabilistically merged.
- G5: cluster sanity checks.
- G6: at most 25 probabilistic merges per night (one-time backfill allowance is higher, with a "Check these" list).
- G7: a priority or hidden person is never absorbed into someone else.

**Self-identification**: "hey it's Jake from climbing" (regex + LLM) names provisional people. The new-number rule is deferred.

**Legacy migration**:
- The merged-away rows become pointer merges.
- Shared-identity guard runs before migration-time auto-merges.
- One-time audit of name-only legacy merges, shown on Today.

### Relationship graph
Spec: intelligence §2.

**Edge evidence**:

| Edge | Weighting |
|---|---|
| `co_group` | `1/log2(1+n)` × group activity × pairwise posting × recency. Groups >40 members contribute nothing; 25–40 at ×0.5. |
| `co_attend` | Partiful and calendar occasions, weighted by RSVP status and `1/log2(1+going)` |
| `invited_by`, `plus_one`, `co_host` | Partiful roles |
| `mentioned_together` | Both named in one message |
| LLM relation labels | partner, family, roommate, coworker, friend |

**Strength** = `1 − e^{−W/2}`. Tiers: close / know each other / acquainted.

**Display**: Person → Connections tab, a pair page `/people/:a/with/:b`, and the network graph.

### Cadence-aware ties and fading
Spec: intelligence §3; this replaces `RelationshipScoreEngine`.

**Daily touch units** across all sources:

| Signal | Units |
|---|---|
| 1:1 messages, both directions | 1.0 |
| 1:1 messages, one way | 0.6 |
| Small group session together | 0.3 |
| Event or calendar occasion together | 1.5 |
| `log:` entry | 1.5 |

**Per-person stats**: expected gap E (shrunk median), silence S, fading ratio F = S/E_r, historical strength H, 90 vs 365-day momentum, reciprocity, and current tie T.

**States**:
- **Fading**: H≥40, ≥6 contact days, F≥3, S≥21. For priority people: H≥15, F≥2, S≥14.
- **Cooling**: momentum ≤ −1.
- **Dormant**: S>365.
- Cold-start rules apply to new people.

**Until WhatsApp and Instagram ingest are live**, fading is suppressed for anyone with a known WA or IG identity.

### Models, cost and caching (all LLM calls)
**Route table** (`packages/server/src/llm/models.ts`, the only file that names a model id; a test fails on any other). Every call names a route; the client takes model, effort, thinking, max_tokens and cache TTL from it:

| Route | Mode | Thinking | max_tokens | Cache TTL |
|---|---|---|---|---|
| `extract_steady` / `extract_historical` / `extract_consolidate` | batch | off | 4k / 8k / 4k | 1 h |
| `adjudicate` (calendar attendees) | batch | off | 2k | 1 h |
| `tiebreak`, `circle_name`, `draft_openers` | sync | off | 0.6k–1k | 5 min |
| `intent`, `digest_compose` (sporadic / once a day) | sync | off | 1k / 3k | none (no marker) |
| `ask_web`, `ask_imessage` (tool loop) | sync | adaptive | 4k / 2.5k | 5 min |
| `eval_shadow` | sync | off | 8k | 5 min |

- All default to `claude-haiku-5-5` at effort `low`. `llm.route_overrides` (Settings) may move one route to Sonnet 5.5 or another effort; anything else (Opus included) is rejected.
- Haiku 5.5 rules: thinking `{type:"disabled"}` on structured-output routes (the Ask loop keeps adaptive thinking: with it off the model can skip a needed tool call); no `temperature`/`top_p`/`top_k`, no assistant prefill; **no `fallbacks`** (Haiku has no server-side fallback) — a refusal is recorded and skipped, never escalated.
- **Prices** (per MTok): Haiku $0.10 in / $0.50 out while the prompt is ≤100K tokens, $0.50 / $2.50 above → every prompt is kept ≤100K (client guard; windows that would exceed are split). Size estimates count ASCII at 3 chars/token and every other code point as at least one token (CJK/emoji can't slip through on a character count); the Ask loop also sizes each next request from the previous request's actual usage and replaces tool results that would cross 100K with the budget note; a response whose real prompt still exceeded 100K logs `llm_prompt_over_limit`. Cache reads 0.1×, 5-min writes 1.25×, 1-h writes 2×; Batches 50% off. Cost per request is computed from usage incl. cache reads/writes. Batch pre-flight estimates assume 25% of items miss the cached prefix (in-batch cache hits are best-effort), so budget gates don't under-commit.
- **Caching**: tools → system (byte-stable, no dates/ids, sorted tool list) carry the breakpoint; volatile content goes in the user turn. Batch routes use the 1 h TTL (items of a batch run minutes to hours apart); a sync call on a batch route (on-demand consolidation, a refusal re-run) writes at 5 min; sync routes use 5 min (their calls are back-to-back); `digest_compose` and `intent` send no marker (never re-read within a TTL, so a write would be pure premium). Thinking/effort are constant per route. Ask: tools + system cached plus the moving breakpoint on the last user message, append-only history. Batches are grouped by route so items share the prefix; the shadow replay warms the cache with one request before going parallel. Prefixes under 512 tokens (tie-break, circle naming, drafts) silently don't cache — padding them would cost more than it saves at their volume.
- `cache_read_input_tokens` / `cache_creation_input_tokens` are stored per request; Sources shows spend and the 7-day cache hit rate.

### LLM extraction (nightly Haiku 5.5 batch)
Spec: intelligence §4.

**One egress choke point** (`llm/egress.ts`). Every Claude call goes through it: batch, tie-break, composer, Ask tools, intent parser, circle naming, calendar adjudication.
- **Pseudonymizes**: person tokens `P…`, phones, emails, `@handles`, street addresses, digit runs.
- **Keeps**: first names, cities, companies, chat titles.
- **Fails closed** if a raw E.164 number or email remains.

**Windows**
- Line format `[m:id|ts|P17→ME] text`.
- Each window: NEW messages (steady ≤4k tokens), a 10-message CONTEXT (~500 tokens), a rolling summary of ≤800 characters (~200 tokens), ≤8 people cards, ≤6 mentionables; message lines cut at 700 characters; attachments and links as tokens only. At most 600 new steady windows a run.
- Deterministic triage first drops windows that are all tapbacks, emoji, OTP codes or under 3 words.
- Historical backfill uses conversation-month windows, ADD-only, with one per-person consolidation pass.

**Prompt**
- Byte-stable system prompt of about 5k tokens, cached with a 1 h TTL.
- No timestamps in the prefix.
- The prompt states that message text is untrusted data.

**Output**: `output_config:{effort:"low", format: zodOutputFormat(Extraction)}`, `thinking:{type:"disabled"}`, max_tokens 4k (8k historical), no tools. The schema covers:
- interests and facts with ops ADD/UPDATE/INVALIDATE/NOOP, evidence ids and a verbatim quote;
- commitments, `needs_reply`, person mentions, relation edges, self-identification;
- the conversation summary.
- No life events or birthdays (excluded in the prompt). Sensitive topics are flagged.

**Batch rules**
- **No `fallbacks` in batches** (the Batches API rejects them).
- A `refusal` is final on Haiku 5.5: the window is marked refused (watermark advances) — no re-run, no escalation. Only a route overridden to Sonnet 5.5 (when the item was sent there and the route is still there) re-runs it once synchronously with `fallbacks:"default"`, and only for the categories server-side fallback retries (`cyber`, `frontier_llm`); `bio`, `general_harms`, `reasoning_extraction` and uncategorized declines stay final.
- `max_tokens` cut-offs are re-queued in a batch at ×2, then split.
- Always check `stop_reason`, then read the `text` block **by type** (thinking blocks can come first).

**Validation**
- zod `safeParse`, then the verbatim quote check, then blocks.
- **Interests** auto-apply at conf ≥0.85 with ≥2 supporting messages; other facts per the policy.
- **Sensitive facts** are never shown in iMessage or push.

**Budget**
- Steady state $1/day and $10/month (Haiku makes that ample: ~$0.05/day expected). One-time backfill allowance $20 (expected ~$1–5); `yb backfill-extract --estimate` prints counts and $ without sending anything, and the backfill only submits what the allowance covers.
- When the cap is hit, LLM stages are skipped and the digest falls back to templates.
- `llm_requests.output` is purged after 30 days.

### Calendar attendee inference and cross-referencing (new)

**1. Occasion merge.** Calendar events within ±90 min at the same normalized venue become one occasion; for example "Reservation at X" plus his own "Dinner w/ …".
- A `partiful.com/e/<id>` link, or the Partiful feed UID, joins the occasion to the Partiful event and its guest list.
- Events from shared community calendars become occasions only if corroborated.

**2. Classify** with rules first, then the LLM:
- social: dinner, drinks, concert, party, date;
- logistics/appointment: household services, medical, other service providers;
- work; lodging/travel.

Logistics and work are excluded from relationship inference and digests. Medical is sensitive.

**3. Candidates for each social occasion:**
- explicit attendees (email → identity);
- names parsed from the title or notes ("w/ <Name>", "<A> & <B>", "<Name> has my ticket"; group nicknames matched against circle or group-chat titles);
- Partiful guests who are GOING or MAYBE;
- message cross-reference over [start−14d, end+2d]: messages mentioning venue, title or artist tokens, "tickets", or date phrases that resolve to the event day;
- logistics messages within ±3 h of start ("omw", "here", "where are you");
- next-day "great seeing you" messages or photos;
- group chats that discussed it.

Ticket count ("4 tickets") caps how many unnamed companions are assumed.

**4. Deterministic scoring, then a nightly Haiku batch adjudication** (route `adjudicate`) for occasions with ≥1 candidate.
- Pseudonymized packet in: title, venue, time, notes, and candidates with their evidence ids.
- Out: `attendees[{ref, role: companion|host|guest|ticket_holder|mentioned_only, confidence, evidence_ids}]` plus `is_social` and `kind`.
- **≥0.75**: attendee (counted in ties and edges). **0.5–0.75**: "possible" (shown, not counted).
- Re-run the day after to pick up confirmations.

**5. Effects:**
- in-person interactions (1.5 units);
- `co_attend` edges;
- pre-event briefs, day-after follow-ups, trip detection (multi-day lodging, flights, distant venue);
- auto-closing commitments ("dinner next week" closes when a matching occasion happens).

**Read-only**: never writes to the calendar.

### Suggestions, self-learning and wildcards
**Candidate generators**: `reply_debt`, `pre_event_brief`, `commitment_due`, `event_followup`, `fading`, `travel_overlap`, `cooling`, `intro`, `circle_neglect`, `dormant`.
- Base scores, per-(person, kind) cooldowns and fatigue are in intelligence §5.
- Time-critical items are forced in.
- Default cap 4 (max 5), at most 2 items of one kind.

**Self-learning ranker** (new; `pipeline/learner.ts`), driven by what Michael requested:
- **Arms**: one Beta(α, β) per `kind`, per `kind × tie-tier`, per `kind × circle` (backoff to the kind level when sparse), per **person**, and per wildcard generator.
- Prior Beta(2, 2), with exponential forgetting (half-life 60 days) so tastes can drift.

**Rewards**:
- **Explicit**:
  - `done` = 1;
  - `skip`/dismiss = 0 at weight 1.5;
  - `wrong` = 0 at weight 2;
  - `snooze` = neutral;
  - "never suggest X" = hard mute.
- **Implicit "acted"** = 1: an outbound message, call, occasion or `log:` with that person, started after delivery and within the window:
  - 72 h for reply debt, commitments and pre-event items;
  - 7 days for fading, cooling, dormant, intro, follow-up and travel.
- **Counterfactual guard**: no credit if the conversation was already active in the 24 h before delivery.
- **Partial credit**: a web deep-link open = 0.3.
- **Ignored**: when the window ends with no action, reward 0 at weight 0.5.

**Scoring** = `base × θ_kind × θ_bucket × θ_person` (Thompson samples normalized by 0.5, each clamped to [0.4, 1.8]).
- Propensity floor of 0.05, so no kind dies unless he explicitly mutes it.
- People he ignores repeatedly get exponential cooldowns (7 days × 2^consecutive ignores, cap 90 days). Acting on one resets it.

**Wildcards ("shake things up")**:
- With probability ε = 0.2 per digest (never on 2 consecutive days), add one item marked 🎲.
- The wildcard is drawn uniformly from these generators:
  - a once-close dormant person (H≥50, S>180 days);
  - a suggestion kind not shown in 14 days;
  - an "on this day" memory (an occasion or conversation from a year ago, with the people involved);
  - a mid-score intro pair;
  - a random circle check-in.
- Wildcard feedback trains the wildcard-generator arm, plus the underlying kind at weight 0.5.

**Adaptive cap**: if items past position 3 are acted on <10% of the time over 3 weeks, the cap drops to 3; above 40%, it rises to 5.

**Reproducibility**: the RNG is seeded per digest and the seed is stored.

**Transparency**: Settings → "What I've learned" shows:
- per-kind propensity and trend;
- muted and cooled people;
- the wildcard hit rate;
- Reset buttons.

Each item's "Why this?" includes the learned factors.

**Scope limit**: learning tunes **only the ranker**. Merge thresholds and fact gates change only through `npm run eval` plus a manual change; the fully automatic agent must not drift silently.

### Digest (iMessage to self + push)
**Composer**: one synchronous Haiku call at 07:30 (route `digest_compose`: effort `low`, thinking off; a refusal keeps the templates), writing copy and ≤2 conversation-starter drafts per item.
- **Grounding validator**: citations must be a subset of the packet. Every capitalized token, number and date must appear in the packet or a whitelist.
- Any item that fails validation falls back to a template.
- Openers are drafts only; there is no code path that sends them.

**Format** (revised 2026-10-17, owner feedback: "format texts like a human… one clear suggestion per text"):
- **One text per suggestion**, written like a person texts: line breaks, plain sentences, no "·" separators.
  The first text opens with a greeting ("Good morning! 4 things for today."), the last closes with how to reply and
  the one `yeackbot.com/today` link; a health issue gets its own final text ("Heads up: WhatsApp hasn't synced in
  4 days. Open WhatsApp on your phone to wake it up."). "Last night: …" counts stay on the web.
- Every text starts with the marker **🅨** (U+1F168), checked on raw text.
- Each item: `N. <short action>` (first name + last initial, ≤70 characters), then one or two sentences of context,
  then (LLM copy only) `Maybe: "<opener draft>"`.
- No phone numbers, emails or sensitive facts.
- Texts go out in order, each with its own stable client_ref. Once any text is handed to the sender the brief's
  texts are frozen (never recomposed); it counts as sent from its first delivered text (replies bind to it at once)
  and resumes on the next tick if cut off; a pause, turning the brief off, catch-up passing or the day ending closes
  it with what already went out. A text about someone hidden since is dropped.
  Each outbound row records the item it carries (`digest_ordinal`), so a reply to a suggestion's own text with just
  "done", "skip", "snooze 2w", "why" or "draft" acts on that item. Without a number and not replying to a suggestion,
  those words are free text (a note-to-self like "wrong number lol" is never a command). `more` texts one suggestion.

**When to send**:
- Nothing worth sending → skip, and Today shows "All clear". After 3 empty days, send one heartbeat line.
- A pipeline failure sends a one-line notice.

**Push**: "Your brief is ready · N things", with no names (names are opt-in).

### Two-way texting (self-thread)
**Rows considered**: those in his self chat(s) (handles from `npm run setup:self`), with `ROWID > cursor`, ≤6 h old, and newer than the cursor-init time.

**A row is a bot row**, and ignored, if any of these hold:
- its GUID is in `outbound_guids`;
- it starts with 🅨;
- its text hash matches an in-flight send within 30 s;
- it is a URL balloon or a URL-only row.

**Gating**:
- `?…` questions and `log:` are always accepted.
- Bare numbers and commands bind to the most recent digest from the last 36 h. Inline replies bind to their own digest.
- Other free text counts only within 12 h of a bot message, or with a `yb` prefix (so his normal notes-to-self are never read as commands).
- Tapbacks mean "seen" only.

**Grammar**:
- `done N`, `snooze N 1w|2w|1m|<date>`, `skip N`, `wrong N`, `why N`, `draft N`
- `undo` (reverts the last acknowledged command's effect; undoing an agent run is web-only)
- `log: …`, `? …`
- `pause`, `resume`, `more`, `help`

**Parsing and replies**:
- Deterministic parser first. Then an LLM intent parser (route `intent`: Haiku, structured output, effort `low`, through the egress point) for `log:` and free text.
- Ambiguous names get a "1/2?" clarification that stays open for 1 h.
- Every effect is acknowledged as `🅨 ✓ …`.
- Limits: ≤30 commands/h, a circuit breaker at >20 outbound messages/h, idempotent on GUID.

### Ask your network (web + iMessage `?`)
**Retrieval**: FTS5 over messages, facts and people (trigram for names), plus the gazetteer for city queries.

**Loop**: Haiku 5.5 tool-use (routes `ask_web` / `ask_imessage`: effort `low`, adaptive thinking), `tool_choice:auto`, ≤8 tool calls, ≤60k input tokens, append-only history; tools + system cached 5 min plus the moving breakpoint on the last user message.
- **Read-only tools, all strict**: `search_people`, `search_messages`, `search_facts`, `get_person`, `graph_neighbors`, `list_events`.
- **Tool results go through the egress pseudonymizer** and are labeled untrusted.

**Citations** (`[m:..] [F..] [E..] [P..]`):
- Any id not returned by a tool is stripped.
- iMessage answers are ≤600 characters, carry no sensitive facts, and contain only `yeackbot.com` links (other URLs removed).

### Circles and intros
**Circles** (weekly):
- One seeded Louvain run on `co_group` + `co_attend` + family/partner/roommate edges.
- Greedy Jaccard ≥0.5 matching keeps circle ids stable.
- Named by the LLM from chat and event titles.
- Legacy groups become locked user circles.

**Intros**:
- Pair score from interest IDF-Jaccard, same metro, ties and a "need match".
- At most 1 every 3 days and 4 per month.
- Drafts only, never sent.

## Safety and privacy guarantees (enforced in code)
- **Only Michael can be messaged.**
  - The self handles are **compiled into the signed collector** and intersected with the Mac's own iMessage account addresses from chat.db. Changing them breaks the signature.
  - **The repo is PUBLIC** (`mayeack/blackbook`). Self handles live only in a git-ignored `collector/Generated/SelfHandles.generated.swift`, written by `npm run setup:self` from a local file. No phone numbers, emails, friends' names, tokens or real-data fixtures are ever committed; `npm run lint:pii` runs in CI and pre-commit.
  - The Beeper wrapper is GET-only. Partiful calls are limited to the read-function allowlist.
  - Nothing ever writes to Contacts or Calendar.
  - Outbound text is URL-allowlisted to `yeackbot.com`.
- **Prompt injection**: extraction has no tools and returns schema-only output. Ask tools are read-only.
- **Exposure**:
  - Access sits in front of everything except the bypass paths `/healthz`, `/manifest.webmanifest`, `/icons/*` and `/apple-touch-icon*`.
  - The server verifies `Cf-Access-Jwt-Assertion` with `jose` (aud, iss, email).
  - Mutating routes require JSON + `X-YB: 1` (no CORS).
  - Rate limits keyed on `CF-Connecting-IP`; `Cache-Control: no-store`.
  - The admin interface is reachable only over the unix socket.
- **Logs**: scrubbed JSONL with ids, counts and error classes only. No message text, names, handles or tokens. `console.*` is banned by lint.
- **Secrets**:
  - Stored AES-256-GCM in the `secrets` table, with the key in `.env`: Beeper token, Partiful refresh token, Google refresh token, VAPID key.
  - The collector token is a 0600 file. Any process running as the user can read it; that residual risk is documented.
- **Hidden/merged people**: excluded at one server-side `person_visible` view, and from candidates, Ask and the graph. The only exception is Settings → Hidden.

## Web app (agent-first core)
- **Navigation**:
  - Mobile tabs: **Today · People · Ask · Network · More** (Circles, Events, Sources, Settings).
  - Desktop: a sidebar.
  - 16 px gutters, no horizontal scroll at 320 px, safe-area insets, dark mode.
- **Today**:
  - Digest cards with Done / Snooze / Skip / Wrong / Why this.
  - An Open-loops strip.
  - **"What the agent did"**, grouped by run, with per-change Undo/Redo and "Undo entire run" (dry-run preview first).
  - A "Check these" list of lower-confidence actions from the last 7 days.
- **People and Person**:
  - People defaults to last name A–Z (`Intl.Collator`), first name as tiebreaker, blank last names last. Search shows avatar + name + company/handle.
  - Person sections: Overview, Timeline and Connections.
    - Overview: open loops, starters (copy-only), facts with evidence and Wrong, linked accounts with match method and Unlink, circles/tags/locations, notes, merge history with Split.
    - Timeline: cross-source sessions with source badges.
    - Connections: edges with evidence chips, and the pair page.
- **Other screens**:
  - **Network**: sigma.js + ForceAtlas2 worker.
  - **Circles / Tags / Locations**.
  - **Events**: occasions with inferred attendees and their confidence, and the brief.
  - **Ask**: SSE chat with citations.
  - **Sources**: per-source health, cursors, oldest-data alarm, collector permission matrix, pipeline cost and cache hit rate.
  - **Settings**: digest, push, agent thresholds, privacy, What I've learned, Google connect, calendars, `/settings/eval`.
- **UX rules carried over**:
  - every avatar or chip is a `<PersonLink>`;
  - one `EntityRow` component (36 px icon, radius 8);
  - gold accent;
  - the agent never deletes manual collections.
- **PWA**:
  - The service worker is network-first for navigations.
  - The API client turns opaque or redirect failures into a top-level navigation to `/` (Access re-login).
  - `web-push` with VAPID; on 410, resubscribe.

## Phased roadmap (≈48 dev days, ~11 weeks)

Each phase ends with:
- quick-test bullets in chat;
- an entry appended to `docs/test-scenarios/TEST_SCENARIOS.md`;
- a work-log memory update.

### Day 0 (≈1 h; Claude does the server steps after approval)
Server steps (Claude):
1. **Close the public endpoint**: `launchctl bootout gui/$(id -u)/com.cloudflare.libersecretorum`, and remove the `sync.libersecretorum.com` DNS record in the dashboard (files move to `~/.cloudflared/retired/` at retirement). Verify that `curl -sI https://sync.libersecretorum.com` no longer reaches the origin. iMessage logging keeps running locally.
2. Copy the design specs into `docs/design/`, and record the work-log memory.

Michael's steps (listed under "Manual setup steps for Michael" below):
3. Keep Messages → Forever, on iPhone and Mac.
4. Request the Instagram DYI JSON export.
5. Install and link WhatsApp for Mac.
6. Install Beeper.
7. Set power and update settings (`pmset autorestart 1`, manual macOS updates).
8. Add an external uptime monitor on `/healthz`.

### Phase 0: spikes and "hello yeackbot.com" (4 days)
Run in this order and record the results in `docs/RUNBOOK.md`.

**(a) Note-to-self on Tahoe**, sending from the collector, not Terminal:
- Does a send produce 1 or 2 rows, with which `is_from_me`/handle/chat id?
- How do iPhone-typed replies arrive?
- Does a link-preview row appear? Does a send to his own handle fail with -1728?
- Does he already use note-to-self?
- Fallback: commands via web only.

**(b) IMsgCore in the BlackbookServer target**:
- Pass: ≥99% of 90-day bodies decoded.
- FDA survives two re-signs (requirement unchanged) and an `authrestart`.
- The Automation prompt appears from the LSUIElement app.
- Port 8765 goes loopback-only in this build.

**(c) Tunnel + Access**:
- The yeackbot.com zone appears to be in the same account as libersecretorum (same nameservers).
- Create the tunnel with an explicit `--config`/`--origincert`, and add the CNAME in the dashboard.
- Access app: Google IdP + one-time PIN backup, 1-month session. Plus a Bypass app for the static paths.

**(g) iOS PWA under Access**: install, push while locked, open from a tap, re-login after expiry inside the PWA. Fallback is a passkey session, which needs Michael's sign-off.

**(e) WhatsApp schema**, with aggregates only.

**(d) Beeper Instagram history depth** at +24 h and +72 h. Also check the participant id format.

**(f) Partiful**: token refresh plus one call each to the read functions.

**(h) Anthropic batch smoke test**: Haiku 5.5, no fallbacks in the batch, and cache hits on requests 2–3. Also check Zod 4 + `zodOutputFormat`. Before moving any route off Haiku, compare it with Sonnet 5.5 on the eval (`yb eval shadow`).

**(i) Google Calendar OAuth** (production mode) plus one incremental sync.

**Exit**:
- yeackbot.com loads behind Access and is installed on the iPhone.
- A test push arrives.
- "🅨 hello" goes to self, and a typed reply shows up on Sources.

### Phase 1: read-only CRM with full history (8 days)
**Scope**:
- Monorepo scaffold (FI `db/{connection,migrate,backup,lock,tx}.ts`, `scripts/service.sh`; Proper Thought `build-server.mjs`, plists).
- Schema + journal.
- Collector API v1: health, imessage messages/chats/handles/edited, contacts, send.
- Full iMessage backfill (all history).
- **Legacy migration** (`yb migrate-legacy --dry-run` → core → `reconcile` after backfill):
  - bplist arrays and UUID blobs converted;
  - +978307200 epoch shift;
  - Core Data join tables `Z_3TAGS`, `Z_3GROUPS`, `Z_3LOCATIONS`;
  - `ZINTERACTION` reconciled against chat.db with a ≥98% match target.
- Address book.
- Google Calendar raw ingest.
- Deterministic identity resolution, sessions and interactions.

**Screens**: People, Person (Overview + Timeline), Collections, Sources, Settings → Hidden.

**Verify**:
- `npm test`.
- `npm run verify:imessage`: chat.db vs DB counts within 0.5%; ≥99% of text-bearing episodes have text.
- Migration dry-run equations (people == ZCONTACT, and so on), with a second run inserting 0 rows.
- A hidden-person test against `person_visible`.
- Browser: `/people` sort and search; a person seen in a group chat shows the group sessions, including his own sends.

### Phase 2: the daily agent loop (9 days)
**Scope**:
- Cadence ties, with fading suppressed for people with WA/IG identities.
- Reply debt v1 (deterministic).
- Deterministic and guarded dedup.
- `co_group` edges.
- Circles v1, named from group titles.
- Candidate generators, plus the **self-learning ranker and wildcards** and the learner tables.
- Template digest and Web Push.
- Command poller and grammar.
- Undo engine with blocks.

**Screens**: Today (activity and undo), Network, Settings → What I've learned.

**Verify**:
- Five consecutive digests at 08:00 ±2 min, each with a push.
- Every command acknowledged in <60 s.
- A CI replay of a synthetic self-thread run twice: zero double-processing and zero bot rows parsed.
- A journal property test: random operations followed by full undo restore the starting state, and re-ingest is a no-op.
- Undo a merge in the browser and confirm the nightly run does not redo it.
- Learner unit tests:
  - simulated "always acts on reply_debt, ignores fading" → reply_debt propensity rises and fading falls within 2 weeks of simulated days;
  - the wildcard rate stays ≈0.2.

### Phase 3: all sources plus calendar inference (10 days)
**Scope**:
- WhatsApp: snapshot, LID mapping, rosters.
- Beeper Instagram and the DYI importer.
- Partiful API and the texts parser.
- Probabilistic matcher with guards.
- Calendar occasions: merging, classification rules, deterministic attendee candidates and scoring.
- `co_attend` edges.
- Events screen.

**Verify**:
- `npm run verify:sources`: per-source counts, identity link rate, LID map rate.
- Every source card green for 3 nights.
- Failure drills: quit WhatsApp → alert; revoke the Beeper token → "Needs you"; corrupt the Partiful token → "Recapture token".
- A person who is on both iMessage and WhatsApp shows an interleaved timeline with both badges.
- A "Drinks w/ X" calendar event resolves to the right X using message evidence.

### Phase 4: LLM intelligence (10 days)
**Scope**:
- Egress choke point and pseudonymizer, with the fail-closed scanner.
- Extraction batches: steady state plus the one-time historical backfill.
- Validation and the apply policy.
- Reply debt v2.
- Commitments with auto-close.
- Calendar attendee adjudication.
- LLM digest copy and starters, with the grounding validator.
- Intent parser (`log:`).
- Ask (web and iMessage).
- Circle naming.
- Golden-set labeling UI and `npm run eval`.

**Verify**:
- Golden-set precision: facts ≥0.90, commitments and needs-reply ≥0.85, groundedness 100%.
- 7 nights at ≤$1.50 per day.
- Over iMessage: `log: coffee w/ Sam, he's moving to Denver` adds an interaction and a location fact; `? who do I know in Austin` returns a cited answer in <30 s.
- `wrong N` invalidates the fact, and it does not return.

### Phase 5: event and travel intel, plus intros (5 days)
**Scope**:
- Pre-event briefs: the morning of, or a generic push 3 h before.
- Day-after follow-ups for Partiful and calendar occasions.
- Trip detection from calendar lodging and flights, matched against people's location facts and address-book cities.
- Intros.
- Monthly DYI reconciliation nudge.

**Verify**:
- A test "Flight to Austin" next week produces a travel item.
- A past occasion produces a follow-up naming the inferred attendees.

### Phase 6: cutover and retirement (2 days, plus a 7-day parallel run)
1. **Collector v2**: delete `BackupServer.swift`, `IMessageSyncService.swift`, `ServerModelContainer.swift`, `BackupMetadata.swift`, `console.html` and the `Blackbook/Models` sources from the target. Keep the bundle id; re-check the signing requirement and FDA.
2. **Archive** `~/Library/Application Support/Blackbook/` as a read-only tar plus sha256.
3. **Delete the libersecretorum tunnel** and its credentials.
4. **Retire the native apps**: remove them from the devices, expire TestFlight, revoke the ASC key, delete the `ASC_*`/`MATCH_*` GitHub secrets and the Keychain item `com.blackbookdevelopment.claude-api`.
5. **Repo cleanup**:
   - Delete `Blackbook/`, `BlackbookTests/`, `fastlane/`, `amplify/`, the TestFlight scripts and docs.
   - Port the useful merge/dedup test assertions to vitest.
   - Rewrite `CLAUDE.md` with web UI rules, plus `README` and `.env.example`.
   - New CI: a node job (typecheck, vitest, fixture PII lint) and a collector job (xcodegen + xcodebuild test).
6. **Restore drill** from the nightly backup.

## Manual setup steps for Michael

**Day 0**:
1. **iPhone and Mac**: Keep Messages → Forever.
2. **Instagram**: Accounts Center → Download your information → JSON, all time. Drop the zip into `~/Yeackbot Imports/` when it arrives.
3. **WhatsApp for Mac**: install from the App Store, link it, turn on Open at Login. Open WhatsApp on the phone at least every 12 days.
4. **Beeper Desktop**:
   - Set up Instagram 2FA with an authenticator app first.
   - Connect **Instagram only**, in On-Device mode.
   - Settings → Developers → enable the Desktop API and create a token; give it to `npm run setup:beeper`.
   - Turn on Open at Login.
5. **Power and updates**: `sudo pmset -a autorestart 1`; turn off automatic macOS installs (keep Security Responses); stay on 26.x until the stack is verified on 27.

**Phase 0**:

6. **Cloudflare Zero Trust**:
   - Google IdP (Google Cloud OAuth client).
   - Access app (allow his Gmail, 1-month session) and the Bypass app.
   - The CNAME record.
7. **Collector permissions**: approve Contacts and click "Send test to me" (the Automation prompt). FDA already exists.
8. **Anthropic Console**: a "yeackbot" workspace API key, with a $60/month limit (raised for month 1 to cover the backfill).
9. **Partiful**: log in at partiful.com, then from DevTools → IndexedDB `firebaseLocalStorageDb` copy the refresh token and uid → `npm run setup:partiful`.
10. **Google Calendar**: in the same Google Cloud project, create an OAuth web client with redirect `https://yeackbot.com/api/v1/google/callback`, set the consent screen **In production**, then click Connect in Settings.
11. **iPhone**: open yeackbot.com → sign in → Add to Home Screen → enable notifications → test push.
12. **Self handles**: run `npm run setup:self` (phone + Apple ID email). These are compiled into the collector build.

**Phase 4**: label the golden set at `/settings/eval` (about 45 minutes).

## Cut or deferred

**Cut**: backups UI, subscriptions, biometrics, auth screens, the sync protocol and Bonjour, the manual Log Interaction form (replaced by `log:`), the Reminders screen (replaced by commitments), Smart Groups (replaced by filters), the met-via/introduced-to pickers (replaced by edges), scoring sliders, the AI Insights screen (replaced by Ask), LinkedIn enrichment, photo upload (but see Google Photos contact screenshots, added 2026-10-21), life events and birthdays, sending drafts, instagrapi, Playwright, Splink, Presidio, a multi-model cascade, offline PWA data, attachments.

**Deferred**: WhatsApp iPhone-backup backfill, the new-number supersede rule, embeddings (ollama/sqlite-vec), photo pHash, shadow tables (the eval gate is used instead), a weekly review digest (not requested), and any offsite encrypted backup beyond Time Machine.

## Critical files

**Modify or reuse**:
- `project.yml:58-82` (BlackbookServer target: Info.plist keys, entitlements, the IMsgCore SPM dependency, hardened runtime)
- `BlackbookServer/App/BackupServer.swift:120-180`: extract the loopback NWListener into `LoopbackHTTPServer.swift`, and bind 8765 to loopback.
- `BlackbookServer/App/IMessageSyncService.swift`: reuse open/date math (`:113-154`, `:399-411`); replace the query at `:213-220` and the normalizer at `:386-394`.
- `BlackbookServer/App/ServerStatusModel.swift:22-35` (SMAppService login item), `ServerMenuView.swift`.

**Port to TS**:
- `Blackbook/Services/ContactMergeService.swift:43-68` (merge field rules)
- `Blackbook/Services/ContactDeduplicationService.swift:147-168` (`dataRichness`; **not** its name-only union)
- `Blackbook/Services/ContactSyncService.swift:344-358` (nameKey, with a per-component trim fix)
- `Blackbook/Services/ContactSuggestionEngine.swift` (weights)

**Read for migration**: `Blackbook/Models/*.swift`, `BlackbookServer/App/ServerModelContainer.swift:16-23` (store path).

**Patterns**:
- `/Users/mayeack/Financial Independence/packages/server/src/{index.ts,db/*,services/jobs.ts}`
- `/Users/mayeack/Financial Independence/scripts/service.sh`
- `/Users/mayeack/Proper Thought/{scripts/build-server.mjs,deploy/*.plist}`

**New**:
- `packages/{shared,server,web}/...`, `collector/...`
- `deploy/com.yeackbot.server.plist`, `deploy/com.cloudflare.yeackbot.plist`
- `~/.cloudflared/yeackbot.yml`
- `docs/{design,RUNBOOK.md,ARCHITECTURE.md}`

## End-to-end verification (after Phase 5)
1. `npm run typecheck && npm test`. Then `xcodebuild test -scheme BlackbookServer`, with the macOS destination per the env memory.
2. Check `bash scripts/service.sh status`, `launchctl print gui/$(id -u)/com.yeackbot.server`, and `lsof -nP -iTCP -sTCP:LISTEN | grep 432`. Both ports should be loopback-only, and 8765 closed after Phase 6.
3. Security matrix:
   - `curl -sI https://yeackbot.com/` redirects to Access.
   - `/healthz` returns only `{ok}`.
   - Loopback `/api/v1/me` without a JWT returns 401.
   - `sync.libersecretorum.com` is dead.
4. Run `npm run pipeline:run -- --dry` and `npm run digest:preview` (counts and text, no send). Then let the 08:00 digest arrive with a push.
5. Text `done 1`, `snooze 2 2w`, `log: …`, `? …`, and `undo`. Each is acknowledged within 60 s and shows up on Today.
6. In the browser:
   - Today → undo a merge → it stays undone after the next night.
   - Person → interleaved iMessage/WhatsApp/Instagram timeline, linked accounts with match methods, facts with evidence.
   - Events → an occasion with inferred attendees and evidence.
   - Network → circles.
   - Settings → What I've learned shows propensities moving after a week of use.
7. `npm run eval` meets the golden-set targets. Sources shows every card green and LLM cost ≤$1.50/day.
