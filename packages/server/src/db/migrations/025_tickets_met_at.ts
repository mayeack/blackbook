/**
 * 025 tickets, "met at" and contact screenshots (owner request 2026-10-21; design docs/design/tickets-met-at.md).
 *
 *   ticket_events (D)         one real-world event the owner holds (or held) tickets to, assembled from its ticket
 *                             emails by adapters/gmail/ledger.ts: title, performers, inferred genres and category,
 *                             venue, start (UTC ms) and the venue's local date (tz NULL = the zone was guessed from
 *                             the owner's, so joins don't trust the hour), the quantity state machine (bought,
 *                             received, sent, sold, refunded; held NULL = unknown because a quantity was missing)
 *                             and the status it implies ('unconfirmed' = mail about an event but no proof of a
 *                             ticket). Re-derived from the parsed
 *                             emails whenever one is added; ids are stable and two rows that turn out to be one
 *                             event are pointer-merged (merged_into_id). Ticket events with status 'holding' feed the
 *                             occasions build as ticket copies (occasion_sources.source 'ticket').
 *   gmail_messages (E)        every Gmail message the ticket source looked at, keyed by Gmail's id: sender domain and
 *                             vendor (never the address), subject (local only), the triage verdict, the parse state
 *                             and the parsed TicketEmail JSON plus deterministic refs (vendor event id, order ref).
 *                             clean_text is the masked, cleaned excerpt waiting for the ticket-parse batch, cleared
 *                             once the message reaches a final parse state; bodies are never stored.
 *   ticket_parties (E)        a transfer counterparty named on a ticket email (who the owner sent tickets to or got
 *                             them from): the name and Gmail-folded email key as written, and the person it resolved
 *                             to. Local only; never sent to the model.
 *   person_met_at (J)         where the owner met someone: a person ↔ an owner-attended occasion or Partiful event,
 *                             inferred by intel/metAt from an Instagram follow / first DM, a new contact card or a
 *                             contact screenshot close to the event. 'withdrawn' is the agent retracting its own
 *                             link; 'rejected' is the owner's sticky "Wrong" (or an undo), never re-created.
 *   gphotos_sessions (S)      Google Photos Picker sessions the owner started from Settings.
 *   contact_screenshots (E)   screenshots read for contact info (Google Photos Picker items): when taken, what kind
 *                             of screen it was, the person it linked to. The image itself is deleted after OCR.
 *
 * addressbook_cards gains created_at: the card's creation date from the AddressBook store (collector, FDA), filled
 * on every ingest pass (outside content_hash, so it never re-applies a card).
 * CHECK lists widened by rebuilding (as 023 did): suggestions.kind + 'event_invite', occasion_sources.source +
 * 'ticket', llm_requests.kind + 'ticket'.
 */
import type { DB } from '../connection';
import { widenTableCheck } from './023_party_invite';

