/**
 * Partiful API adapter state (adapters/partiful/). Both tables are class (S): plain writes, never journaled, and
 * free of names, titles and tokens (those live in events / identities / alias_obs / the secrets table).
 *   partiful_event_sync  one row per Partiful event id: when the API (lists or getEventInfo) returned it, the
 *                        hash of the fields that make a guest-list re-fetch worthwhile, the guest-list fetch state
 *                        (trickled backfill), and contract probes for ids known only from Partiful texts.
 *   partiful_users       one row per Partiful user seen (guest, host, contact): profile fetch state (getUsers),
 *                        how the socials.instagram handle was used, and Partiful's own tie counters from
 *                        getContacts / getMutuals (sharedEventCount), which seed ties for people without messages.
 */
export const sql = /* sql */ `
CREATE TABLE partiful_event_sync (
  event_id TEXT PRIMARY KEY,                -- Partiful event id (= events.source_event_id where source = 'partiful')
  first_api_at INTEGER,                     -- NULL: known only from texts so far
  last_api_at INTEGER,
  content_hash TEXT,                        -- status, times, visibility, counts, my RSVP
  going_count INTEGER,
  guests_fetched_at INTEGER,
  guests_hash TEXT,                         -- content_hash when the guest list was last read
  guests_status TEXT CHECK (guests_status IN ('ok','hidden','partial','error','skipped')),
  guests_seen INTEGER,
  probe_at INTEGER,                         -- last getEventInfo probe for a text-only id
  probe_status TEXT CHECK (probe_status IN ('found','not_found','forbidden','error')),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pes_guests ON partiful_event_sync(guests_fetched_at);

CREATE TABLE partiful_users (
  user_id TEXT PRIMARY KEY,
  identity_id TEXT REFERENCES identities(id),
  profile_fetched_at INTEGER,
  has_instagram INTEGER NOT NULL DEFAULT 0 CHECK (has_instagram IN (0,1)),
  -- what the socials.instagram handle did: linked (merged into the handle's person), attached (new handle
  -- identity on this person), same (already one person), held (a guard said no), incompatible (first names
  -- differ: left to the probabilistic matcher), invalid (not a usable handle)
  ig_link TEXT CHECK (ig_link IN ('linked','attached','same','held','incompatible','invalid')),
  shared_event_count INTEGER,
  is_contact INTEGER NOT NULL DEFAULT 0 CHECK (is_contact IN (0,1)),
  is_mutual INTEGER NOT NULL DEFAULT 0 CHECK (is_mutual IN (0,1)),
  is_past_guest INTEGER CHECK (is_past_guest IN (0,1)),
  last_shared_event_id TEXT,
  last_shared_event_at INTEGER,
  counts_updated_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pu_identity ON partiful_users(identity_id);
CREATE INDEX pu_profile ON partiful_users(profile_fetched_at);

-- Tie seeding (intelligence §3: V += 5·min(3, sharedEventCount) for people with no message history), per
-- canonical person.
CREATE VIEW partiful_person_shared_events AS
  SELECT c.canonical_id AS person_id, max(u.shared_event_count) AS shared_event_count, max(u.counts_updated_at) AS updated_at
  FROM partiful_users u
  JOIN identities i ON i.id = u.identity_id AND i.status = 'active'
  JOIN person_canon c ON c.person_id = i.person_id
  WHERE u.shared_event_count IS NOT NULL
  GROUP BY c.canonical_id;

-- Partiful attendee rows are read back per identity (co-attendance counts for §1.4 promotion).
CREATE INDEX att_partiful_identity ON event_attendees(identity_id) WHERE source = 'partiful' AND identity_id IS NOT NULL;
`;
