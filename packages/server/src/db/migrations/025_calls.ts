/**
 * 025 Calls (owner: adapters/calls/*; read by routes/people.ts timeline and, through interactions, by ties).
 *
 *   calls (S)         the Mac's call log (CallHistory.storedata via the collector's GET /v1/calls): one row per call,
 *                     keyed by its CallHistory unique id. Holds only calls that rang or were placed on this Mac
 *                     (iPhone calls relayed through Continuity, FaceTime), so most have no duration.
 *   call_handles (S)  the call's remote party and any other group-call participants, normalized like identities.key.
 *                     Calls aren't bound to a person: they're joined to identities by (kind, key) when read, so a
 *                     number that becomes a contact later picks up its past calls.
 *   interactions      gains call_id: one derived 'call' interaction per (person, answered call). dedupe_key now
 *                     ends with the call id, so a person can have more than one derived call.
 */
export const sql = /* sql */ `
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  source_uid TEXT NOT NULL UNIQUE,
  source_rowid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  service TEXT NOT NULL CHECK (service IN ('phone','facetime_audio','facetime_video','other')),
  outgoing INTEGER NOT NULL CHECK (outgoing IN (0,1)),
  answered INTEGER NOT NULL CHECK (answered IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX calls_time ON calls(started_at);

CREATE TABLE call_handles (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('phone','email')),
  key TEXT NOT NULL,
  PRIMARY KEY (call_id, kind, key)
) STRICT, WITHOUT ROWID;
CREATE INDEX call_handles_key ON call_handles(kind, key);

DROP INDEX inter_derived_dedupe;
ALTER TABLE interactions DROP COLUMN dedupe_key;
ALTER TABLE interactions ADD COLUMN call_id TEXT REFERENCES calls(id);
ALTER TABLE interactions ADD COLUMN dedupe_key TEXT NOT NULL GENERATED ALWAYS AS
  (person_id || '|' || kind || '|' || ifnull(session_id, '') || '|' || ifnull(event_id, '') || '|' || ifnull(occasion_id, '')
   || '|' || ifnull(call_id, '')) VIRTUAL;
CREATE UNIQUE INDEX inter_derived_dedupe ON interactions(dedupe_key) WHERE origin = 'derived';
CREATE INDEX inter_call ON interactions(call_id) WHERE call_id IS NOT NULL;
`;
