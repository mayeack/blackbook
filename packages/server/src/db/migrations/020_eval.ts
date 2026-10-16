/**
 * 020 (owner: eval/): golden sets, labels and prompt-version shadow replays (intelligence §8, sizes scaled down
 * per critic §5). All (S) system tables, never journaled: they hold the owner's own judgements of his own data,
 * live only in the local database (never in git, never sent anywhere) and change nothing the agent does.
 *
 *   eval_items         one golden-set item: G1 extraction window · G2 identity pair · G3 reply-debt case frozen at
 *                      a fixed time · G4 Ask question. `predictions` is what the system said, SNAPSHOTTED when the
 *                      item was sampled (so later re-runs can't move the target); `payload` holds the refs needed
 *                      to render it (message ids, person ids, the window's lines as sent to the model for the
 *                      groundedness check and the shadow replay). One label per item, on the row (relabeling
 *                      replaces it). origin 'shadow' = a spot-check item a shadow run created for a diff.
 *   eval_sample_state  per set: when it was last sampled / topped up, the pool size and how many were added
 *                      (the web's lazy top-up runs at most hourly while a set is empty, daily while it is short).
 *   eval_shadow_runs   one prompt_version comparison: the candidate version + effort, the replay range, counts
 *                      and spend. Shadow replays never apply anything.
 *   eval_shadow_items  per (run, window): the replay outcome and both sides' keyed predictions (validated with the
 *                      extraction validator, never written to facts / commitments / verdicts).
 */
export const sql = /* sql */ `
CREATE TABLE eval_items (
  id TEXT PRIMARY KEY,
  set_name TEXT NOT NULL CHECK (set_name IN ('extraction','identity','reply_debt','ask')),
  -- 'win:<windowId>' | 'pair:<a>|<b>' | 'conv:<id>@<frozenAt>' | 'ask:<turnId>' | 'shadow:<runId>:<windowId>'
  subject_ref TEXT NOT NULL,
  stratum TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'sample' CHECK (origin IN ('sample','shadow')),
  shadow_run_id TEXT,
  title TEXT NOT NULL,
  frozen_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  predictions TEXT NOT NULL CHECK (json_valid(predictions) AND json_type(predictions) = 'array'),
  prompt_version TEXT,
  expected_person_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(expected_person_ids) AND json_type(expected_person_ids) = 'array'),
  label TEXT CHECK (label IS NULL OR json_valid(label)),
  labeled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (set_name, subject_ref),
  CHECK ((origin = 'shadow') = (shadow_run_id IS NOT NULL)),
  CHECK ((label IS NULL) = (labeled_at IS NULL))
) STRICT;
CREATE INDEX eval_items_list ON eval_items(set_name, id);
CREATE INDEX eval_items_shadow ON eval_items(shadow_run_id) WHERE shadow_run_id IS NOT NULL;

CREATE TABLE eval_sample_state (
  set_name TEXT PRIMARY KEY CHECK (set_name IN ('extraction','identity','reply_debt','ask')),
  sampled_at INTEGER NOT NULL,
  pool INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE eval_shadow_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'extraction' CHECK (kind IN ('extraction')),
  prompt_version TEXT NOT NULL,
  effort TEXT NOT NULL CHECK (effort IN ('low','medium','high')),
  -- 'code' = the extraction prompt in this build; 'file' = a candidate prompt read from a local file
  system_source TEXT NOT NULL CHECK (system_source IN ('code','file')),
  since_at INTEGER NOT NULL,
  through_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','partial','stopped')),
  stop_reason TEXT,
  counts TEXT CHECK (counts IS NULL OR json_valid(counts)),
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX eval_shadow_runs_started ON eval_shadow_runs(started_at DESC);

CREATE TABLE eval_shadow_items (
  run_id TEXT NOT NULL REFERENCES eval_shadow_runs(id),
  window_id TEXT NOT NULL,
  golden_item_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','refused','invalid','max_tokens','unavailable','no_input','excluded')),
  -- where the baseline came from: the stored model output re-validated, or what was applied (the database)
  baseline_source TEXT NOT NULL CHECK (baseline_source IN ('output','applied','none')),
  baseline_version TEXT,
  baseline TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(baseline)),
  shadow TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(shadow)),
  llm_request TEXT,
  cost_usd REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, window_id)
) STRICT, WITHOUT ROWID;
`;
