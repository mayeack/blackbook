/**
 * Self-thread command state (owner: commands builder; PLAN "Two-way texting", intelligence §6).
 *
 *   command_effects        one row per inbound command the executor started. `state` 'started' → 'done' is the
 *                          crash guard (a command whose effect row is still 'started' on the next pass was
 *                          interrupted and is never re-run). It also records what `undo` needs: the command's
 *                          run (journaled batches: log, pause/resume, wrong), extra batch ids written outside that
 *                          run, and the before-state of every suggestion the command gave feedback on.
 *   command_clarifications the "Sam R. or Sam K.? reply 1/2" state for ambiguous names (open for 1 h).
 *   command_more_items     `more` extends a digest's numbering: items 5, 6, 7 bind like digest_items rows.
 *   command_seen_reactions tapbacks on bot rows ("seen" only, never an action), recorded once each.
 *
 * Rate limits need no table: commands per hour come from inbound_commands.handled_at, outbound per hour from
 * outbound_messages.created_at.
 */
export const sql = /* sql */ `
CREATE TABLE command_effects (
  command_id TEXT PRIMARY KEY REFERENCES inbound_commands(id),
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started','done','failed')),
  -- the effect kind undo reverts: none (why/help/…), feedback, log, setting, mixed
  effect TEXT NOT NULL DEFAULT 'none' CHECK (effect IN ('none','feedback','log','setting','mixed')),
  run_id TEXT,
  batch_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(batch_ids)),
  -- [{id, status, snoozed_until, acted_at, cooldown_until, after_status}] before/after of each suggestion touched
  suggestions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(suggestions)),
  -- short ack line ("2 done (Sam R.)") reused by "Undid: …"; local only
  summary TEXT,
  acked_at INTEGER,
  undone_at INTEGER,
  undone_by_command_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cmd_effects_recent ON command_effects(effect, created_at DESC);

CREATE TABLE command_clarifications (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES inbound_commands(id),
  kind TEXT NOT NULL CHECK (kind IN ('log_person')),
  -- [{personId, label}] in the order offered (reply 1/2/3)
  options TEXT NOT NULL CHECK (json_valid(options) AND json_type(options) = 'array'),
  -- the pending log: kind, date, text, resolved people, remaining ambiguous mentions, facts
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','cancelled','expired','superseded')),
  expires_at INTEGER NOT NULL,
  resolved_by_command_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cmd_clar_open ON command_clarifications(status, expires_at);

CREATE TABLE command_more_items (
  digest_id TEXT NOT NULL REFERENCES digests(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (digest_id, ordinal),
  UNIQUE (digest_id, suggestion_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE command_seen_reactions (
  source_reaction_id TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL,
  digest_id TEXT,
  seen_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
`;