export const sql = /* sql */ `
CREATE TABLE ticket_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  performers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(performers)),
  genres TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(genres)),
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('concert','club','festival','comedy','theater','sports','party','talk','member_event','other')),
  venue TEXT,
  venue_key TEXT,
  city TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  tz TEXT,
  local_date TEXT NOT NULL,
  vendors TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(vendors)),
  vendor_event_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(vendor_event_ids)),
  partiful_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(partiful_ids)),
  qty_bought INTEGER NOT NULL DEFAULT 0,
  qty_received INTEGER NOT NULL DEFAULT 0,
  qty_sent INTEGER NOT NULL DEFAULT 0,
  qty_sold INTEGER NOT NULL DEFAULT 0,
  qty_refunded INTEGER NOT NULL DEFAULT 0,
  held INTEGER,
  status TEXT NOT NULL CHECK (status IN ('holding','unconfirmed','gave_away','sold','refunded','cancelled')),
  emails INTEGER NOT NULL DEFAULT 0,
  first_email_at INTEGER NOT NULL,
  last_email_at INTEGER NOT NULL,
  merged_into_id TEXT REFERENCES ticket_events(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ticket_events_time ON ticket_events(starts_at) WHERE merged_into_id IS NULL;
CREATE INDEX ticket_events_date ON ticket_events(local_date) WHERE merged_into_id IS NULL;

CREATE TABLE gmail_messages (
  gmail_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  internal_at INTEGER NOT NULL,
  from_domain TEXT,
  vendor TEXT,
  subject TEXT,
  triage TEXT NOT NULL CHECK (triage IN ('candidate','marketing','ignored')),
  parse_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending','queued','parsed','not_ticket','failed','blocked','skipped')),
  parsed TEXT CHECK (parsed IS NULL OR json_valid(parsed)),
  refs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(refs)),
  clean_text TEXT,
  prompt_version TEXT,
  custom_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  ticket_event_id TEXT REFERENCES ticket_events(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX gmail_msg_parse ON gmail_messages(parse_status) WHERE triage = 'candidate';
CREATE INDEX gmail_msg_event ON gmail_messages(ticket_event_id) WHERE ticket_event_id IS NOT NULL;
CREATE INDEX gmail_msg_thread ON gmail_messages(thread_id);

CREATE TABLE ticket_parties (
  gmail_id TEXT NOT NULL REFERENCES gmail_messages(gmail_id),
  direction TEXT NOT NULL CHECK (direction IN ('sent_to','received_from')),
  name TEXT,
  email_key TEXT,
  quantity INTEGER,
  person_id TEXT REFERENCES people(id),
  ticket_event_id TEXT REFERENCES ticket_events(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (gmail_id, direction),
  CHECK (name IS NOT NULL OR email_key IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX ticket_parties_event ON ticket_parties(ticket_event_id) WHERE ticket_event_id IS NOT NULL;
CREATE INDEX ticket_parties_person ON ticket_parties(person_id) WHERE person_id IS NOT NULL;

CREATE TABLE person_met_at (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  occasion_id TEXT REFERENCES occasions(id),
  event_id TEXT REFERENCES events(id),
  target_key TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('instagram_follow','instagram_dm','contact_added','contact_screenshot','user')),
  signal_at INTEGER NOT NULL,
  signals TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(signals)),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('active','withdrawn','rejected')),
  source TEXT NOT NULL CHECK (source IN ('inferred','user')),
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((occasion_id IS NULL) <> (event_id IS NULL)),
  CHECK (target_key = CASE WHEN occasion_id IS NOT NULL THEN 'o:' || occasion_id ELSE 'e:' || event_id END),
  UNIQUE (person_id, target_key)
) STRICT;
CREATE INDEX met_at_active ON person_met_at(person_id) WHERE status = 'active';
CREATE INDEX met_at_occasion ON person_met_at(occasion_id) WHERE occasion_id IS NOT NULL;
CREATE INDEX met_at_event ON person_met_at(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE gphotos_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open','picked','done','expired','failed','cancelled')),
  picker_uri TEXT NOT NULL,
  expires_at INTEGER,
  poll_after INTEGER,
  items_total INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX gphotos_sessions_open ON gphotos_sessions(status) WHERE status IN ('open','picked');

CREATE TABLE contact_screenshots (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('gphotos')),
  source_ref TEXT NOT NULL,
  session_id TEXT,
  taken_at INTEGER,
  status TEXT NOT NULL
    CHECK (status IN ('downloaded','no_text','no_contact','linked','ambiguous','self','failed','expired')),
  kind TEXT CHECK (kind IN ('instagram_profile','contact_card','social_profile','message','other')),
  person_id TEXT REFERENCES people(id),
  found TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(found)),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source, source_ref)
) STRICT;
CREATE INDEX contact_shots_person ON contact_screenshots(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX contact_shots_pending ON contact_screenshots(status) WHERE status = 'downloaded';

ALTER TABLE addressbook_cards ADD COLUMN created_at INTEGER;
`;

export const rebuildsTables = true;

/** Values this migration adds to existing CHECK lists (frozen: later additions get their own migration). */
export const ADDED = {
  suggestionKinds: ['event_invite'],
  occasionSources: ['ticket'],
  llmKinds: ['ticket'],
} as const;

export function up(db: DB): void {
  widenTableCheck(db, 'suggestions', 'kind', ADDED.suggestionKinds);
  widenTableCheck(db, 'occasion_sources', 'source', ADDED.occasionSources);
  widenTableCheck(db, 'llm_requests', 'kind', ADDED.llmKinds);
}
