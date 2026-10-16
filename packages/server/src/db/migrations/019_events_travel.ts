/**
 * 019 events, travel and intros (owner: intel/, intelligence §5 "Travel intel", "Event intel", "Intro suggestions";
 * PLAN "Calendar attendee inference" step 4).
 *
 *   trips (D, 001)            gains how it was detected: the home metro it was compared with, the segment kinds that
 *                             built it (flight / lodging / travel / venue) and when the nightly pass last confirmed it.
 *                             Trips are rebuilt by intel/trips.ts from lodging, flight, multi-day and distant-venue
 *                             occasions; trips no longer detected inside the pass's window are removed.
 *   trip_people (D)           who you know at a trip's destination and why (location fact, moving there, their own
 *                             travel plan, an address-book city, a Partiful event there, a saved location), ranked
 *                             0.6·T + 0.4·H. Rebuilt with the trips.
 *   intro_pairs (D)           eligible intro pairs scored 0.4·IDF-Jaccard(interests) + 0.3·same metro + 0.2·min(T)/100
 *                             + 0.1·need match, kept from 0.3 up (≥ 0.45 suggests; 0.3–0.45 feeds the 🎲 intro_pair
 *                             wildcard). Numbers and ids only; `shared` holds the shared interest fact ids.
 *   occasion_adjudications (S) one row per nightly LLM adjudication request of an occasion (round 1, 2, … — the day-after
 *                             re-run is a new round). `refs` maps the pseudonym tokens and message ids that request was
 *                             allowed to cite to local ids; it never leaves the Mac. `result` holds counts only.
 *   intel_state (S)           small flags (e.g. occasion effects to re-derive after an adjudication applied).
 */
export const sql = /* sql */ `
ALTER TABLE trips ADD COLUMN home_key TEXT;
ALTER TABLE trips ADD COLUMN kinds TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(kinds));
ALTER TABLE trips ADD COLUMN updated_at INTEGER;
CREATE INDEX trips_starts ON trips(starts_on);

CREATE TABLE trip_people (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  person_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('location_current','location_next','travel_plan','addressbook','partiful','legacy_location')),
  detail TEXT,
  score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
  fact_id TEXT,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, person_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX tp_person ON trip_people(person_id);

CREATE TABLE intro_pairs (
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
  interest REAL NOT NULL CHECK (interest BETWEEN 0 AND 1),
  same_metro INTEGER NOT NULL CHECK (same_metro IN (0,1)),
  need_match INTEGER NOT NULL CHECK (need_match IN (0,1)),
  shared TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(shared)),
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ip_score ON intro_pairs(score DESC);

CREATE TABLE occasion_adjudications (
  occasion_id TEXT NOT NULL REFERENCES occasions(id),
  round INTEGER NOT NULL CHECK (round >= 1),
  custom_id TEXT NOT NULL UNIQUE,
  pool TEXT NOT NULL CHECK (pool IN ('steady','backfill')),
  reason TEXT NOT NULL CHECK (reason IN ('new','changed','day_after')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','applied','rejected','failed')),
  refs TEXT NOT NULL CHECK (json_valid(refs)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  submitted_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (occasion_id, round)
) STRICT, WITHOUT ROWID;
CREATE INDEX oa_status ON occasion_adjudications(status, submitted_at);

CREATE TABLE intel_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL
) STRICT;
`;
