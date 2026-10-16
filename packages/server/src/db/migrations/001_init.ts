/**
 * Yeackbot schema v1 — architecture.md §3 DDL with the PLAN.md "Critic fixes applied".
 *
 * Conventions: STRICT tables; TEXT ids are UUIDv7 (legacy ZIDs kept as lowercase 8-4-4-4-12); *_at columns are
 * Unix ms UTC; JSON columns are TEXT CHECK(json_valid(..)); booleans are INTEGER 0/1.
 * No NULL ever sits inside a UNIQUE key: optional parts go through generated dedupe_key columns or partial
 * unique indexes. External-content FTS5 tables only sit on INTEGER-rowid tables (facts and notes carry an
 * INTEGER `seq` surrogate), so VACUUM/restore can't desync them.
 *
 * Table classes (they drive undo):
 *   (E) episodes — append-only, idempotent on a natural key, never journaled
 *   (D) derived  — rebuilt from episodes/journaled state, never journaled
 *   (J) journaled — every write goes through journal/batch.ts (change_batches + change_log)
 *   (S) system   — runs, jobs, LLM bookkeeping, delivery ledgers
 */
export const sql = /* sql */ `
-- ============================================================================================
-- journal / runs (S)
-- ============================================================================================
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('nightly','ingest','command','user','migration','import','undo','weekly','system')),
  job_run_id INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','partial')),
  stage TEXT,
  stage_state TEXT CHECK (json_valid(stage_state)),
  summary TEXT CHECK (json_valid(summary)),
  undone_at INTEGER,
  undo_run_id TEXT
) STRICT;
CREATE INDEX runs_started ON runs(started_at DESC);

-- kind is open (handlers fall back to the generic inverse): merge, attach_identity, create_person, person_update,
-- fact, edge_label, commitment, reply_debt, circle, tag, location, note, setting, attendee, interaction,
-- user_edit, migration, undo, …
CREATE TABLE change_batches (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  title TEXT NOT NULL,
  subject_person_id TEXT,
  confidence REAL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','user','system')),
  undoable INTEGER NOT NULL DEFAULT 1 CHECK (undoable IN (0,1)),
  created_at INTEGER NOT NULL,
  undone_at INTEGER,
  undone_by_batch_id TEXT,
  reverts_batch_id TEXT
) STRICT;
CREATE INDEX cb_feed ON change_batches(created_at DESC);
CREATE INDEX cb_run ON change_batches(run_id, seq);
CREATE INDEX cb_subject ON change_batches(subject_person_id, seq DESC) WHERE subject_person_id IS NOT NULL;

-- before/after hold the touched columns only (full row for insert/delete).
CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES change_batches(id),
  entity TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert','update','tombstone','delete')),
  before TEXT CHECK (json_valid(before)),
  after TEXT CHECK (json_valid(after)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cl_batch ON change_log(batch_id, seq);
CREATE INDEX cl_entity ON change_log(entity, entity_key, seq);

-- ============================================================================================
-- people & identity (J; person_canon D)
-- ============================================================================================
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  nickname TEXT,
  company TEXT,
  job_title TEXT,
  birthday TEXT CHECK (birthday IS NULL OR birthday GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR birthday GLOB '--[0-9][0-9]-[0-9][0-9]'),
  family_details TEXT,
  custom TEXT CHECK (json_valid(custom)),
  photo_path TEXT,
  kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','me','business','shortcode','bot')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','provisional','roster_only','service','merged','suppressed')),
  merged_into_id TEXT REFERENCES people(id),
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0,1)),
  is_priority INTEGER NOT NULL DEFAULT 0 CHECK (is_priority IN (0,1)),
  -- user-edited fields the agent must never overwrite
  locked_fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(locked_fields) AND json_type(locked_fields) = 'array'),
  origin TEXT NOT NULL,
  legacy_pk INTEGER,
  created_by_run TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK ((merged_into_id IS NOT NULL) = (status = 'merged'))
) STRICT;
CREATE INDEX people_merged ON people(merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX people_status ON people(status, kind);
CREATE INDEX people_names ON people(last_name COLLATE NOCASE, first_name COLLATE NOCASE);
CREATE UNIQUE INDEX people_one_me ON people(kind) WHERE kind = 'me' AND status IN ('active','provisional');
CREATE UNIQUE INDEX people_legacy ON people(legacy_pk) WHERE legacy_pk IS NOT NULL;

-- (D) rebuilt from merged_into_id chains by db/canon.ts; every read joins through it.
CREATE TABLE person_canon (
  person_id TEXT PRIMARY KEY REFERENCES people(id),
  canonical_id TEXT NOT NULL REFERENCES people(id)
) STRICT;
CREATE INDEX canon_by ON person_canon(canonical_id);

-- One master person per (kind,key). shared=1: a household landline / couple's email, never a merge key.
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN ('phone','email','whatsapp_jid','whatsapp_lid','instagram_id','instagram_username',
    'instagram_name','partiful_user','addressbook_id','beeper_user','x_username','linkedin_url','legacy_id',
    'shortcode','business_chat')),
  key TEXT NOT NULL,
  raw TEXT,
  display_name TEXT,
  label TEXT,
  source TEXT NOT NULL,
  match_method TEXT NOT NULL CHECK (match_method IN ('exact','deterministic','addressbook','seed','probabilistic',
    'llm_tiebreak','self_id','user','legacy')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','service','detached')),
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  created_by_run TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, key)
) STRICT;
CREATE INDEX ident_person ON identities(person_id);

CREATE TABLE merges (
  id TEXT PRIMARY KEY,
  survivor_id TEXT NOT NULL REFERENCES people(id),
  merged_id TEXT NOT NULL REFERENCES people(id),
  method TEXT NOT NULL CHECK (method IN ('deterministic','probabilistic','llm_tiebreak','user','legacy','migration')),
  score REAL,
  evidence TEXT CHECK (json_valid(evidence)),
  batch_id TEXT NOT NULL REFERENCES change_batches(id),
  created_at INTEGER NOT NULL,
  undone_at INTEGER,
  CHECK (survivor_id <> merged_id)
) STRICT;
CREATE INDEX merges_merged ON merges(merged_id);
CREATE INDEX merges_survivor ON merges(survivor_id);

-- Hard constraint on permanent person ids, applied through canon (transitively). Only the user removes these.
CREATE TABLE do_not_merge (
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('undo','user','llm_different')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX dnm_b ON do_not_merge(b_id);

-- "never attach this identity to this person"
CREATE TABLE identity_blocks (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  person_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key, person_id)
) STRICT, WITHOUT ROWID;

-- (E) display names seen for an identity: observations, never keys.
CREATE TABLE alias_obs (
  id INTEGER PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  name_raw TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  descriptor TEXT,
  source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (identity_id, name_norm, source)
) STRICT;
CREATE INDEX alias_norm ON alias_obs(name_norm);

-- (S) probabilistic matcher pairs (a_id < b_id are permanent person ids)
CREATE TABLE match_candidates (
  id INTEGER PRIMARY KEY,
  a_id TEXT NOT NULL REFERENCES people(id),
  b_id TEXT NOT NULL REFERENCES people(id),
  score_bits REAL NOT NULL,
  p REAL NOT NULL CHECK (p BETWEEN 0 AND 1),
  families TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(families)),
  guards_failed TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(guards_failed)),
  llm_verdict TEXT CHECK (llm_verdict IN ('same','different','unsure')),
  llm_confidence REAL,
  llm_request TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','possible_duplicate','merged','separate','held','dismissed','blocked')),
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (a_id, b_id),
  CHECK (a_id < b_id)
) STRICT;
CREATE INDEX mc_status ON match_candidates(status, p DESC);

-- ============================================================================================
-- conversations & episodes (E)
-- ============================================================================================
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_conv_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','group','self','business','broadcast')),
  title TEXT,
  title_source TEXT,
  member_count INTEGER,
  agent_excluded INTEGER NOT NULL DEFAULT 0 CHECK (agent_excluded IN (0,1)),
  first_message_at INTEGER,
  last_message_at INTEGER,
  summary TEXT,
  summary_through_msg INTEGER,
  extract_cursor_msg INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source, source_conv_id)
) STRICT;
CREATE INDEX conv_last ON conversations(last_message_at DESC);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  role TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  joined_at INTEGER,
  left_at INTEGER,
  source TEXT NOT NULL CHECK (source IN ('roster','group_event','sender')),
  posts_365 INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, identity_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX cm_identity ON conversation_members(identity_id);

CREATE TABLE membership_events (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  identity_id TEXT,
  actor_identity_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('add','remove','leave','rename')),
  new_title TEXT,
  at INTEGER NOT NULL,
  message_id INTEGER,
  dedupe_key TEXT NOT NULL GENERATED ALWAYS AS
    (conversation_id || '|' || ifnull(message_id, 'at:' || at) || '|' || action || '|' || ifnull(identity_id, '')) VIRTUAL
) STRICT;
CREATE UNIQUE INDEX me_dedupe ON membership_events(dedupe_key);

-- source_msg_id: chat.db guid | '{jid}:{stanza}' | beeper id | DYI hash | legacy ZID
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_msg_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_identity_id TEXT REFERENCES identities(id),
  is_from_me INTEGER NOT NULL CHECK (is_from_me IN (0,1)),
  sent_at INTEGER NOT NULL,
  edited_at INTEGER,
  retracted_at INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('text','attachment','system','group_event','poll','sticker','link')),
  text TEXT,
  text_source TEXT CHECK (text_source IN ('text','attributedBody','none','other')),
  reply_to_msg_id INTEGER,
  reply_to_source_id TEXT,
  thread_root_source_id TEXT,
  attachments TEXT CHECK (json_valid(attachments)),
  service TEXT,
  balloon_bundle_id TEXT,
  is_spam INTEGER NOT NULL DEFAULT 0 CHECK (is_spam IN (0,1)),
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0,1)),
  content_key TEXT,
  dup_of INTEGER,
  source_row_ref TEXT,
  ingested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source, source_msg_id)
) STRICT;
CREATE INDEX msg_conv_time ON messages(conversation_id, sent_at);
CREATE INDEX msg_sender_time ON messages(sender_identity_id, sent_at);
CREATE INDEX msg_time ON messages(sent_at);
CREATE INDEX msg_content_key ON messages(content_key) WHERE content_key IS NOT NULL;

-- Reactions are folded onto their message: never messages, never interactions.
CREATE TABLE message_reactions (
  source_reaction_id TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  actor_identity_id TEXT,
  is_from_me INTEGER NOT NULL CHECK (is_from_me IN (0,1)),
  type TEXT NOT NULL,
  emoji TEXT,
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0,1)),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX react_msg ON message_reactions(message_id);

-- ============================================================================================
-- derived activity (D; interactions with origin user/agent are J)
-- ============================================================================================
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  first_msg INTEGER NOT NULL,
  last_msg INTEGER NOT NULL,
  msg_count INTEGER NOT NULL,
  initiated_by_me INTEGER NOT NULL CHECK (initiated_by_me IN (0,1)),
  extracted_at INTEGER,
  extraction_request TEXT
) STRICT;
CREATE INDEX sess_conv ON sessions(conversation_id, started_at);

-- person_id is the pre-canon person; reads go through person_canon.
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN ('dm_session','group_session','event','occasion','call','meeting','manual','text_log','legacy_text')),
  channel TEXT,
  conversation_id TEXT,
  session_id TEXT,
  event_id TEXT,
  occasion_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  msgs_from_me INTEGER NOT NULL DEFAULT 0,
  msgs_from_them INTEGER NOT NULL DEFAULT 0,
  initiated_by_me INTEGER CHECK (initiated_by_me IN (0,1)),
  units REAL,
  summary TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('derived','user','agent','legacy')),
  retracted_at INTEGER,
  created_by_run TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL GENERATED ALWAYS AS
    (person_id || '|' || kind || '|' || ifnull(session_id, '') || '|' || ifnull(event_id, '') || '|' || ifnull(occasion_id, '')) VIRTUAL
) STRICT;
CREATE UNIQUE INDEX inter_derived_dedupe ON interactions(dedupe_key) WHERE origin = 'derived';
CREATE INDEX inter_person_time ON interactions(person_id, started_at DESC);

-- Daily touch units per (canonical) person, all sources (intelligence §3).
CREATE TABLE person_touch_days (
  person_id TEXT NOT NULL,
  day TEXT NOT NULL,
  units REAL NOT NULL,
  components TEXT CHECK (json_valid(components)),
  PRIMARY KEY (person_id, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE person_stats (
  person_id TEXT PRIMARY KEY,
  last_at INTEGER,
  last_in_at INTEGER,
  last_out_at INTEGER,
  contact_days_365 INTEGER,
  n90 INTEGER,
  n365 INTEGER,
  median_gap_d REAL,
  p75_gap_d REAL,
  expected_gap_d REAL,
  silence_d REAL,
  fading_ratio REAL,
  historical_strength REAL,
  rate90 REAL,
  rate365 REAL,
  momentum REAL,
  reciprocity REAL,
  tie_strength REAL,
  state TEXT CHECK (state IN ('strong','steady','cooling','fading','dormant','new')),
  fading_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (fading_suppressed IN (0,1)),
  computed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX stats_state ON person_stats(state, fading_ratio DESC);

-- ============================================================================================
-- events, calendar, occasions
-- ============================================================================================
-- (E for source rows; J for agent-created)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('partiful','calendar','legacy_activity','manual')),
  source_event_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'social' CHECK (kind IN ('social','meeting','trip','other')),
  title TEXT,
  description TEXT,
  starts_at INTEGER,
  ends_at INTEGER,
  tz TEXT,
  location_text TEXT,
  lat REAL,
  lng REAL,
  geo_key TEXT,
  url TEXT,
  my_role TEXT,
  my_rsvp TEXT,
  status TEXT,
  visibility TEXT,
  color_hex TEXT,
  icon TEXT,
  raw TEXT CHECK (json_valid(raw)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source, source_event_id)
) STRICT;
CREATE INDEX events_time ON events(starts_at);

-- (E) raw Google Calendar events (read-only API, incremental syncToken per calendar in source_cursors)
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  google_event_id TEXT NOT NULL,
  ical_uid TEXT,
  recurring_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','tentative','cancelled')),
  summary TEXT,
  description TEXT,
  location TEXT,
  starts_at INTEGER,
  ends_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  tz TEXT,
  organizer_email TEXT,
  creator_email TEXT,
  self_organizer INTEGER CHECK (self_organizer IN (0,1)),
  attendees TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attendees)),
  html_link TEXT,
  partiful_event_id TEXT,
  etag TEXT,
  remote_updated_at INTEGER,
  raw TEXT CHECK (json_valid(raw)),
  ingested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (calendar_id, google_event_id)
) STRICT;
CREATE INDEX cal_time ON calendar_events(starts_at);
CREATE INDEX cal_partiful ON calendar_events(partiful_event_id) WHERE partiful_event_id IS NOT NULL;

-- (D) one real-world happening merged from calendar copies (+ Partiful event)
CREATE TABLE occasions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (kind IN ('social','logistics','appointment','work','lodging','travel','unknown')),
  title TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  venue_text TEXT,
  venue_key TEXT,
  lat REAL,
  lng REAL,
  event_id TEXT REFERENCES events(id),
  is_social INTEGER CHECK (is_social IN (0,1)),
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0,1)),
  corroborated INTEGER NOT NULL DEFAULT 1 CHECK (corroborated IN (0,1)),
  classified_by TEXT CHECK (classified_by IN ('rule','llm','user')),
  classification_confidence REAL,
  ticket_count INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','candidate','excluded','cancelled')),
  adjudicated_at INTEGER,
  llm_request TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX occ_time ON occasions(starts_at);

CREATE TABLE occasion_sources (
  occasion_id TEXT NOT NULL REFERENCES occasions(id),
  source TEXT NOT NULL CHECK (source IN ('calendar','partiful','legacy','manual')),
  source_ref TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','duplicate','reservation','feed_copy')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (occasion_id, source, source_ref),
  UNIQUE (source, source_ref)
) STRICT, WITHOUT ROWID;

-- Attendance on a Partiful/legacy event OR an occasion. Source rows (Partiful guest lists) are episodes;
-- inferred attendees (calendar names, message cross-refs, LLM adjudication) are journaled.
CREATE TABLE event_attendees (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id),
  occasion_id TEXT REFERENCES occasions(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  identity_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('going','approved','maybe','declined','invited','waitlist','checked_in','host',
    'attended','possible','rejected')),
  role TEXT CHECK (role IN ('companion','host','co_host','guest','ticket_holder','plus_one','mentioned_only')),
  invited_by_person_id TEXT,
  plus_one_of_person_id TEXT,
  rsvp_at INTEGER,
  source TEXT NOT NULL CHECK (source IN ('partiful','calendar','inference','llm','user','legacy')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((event_id IS NULL) <> (occasion_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX att_event_person ON event_attendees(event_id, person_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX att_occasion_person ON event_attendees(occasion_id, person_id) WHERE occasion_id IS NOT NULL;
CREATE INDEX att_person ON event_attendees(person_id);

-- (D)
CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  geo_key TEXT NOT NULL,
  label TEXT,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  source_event_ids TEXT NOT NULL CHECK (json_valid(source_event_ids)),
  created_at INTEGER NOT NULL,
  UNIQUE (geo_key, starts_on)
) STRICT;

-- ============================================================================================
-- knowledge (J)
-- ============================================================================================
-- seq is the INTEGER rowid surrogate for facts_fts; id is the stable public id (F… citations).
CREATE TABLE facts (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  person_id TEXT NOT NULL REFERENCES people(id),
  subject_identity_hint TEXT,
  type TEXT NOT NULL CHECK (type IN ('interest','activity_pref','food_drink','job','employer','role','school','education',
    'home_location','location_current','location_next','hometown','travel_plan','address','relationship_status',
    'family','pet','preference','other')),
  value TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0,1)),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  support INTEGER NOT NULL DEFAULT 1 CHECK (support >= 0),
  status TEXT NOT NULL DEFAULT 'tentative' CHECK (status IN ('candidate','tentative','confirmed','invalidated','rejected')),
  valid_from INTEGER,                 -- world time
  valid_to INTEGER,
  recorded_at INTEGER NOT NULL,       -- system time
  retracted_at INTEGER,
  superseded_at INTEGER,
  superseded_by TEXT,
  source TEXT NOT NULL,
  run_id TEXT,
  llm_request TEXT,
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX facts_person ON facts(person_id, status, type);
CREATE INDEX facts_lookup ON facts(type, value_norm) WHERE status IN ('tentative','confirmed');

CREATE TABLE fact_blocks (
  person_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, type, value_norm)
) STRICT, WITHOUT ROWID;

-- subject_type: fact | commitment | edge_label | reply_debt | suggestion | merge | attendee | occasion
CREATE TABLE evidence (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  quote TEXT,
  PRIMARY KEY (subject_type, subject_id, message_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX evidence_msg ON evidence(message_id);

-- (S) facts about mentioned people not yet resolvable to a unique person (held 30 days)
CREATE TABLE pending_mention_facts (
  id INTEGER PRIMARY KEY,
  window_id TEXT,
  conversation_id TEXT,
  surface TEXT NOT NULL,
  descriptor TEXT,
  candidates TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates)),
  fact TEXT NOT NULL CHECK (json_valid(fact)),
  message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','expired','dropped')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pmf_status ON pending_mention_facts(status, expires_at);

-- (D) person↔person evidence, open-ended types (co_group, co_attend, invited_by, plus_one, co_host,
-- group_reply, mentioned_together, met_via, …). Edges are aggregated from these timestamps nightly.
CREATE TABLE edge_evidence (
  id INTEGER PRIMARY KEY,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 40),
  directed INTEGER NOT NULL DEFAULT 0 CHECK (directed IN (0,1)),
  ref TEXT NOT NULL,                  -- 'conv:<id>' | 'event:<id>' | 'occ:<id>' | 'm:<id>' | 'legacy'
  at INTEGER,
  w_raw REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (a_id, b_id, type, ref),
  CHECK (directed = 1 OR a_id < b_id),
  CHECK (a_id <> b_id)
) STRICT;
CREATE INDEX ee_b ON edge_evidence(b_id);

-- (J) relation labels (partner, family, roommate, coworker, friend, ex, …); 'rejected' is sticky.
CREATE TABLE edge_labels (
  id TEXT PRIMARY KEY,
  a_id TEXT NOT NULL REFERENCES people(id),
  b_id TEXT NOT NULL REFERENCES people(id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  directed INTEGER NOT NULL DEFAULT 0 CHECK (directed IN (0,1)),
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0,1)),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rejected')),
  origin TEXT NOT NULL CHECK (origin IN ('llm','user','legacy')),
  run_id TEXT,
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (a_id, b_id, label),
  CHECK (directed = 1 OR a_id < b_id),
  CHECK (a_id <> b_id)
) STRICT;
CREATE INDEX el_b ON edge_labels(b_id);

-- (D) aggregated pair strength (canonical ids): strength = 1 − e^(−W/2)
CREATE TABLE edge_stats (
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  weight REAL NOT NULL,
  strength REAL NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('close','know','acquainted','faint')),
  dominant_type TEXT,
  evidence_count INTEGER NOT NULL,
  last_at INTEGER,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX es_b ON edge_stats(b_id);

-- ============================================================================================
-- organization (J) — legacy Groups become locked user circles; the agent never deletes manual collections
-- ============================================================================================
CREATE TABLE circles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','user')),
  signature TEXT,
  description TEXT,
  color_hex TEXT,
  icon TEXT,
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted','archived')),
  legacy_pk INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE circle_members (
  circle_id TEXT NOT NULL REFERENCES circles(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  score REAL,
  origin TEXT NOT NULL CHECK (origin IN ('auto','user','legacy')),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0,1)),   -- sticky removal; auto-circles never undo it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (circle_id, person_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX circm_person ON circle_members(person_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color_hex TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted')),
  legacy_pk INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE person_tags (
  person_id TEXT NOT NULL REFERENCES people(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, tag_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX pt_tag ON person_tags(tag_id);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color_hex TEXT,
  icon TEXT,
  geo_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted')),
  legacy_pk INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE person_locations (
  person_id TEXT NOT NULL REFERENCES people(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, location_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX pl_location ON person_locations(location_id);

-- seq is the INTEGER rowid surrogate for notes_fts.
CREATE TABLE notes (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  person_id TEXT REFERENCES people(id),
  content TEXT NOT NULL,
  category TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user','text_log','legacy','agent')),
  source_message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notes_person ON notes(person_id, created_at DESC);

-- ============================================================================================
-- obligations (J)
-- ============================================================================================
CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  other_person_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(other_person_ids)),
  owner TEXT NOT NULL CHECK (owner IN ('me','them','both')),
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('meet','call','send','intro','reply_later','favor','plan','other')),
  what TEXT NOT NULL,
  due_at INTEGER,
  due_start INTEGER,
  due_end INTEGER,
  due_precision TEXT CHECK (due_precision IN ('date','range','vague','none')),
  conversation_id TEXT,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','due','done','snoozed','dropped','cancelled','auto_closed','expired','lapsed','retracted')),
  snoozed_until INTEGER,
  closed_at INTEGER,
  closed_reason TEXT,
  closed_by_ref TEXT,
  run_id TEXT,
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX commit_open ON commitments(status, due_end);
CREATE INDEX commit_person ON commitments(person_id, status);

CREATE TABLE reply_debts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  last_inbound_msg INTEGER NOT NULL,
  asked_at INTEGER NOT NULL,
  reason TEXT,
  urgency TEXT CHECK (urgency IN ('low','normal','high')),
  classifier TEXT NOT NULL CHECK (classifier IN ('heuristic','llm')),
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','replied','dismissed','snoozed','expired','dropped','retracted')),
  snoozed_until INTEGER,
  closed_at INTEGER,
  closed_reason TEXT,
  closed_by_msg INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, last_inbound_msg)
) STRICT;
CREATE INDEX debt_open ON reply_debts(status, conversation_id);

-- ============================================================================================
-- suggestions / digests / feedback / self-learning (S)
-- ============================================================================================
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fading','cooling','dormant','reply_debt','commitment_due','event_followup',
    'pre_event','pre_event_brief','travel','travel_overlap','intro','circle','circle_neglect','wildcard','memory','review')),
  wildcard_generator TEXT,
  person_id TEXT,
  related_person_id TEXT,
  event_id TEXT,
  occasion_id TEXT,
  circle_id TEXT,
  commitment_id TEXT,
  reply_debt_id TEXT,
  trip_id TEXT,
  dedupe_key TEXT NOT NULL,
  base_score REAL,
  score REAL NOT NULL,
  learned_factors TEXT CHECK (json_valid(learned_factors)),
  signals TEXT NOT NULL CHECK (json_valid(signals)),
  title TEXT,
  body TEXT,
  openers TEXT CHECK (json_valid(openers)),   -- drafts only: no code path sends them
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0,1)),
  is_wildcard INTEGER NOT NULL DEFAULT 0 CHECK (is_wildcard IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('candidate','selected','delivered','done','snoozed','dismissed','wrong','expired',
    'superseded','ignored')),
  snoozed_until INTEGER,
  cooldown_until INTEGER,
  expires_at INTEGER,
  run_id TEXT,
  delivered_at INTEGER,
  acted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sugg_live ON suggestions(dedupe_key) WHERE status IN ('candidate','selected','delivered','snoozed');
CREATE INDEX sugg_status ON suggestions(status, kind);
CREATE INDEX sugg_person ON suggestions(person_id, kind, created_at DESC) WHERE person_id IS NOT NULL;

CREATE TABLE digests (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL UNIQUE,
  run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('composing','ready','sent','fallback_sent','skipped','failed')),
  rng_seed INTEGER,
  item_cap INTEGER,
  imessage_text TEXT,
  web_body TEXT CHECK (json_valid(web_body)),
  composed_at INTEGER,
  sent_at INTEGER,
  outbound_id TEXT,
  push_sent_at INTEGER,
  llm_usage TEXT CHECK (json_valid(llm_usage))
) STRICT;

CREATE TABLE digest_items (
  digest_id TEXT NOT NULL REFERENCES digests(id),
  ordinal INTEGER NOT NULL,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
  PRIMARY KEY (digest_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('done','snooze','skip','dismiss','wrong','why','draft','undo','acted','open',
    'seen','mute','up','down')),
  payload TEXT CHECK (json_valid(payload)),
  channel TEXT NOT NULL CHECK (channel IN ('imessage','web','push','system')),
  inbound_command_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX feedback_sugg ON feedback(suggestion_id);

-- Thompson-sampling arms: arm_key e.g. 'kind:fading', 'kind:fading|tier:close', 'person:<id>', 'wild:memory'
CREATE TABLE learner_arms (
  arm_key TEXT PRIMARY KEY,
  alpha REAL NOT NULL CHECK (alpha > 0),
  beta REAL NOT NULL CHECK (beta > 0),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE suggestion_outcomes (
  id INTEGER PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
  reward REAL NOT NULL CHECK (reward BETWEEN 0 AND 1),
  weight REAL NOT NULL CHECK (weight >= 0),
  source TEXT NOT NULL,               -- explicit | implicit | open | ignored | wildcard
  decided_at INTEGER NOT NULL,
  UNIQUE (suggestion_id, source)
) STRICT;

-- Per-person ignore cooldowns (7 d × 2^ignores, cap 90 d) and hard mutes ("never suggest X").
CREATE TABLE learner_person_state (
  person_id TEXT PRIMARY KEY,
  consecutive_ignores INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1)),
  muted_kinds TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(muted_kinds)),
  updated_at INTEGER NOT NULL
) STRICT;

-- ============================================================================================
-- messaging the user (S)
-- ============================================================================================
CREATE TABLE outbound_messages (
  id TEXT PRIMARY KEY,
  client_ref TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('digest','reply','alert','brief','answer','heartbeat','test')),
  to_handle TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sending','delivered','sent','unverified','ghost','failed')),
  message_guids TEXT CHECK (json_valid(message_guids)),
  collector_result TEXT CHECK (json_valid(collector_result)),
  digest_id TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
) STRICT;
CREATE INDEX outbound_time ON outbound_messages(created_at DESC);

CREATE TABLE outbound_guids (
  guid TEXT PRIMARY KEY,
  outbound_id TEXT NOT NULL REFERENCES outbound_messages(id)
) STRICT;

CREATE TABLE inbound_commands (
  id TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
  raw_text TEXT NOT NULL,
  target_digest_id TEXT,
  intent TEXT,
  parsed TEXT CHECK (json_valid(parsed)),
  status TEXT NOT NULL CHECK (status IN ('pending','handled','error','ignored','seen_late','clarifying')),
  response_outbound_id TEXT,
  batch_id TEXT,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
) STRICT;
CREATE INDEX inbound_status ON inbound_commands(status, created_at);

-- ============================================================================================
-- LLM pipeline (S)
-- ============================================================================================
CREATE TABLE windows (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  mode TEXT NOT NULL CHECK (mode IN ('steady','historical','consolidate')),
  from_msg INTEGER NOT NULL,
  to_msg INTEGER NOT NULL,
  context_from_msg INTEGER,
  wave INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','triaged_out','submitted','applied','refused','dead_letter','carried_over','split')),
  attempts INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER,
  prompt_version TEXT,
  last_custom_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, mode, from_msg, to_msg)
) STRICT;
CREATE INDEX windows_status ON windows(status, conversation_id);

CREATE TABLE llm_batches (
  id TEXT PRIMARY KEY,                -- Anthropic batch id
  run_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  submitted_at INTEGER,
  ended_at INTEGER,
  results_fetched_at INTEGER,
  usage TEXT CHECK (json_valid(usage)),
  cost_usd REAL
) STRICT;

-- custom_id = {kind}{ver}-{window36}-{attempt}; written BEFORE the HTTP submit.
CREATE TABLE llm_requests (
  custom_id TEXT PRIMARY KEY CHECK (length(custom_id) BETWEEN 1 AND 64 AND custom_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  batch_id TEXT,
  window_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('extract','historical','consolidate','tiebreak','digest','ask','command',
    'circle_name','brief','calendar','intent')),
  subject_ref TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','submitted','succeeded','refused','errored','expired','max_tokens',
    'schema_invalid','applied','rejected','dead_letter')),
  stop_reason TEXT,
  served_by_model TEXT,
  output TEXT,                        -- purged after 30 days
  usage TEXT CHECK (json_valid(usage)),
  cost_usd REAL,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  purged_at INTEGER
) STRICT;
CREATE INDEX llm_req_batch ON llm_requests(batch_id, status);
CREATE INDEX llm_req_input ON llm_requests(kind, input_hash);

-- Local only, never sent: token (P17, H3, …) ↔ person/identity
CREATE TABLE pseudonyms (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, ref_id)
) STRICT;

-- ============================================================================================
-- ops (S; settings J)
-- ============================================================================================
CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  run_id TEXT,
  scheduled_for INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error','skipped','partial','abandoned')),
  trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual','boot')),
  lease_expires_at INTEGER,
  stats TEXT CHECK (json_valid(stats)),
  error_class TEXT,
  error_message TEXT                  -- redacted
) STRICT;
CREATE INDEX job_runs_job ON job_runs(job, started_at DESC);
CREATE INDEX job_runs_running ON job_runs(status) WHERE status = 'running';

CREATE TABLE job_state (
  job TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_success_local_date TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT,
  next_due_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1))
) STRICT;

CREATE TABLE source_cursors (
  source TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  cursor TEXT NOT NULL,
  high_water_at INTEGER,
  meta TEXT CHECK (json_valid(meta)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, scope)
) STRICT, WITHOUT ROWID;

CREATE TABLE source_health (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok','stale','error','auth_required','contract_broken','disabled','unknown')),
  last_ok_at INTEGER,
  newest_data_at INTEGER,
  last_error TEXT,
  details TEXT CHECK (json_valid(details)),
  checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  message TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_notified_at INTEGER,
  resolved_at INTEGER
) STRICT;
CREATE UNIQUE INDEX alerts_open ON alerts(source) WHERE resolved_at IS NULL;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Values are JSON. User edits are journaled.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- AES-256-GCM, key = SECRETS_KEY (.env); AAD = name
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- ============================================================================================
-- full-text search (FTS5). External content only on INTEGER-rowid tables; rebuild after any restore:
--   INSERT INTO messages_fts(messages_fts) VALUES('rebuild');  (same for facts_fts, notes_fts)
-- ============================================================================================
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.text IS NOT NULL BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages WHEN old.text IS NOT NULL BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) SELECT 'delete', old.id, old.text WHERE old.text IS NOT NULL;
  INSERT INTO messages_fts(rowid, text) SELECT new.id, new.text WHERE new.text IS NOT NULL;
END;

CREATE VIRTUAL TABLE facts_fts USING fts5(value, content='facts', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER facts_fts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, value) VALUES (new.seq, new.value);
END;
CREATE TRIGGER facts_fts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, value) VALUES ('delete', old.seq, old.value);
END;
CREATE TRIGGER facts_fts_au AFTER UPDATE OF value ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, value) VALUES ('delete', old.seq, old.value);
  INSERT INTO facts_fts(rowid, value) VALUES (new.seq, new.value);
END;

CREATE VIRTUAL TABLE notes_fts USING fts5(content, content='notes', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE OF content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  INSERT INTO notes_fts(rowid, content) VALUES (new.seq, new.content);
END;

-- App-maintained (one row per canonical person); trigram so partial names match.
CREATE VIRTUAL TABLE people_fts USING fts5(person_id UNINDEXED, names, aliases, org, places, tokenize='trigram remove_diacritics 1');

-- ============================================================================================
-- views
-- ============================================================================================
-- THE visibility chokepoint: canonical, not hidden, not merged, real people. Provisional people (new handles,
-- intelligence §1.4) are visible and linkable; callers use status to group them under "New people". Roster-only,
-- service and suppressed rows never are. Hidden people appear only in Settings → Hidden, which reads people directly.
CREATE VIEW person_visible AS
  SELECT p.* FROM people p
  WHERE p.kind = 'person'
    AND p.status IN ('active', 'provisional')
    AND p.merged_into_id IS NULL
    AND p.is_hidden = 0;
`;
