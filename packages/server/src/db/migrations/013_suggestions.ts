/**
 * Suggestions stage + self-learning ranker bookkeeping (pipeline/suggestions; PLAN "Suggestions, self-learning and
 * wildcards"; intelligence §5). All tables here are class (S): plain writes, never journaled, free of names, titles
 * and message text (ids and numbers only).
 *
 * suggestions gains:
 *   subject_key      the generator's subject (dedupe_key = `${kind}:${subject_key}`)
 *   person_ids       every canonical person the item is about (primary first; intro pairs, memory attendees)
 *   evidence_ids     citation ids ('m:8812', 'F…', 'occ:…', 'K…', 'conv:…')
 *   time_critical    forced into the digest (pre-event within 36 h, travel within 48 h)
 *   rank_details     how the ranker treated it the last time it was ranked (adjustments, forced, merged items)
 *   selected_at      when the ranker last put it in a digest (the reward window starts at delivery, or here)
 *   digest_id        the digest that last carried it; showings = how many digests did
 *   last_seen_run    the suggestions run that last emitted it (candidates not re-emitted are superseded)
 *   decided_at       the reward window closed (acted, ignored, or explicit feedback)
 *
 * suggestion_outcomes gains the arms each outcome trained (with their weights), whether it is the suggestion's
 * effective outcome (one per suggestion: explicit > implicit > open > ignored; a stronger later one reverses the
 * weaker one's contribution exactly, since forgetting is linear) and when it was applied.
 *
 * New tables:
 *   suggestion_cooldowns   per-(person, kind) and per-subject cooldowns (showings, ×4 after a skip, fading mute)
 *   learner_arm_history    one daily snapshot of the kind/wildcard arms (the 14-day trend on "What I've learned")
 *   learner_arm_resets     when an arm was reset (older contributions are never reversed into it)
 *   learner_meta           small learner state (the adaptive item cap)
 *   digest_rankings        per-digest ranking record: RNG seed, cap, wildcard roll and pick, counts considered
 */
export const sql = /* sql */ `
ALTER TABLE suggestions ADD COLUMN subject_key TEXT;
ALTER TABLE suggestions ADD COLUMN person_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(person_ids) AND json_type(person_ids) = 'array');
ALTER TABLE suggestions ADD COLUMN evidence_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids) AND json_type(evidence_ids) = 'array');
ALTER TABLE suggestions ADD COLUMN time_critical INTEGER NOT NULL DEFAULT 0 CHECK (time_critical IN (0,1));
ALTER TABLE suggestions ADD COLUMN rank_details TEXT CHECK (json_valid(rank_details));
ALTER TABLE suggestions ADD COLUMN selected_at INTEGER;
ALTER TABLE suggestions ADD COLUMN digest_id TEXT;
ALTER TABLE suggestions ADD COLUMN showings INTEGER NOT NULL DEFAULT 0 CHECK (showings >= 0);
ALTER TABLE suggestions ADD COLUMN last_seen_run TEXT;
ALTER TABLE suggestions ADD COLUMN decided_at INTEGER;
CREATE INDEX sugg_undecided ON suggestions(selected_at) WHERE selected_at IS NOT NULL AND decided_at IS NULL;
CREATE INDEX sugg_dedupe ON suggestions(dedupe_key, created_at DESC);
CREATE INDEX sugg_kind_selected ON suggestions(kind, selected_at) WHERE selected_at IS NOT NULL;
CREATE INDEX sugg_created ON suggestions(created_at DESC, id DESC);

ALTER TABLE suggestion_outcomes ADD COLUMN effective INTEGER NOT NULL DEFAULT 1 CHECK (effective IN (0,1));
ALTER TABLE suggestion_outcomes ADD COLUMN arms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(arms) AND json_type(arms) = 'array');
ALTER TABLE suggestion_outcomes ADD COLUMN applied_at INTEGER;
CREATE INDEX outcome_decided ON suggestion_outcomes(decided_at);

-- scope: 'pk:<person id>|<kind>' (per person and kind) | 'subject:<dedupe key>' (circle-level items, intro pairs)
CREATE TABLE suggestion_cooldowns (
  scope TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('shown','dismissed','wrong','fading_mute','snoozed')),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sc_until ON suggestion_cooldowns(until);

CREATE TABLE learner_arm_history (
  arm_key TEXT NOT NULL,
  day TEXT NOT NULL,
  alpha REAL NOT NULL CHECK (alpha > 0),
  beta REAL NOT NULL CHECK (beta > 0),
  PRIMARY KEY (arm_key, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE learner_arm_resets (
  arm_key TEXT PRIMARY KEY,
  reset_at INTEGER NOT NULL
) STRICT;

CREATE TABLE learner_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE digest_rankings (
  digest_id TEXT PRIMARY KEY REFERENCES digests(id),
  local_date TEXT NOT NULL UNIQUE,
  run_id TEXT,
  seed INTEGER NOT NULL,
  cap INTEGER NOT NULL,
  wildcard_allowed INTEGER NOT NULL CHECK (wildcard_allowed IN (0,1)),
  wildcard_roll REAL,
  wildcard_suggestion_id TEXT,
  wildcard_generator TEXT,
  considered TEXT NOT NULL CHECK (json_valid(considered)),
  selected_count INTEGER NOT NULL,
  ranked_at INTEGER NOT NULL
) STRICT;
`;
