/**
 * 027 event picks (owner requests 2026-10-22 and 2026-10-25; design docs/design/event-picks.md): a weekly email (or
 * text) of events the owner might like on nights his calendar is free, found on the web, in his event newsletters
 * and on his "Recurring Events" calendar, with a link to get tickets, learning from which ones he goes to.
 *
 *   event_pick_runs (D)   one weekly run (intel/eventPicks/run.ts): the local week it covers (week_start = its first
 *                         night: the day after an evening send, else the send day; window_end = its last night), the
 *                         free nights it searched, how many web searches it made and what it cost, how many
 *                         newsletters it read and calendar listings it added, drop counts by reason, and how it went
 *                         out: channel 'email' (email_state sending → sent | failed, the Gmail message id) or 'text'
 *                         (the texts' outbound ids). One row per week.
 *   event_picks (D)       every event a run found, picked or not: where it came from (source: the web, a newsletter
 *                         or his Recurring Events calendar; source_ref = the newsletter's Gmail id or the calendar
 *                         series, local only), what it said (title, performers, genres, category, venue, local date /
 *                         start), the ticket link it checked (link_kind: an event's own ticket page, a resale page, or
 *                         a listing page) and the page it came from, the score and its parts, and why it was dropped.
 *                         Picked rows carry the ordinal they were sent with and move picked → going (a ticket email,
 *                         calendar entry or Partiful RSVP showed up for it, or he said so), not_for_me (he said so) or
 *                         passed (the night went by: outcome_source 'date', or 'busy' when he had other plans that
 *                         night, which teaches nothing). clicks count taps on its yeackbot.com/go/<id> link.
 *
 * CHECK lists widened by rebuilding (as 023 did): llm_requests.kind + 'events', outbound_messages.purpose + 'events'.
 */
import type { DB } from '../connection';
import { widenTableCheck } from './023_party_invite';

export const sql = /* sql */ `
CREATE TABLE event_pick_runs (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL UNIQUE CHECK (week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  window_end TEXT NOT NULL CHECK (window_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('discovering','ready','sent','empty','failed')),
  city TEXT,
  free_nights TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(free_nights)),
  searches INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  dropped TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dropped)),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT CHECK (error IS NULL OR length(error) <= 80),
  outbound_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(outbound_ids)),
  newsletters INTEGER NOT NULL DEFAULT 0,
  listings INTEGER NOT NULL DEFAULT 0,
  channel TEXT CHECK (channel IS NULL OR channel IN ('email','text')),
  email_state TEXT CHECK (email_state IS NULL OR email_state IN ('sending','sent','failed')),
  email_id TEXT CHECK (email_id IS NULL OR length(email_id) <= 64),
  email_at INTEGER,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE event_picks (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 40 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  run_id TEXT NOT NULL REFERENCES event_pick_runs(id),
  ordinal INTEGER CHECK (ordinal IS NULL OR ordinal BETWEEN 1 AND 20),
  event_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','newsletter','calendar')),
  source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 200),
  title TEXT NOT NULL,
  performers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(performers)),
  genres TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(genres)),
  category TEXT NOT NULL
    CHECK (category IN ('concert','club','festival','comedy','theater','sports','party','talk','member_event','other')),
  venue TEXT NOT NULL,
  venue_key TEXT NOT NULL DEFAULT '',
  city TEXT,
  local_date TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time TEXT CHECK (start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  starts_at INTEGER NOT NULL,
  ticket_url TEXT,
  ticket_host TEXT,
  link_kind TEXT CHECK (link_kind IS NULL OR link_kind IN ('ticket','resale','listing')),
  source_url TEXT,
  why TEXT CHECK (why IS NULL OR length(why) <= 160),
  score REAL NOT NULL DEFAULT 0,
  parts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(parts)),
  wildcard INTEGER NOT NULL DEFAULT 0 CHECK (wildcard IN (0,1)),
  drop_reason TEXT CHECK (drop_reason IS NULL OR length(drop_reason) <= 40),
  status TEXT NOT NULL CHECK (status IN ('found','picked','going','not_for_me','passed')),
  clicks INTEGER NOT NULL DEFAULT 0,
  clicked_at INTEGER,
  outcome_at INTEGER,
  outcome_source TEXT CHECK (outcome_source IS NULL OR outcome_source IN ('ticket','calendar','partiful','owner','date','busy')),
  outbound_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX event_picks_run ON event_picks(run_id, ordinal);
CREATE INDEX event_picks_key ON event_picks(event_key);
CREATE INDEX event_picks_open ON event_picks(local_date) WHERE status = 'picked';
CREATE INDEX event_picks_series ON event_picks(source_ref, local_date) WHERE source = 'calendar';
`;

export const rebuildsTables = true;

/** Values this migration adds to existing CHECK lists (frozen: later additions get their own migration). */
export const ADDED = {
  llmKinds: ['events'],
  outboundPurposes: ['events'],
} as const;

export function up(db: DB): void {
  widenTableCheck(db, 'llm_requests', 'kind', ADDED.llmKinds);
  widenTableCheck(db, 'outbound_messages', 'purpose', ADDED.outboundPurposes);
}
