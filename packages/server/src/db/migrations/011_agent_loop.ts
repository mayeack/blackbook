/**
 * Ties, graph and circles bookkeeping (intelligence §2, §3, §5 "Circles"; owner: pipeline/ties, pipeline/graph,
 * pipeline/circles). person_touch_days, person_stats, edge_evidence, edge_labels, edge_stats, circles and
 * circle_members already exist (001); this slot adds what the nightly/weekly passes need on top:
 *
 *   tie_stats_snapshot (D)  one row per (canonical person, local week starting Monday): tie strength T at the week's
 *                           end and the touch units of that week (Person → sparkline). The ties pass rewrites the
 *                           trailing 26 weeks from person_touch_days (only rows that changed) and keeps older rows,
 *                           so history survives later data loss; rows older than two years are pruned.
 *   person_stats            gains the share of conversations the owner starts, the fading severity the ranker reads,
 *                           total contact days, the first contact time, and the cold-start flag.
 *   edge_stats              gains the evidence types present and a per-type breakdown {type: {w, n, last}} so the
 *                           network view can filter by type / time window without re-aggregating, and chips can say
 *                           "11 shared group chats".
 *   circle_suggestions (D)  weekly community detection's "Suggested additions" per circle (auto or user): people the
 *                           detection puts with a circle who aren't members. Rebuilt every run.
 *   circle_auto_meta (S)    per auto circle: how its name was chosen (rule / llm / user) and from what, the detection
 *                           score, and when the community was last seen — never names or titles beyond the circle row.
 */
export const sql = /* sql */ `
CREATE TABLE tie_stats_snapshot (
  person_id TEXT NOT NULL,
  week TEXT NOT NULL CHECK (week GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  tie_strength REAL NOT NULL,
  units REAL NOT NULL,
  historical_strength REAL,
  state TEXT CHECK (state IN ('strong','steady','cooling','fading','dormant','new')),
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, week)
) STRICT, WITHOUT ROWID;
CREATE INDEX tss_week ON tie_stats_snapshot(week);

ALTER TABLE person_stats ADD COLUMN i_start_share REAL;
ALTER TABLE person_stats ADD COLUMN fading_severity REAL;
ALTER TABLE person_stats ADD COLUMN contact_days_total INTEGER;
ALTER TABLE person_stats ADD COLUMN first_contact_at INTEGER;
ALTER TABLE person_stats ADD COLUMN cold_start INTEGER NOT NULL DEFAULT 0 CHECK (cold_start IN (0,1));

ALTER TABLE edge_stats ADD COLUMN types TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(types));
ALTER TABLE edge_stats ADD COLUMN breakdown TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(breakdown));
CREATE INDEX es_strength ON edge_stats(strength DESC);
CREATE INDEX ee_type ON edge_evidence(type);

CREATE TABLE circle_suggestions (
  circle_id TEXT NOT NULL REFERENCES circles(id),
  person_id TEXT NOT NULL,
  score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
  reason TEXT NOT NULL CHECK (reason IN ('community','near_member')),
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (circle_id, person_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE circle_auto_meta (
  circle_id TEXT PRIMARY KEY REFERENCES circles(id),
  named_by TEXT NOT NULL CHECK (named_by IN ('rule','llm','user')),
  -- what the name came from: {"kind":"group"|"event"|"members","ref":"conv:<id>"|"event:<id>"|null}
  name_basis TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(name_basis)),
  llm_request TEXT,
  modularity REAL,
  core_size INTEGER NOT NULL DEFAULT 0,
  last_detected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;
