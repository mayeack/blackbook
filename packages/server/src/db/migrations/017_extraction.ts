/**
 * LLM extraction bookkeeping (PLAN "LLM extraction", intelligence §4; owner: extraction/).
 *
 *   extraction_conv_state (S) per conversation: where steady-state extraction starts (`steady_since_at`; older
 *                         messages are the one-time historical backfill's) and when the backfill finished it.
 *   extraction_coverage  (S) which window owns each message as NEW. A message is covered by exactly one window
 *                         (pending, submitted, applied, refused, dead-lettered or triaged out), so late arrivals,
 *                         overflow waves and splits never re-extract or skip a message. Carried-over windows give
 *                         their messages back.
 *   extraction_packets   (S) the packet a window was sent with: the pseudonymized user turn (for requeues and the
 *                         synchronous refusal re-run), the local ref maps (m:N → message, P… → person, F…/K… →
 *                         fact/commitment) and the line texts AS SENT (the quote check runs against those).
 *                         user_text is purged 30 days after apply.
 *   extraction_batches   (S) Message Batches this module submitted (purpose extract / historical / consolidate).
 *   extraction_items     (S) one row per custom_id (results arrive in any order; never rely on position); a
 *                         consolidation item keeps its request (alias map + user turn) in `payload`.
 *   extraction_backfill  (S) the one-time historical backfill run (its own budget pool).
 *   conversation_topics  (D) 0–5 search tags per window, aggregated per conversation (Ask / search).
 *   person_summaries     (D) the consolidation pass's 2-sentence person summary.
 *   windows gains an index on last_custom_id.
 * (needs_reply verdicts live in the obligations module's reply_verdicts; commitments in its commitments columns.)
 */
export const sql = /* sql */ `
CREATE TABLE extraction_conv_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  steady_since_at INTEGER NOT NULL,
  backfill_done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE extraction_coverage (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  window_id TEXT NOT NULL REFERENCES windows(id),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ecov_window ON extraction_coverage(window_id);

CREATE TABLE extraction_packets (
  window_id TEXT PRIMARY KEY REFERENCES windows(id),
  mode TEXT NOT NULL CHECK (mode IN ('steady','historical')),
  packet TEXT NOT NULL CHECK (json_valid(packet)),
  user_text TEXT,
  token_estimate INTEGER NOT NULL,
  result TEXT CHECK (json_valid(result)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  purged_at INTEGER
) STRICT;

CREATE TABLE extraction_batches (
  batch_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('extract','historical','consolidate')),
  wave INTEGER NOT NULL DEFAULT 1,
  night TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','collected')),
  item_count INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  ended_at INTEGER,
  collected_at INTEGER,
  stats TEXT CHECK (json_valid(stats))
) STRICT;
CREATE INDEX eb_status ON extraction_batches(status, submitted_at);

CREATE TABLE extraction_items (
  custom_id TEXT PRIMARY KEY,
  batch_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('extract','historical','consolidate')),
  window_id TEXT REFERENCES windows(id),
  person_id TEXT,
  backfill_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_tokens INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','applied','refused','requeued','retry_later','dead_letter','invalid','skipped')),
  outcome TEXT,
  payload TEXT CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((window_id IS NULL) <> (person_id IS NULL))
) STRICT;
CREATE INDEX ei_batch ON extraction_items(batch_id, status);
CREATE INDEX ei_window ON extraction_items(window_id);
CREATE INDEX ei_person ON extraction_items(person_id, status) WHERE person_id IS NOT NULL;

CREATE INDEX windows_custom_id ON windows(last_custom_id) WHERE last_custom_id IS NOT NULL;

CREATE TABLE extraction_backfill (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','consolidating','done','budget_exhausted','cancelled')),
  through_at INTEGER NOT NULL,
  run_id TEXT,
  stats TEXT CHECK (json_valid(stats)),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE UNIQUE INDEX ebf_one_active ON extraction_backfill(status) WHERE status IN ('running','consolidating');

CREATE TABLE conversation_topics (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  topic TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  PRIMARY KEY (conversation_id, topic)
) STRICT, WITHOUT ROWID;
CREATE INDEX ctopic_topic ON conversation_topics(topic);

CREATE TABLE person_summaries (
  person_id TEXT PRIMARY KEY REFERENCES people(id),
  summary TEXT NOT NULL,
  fact_count INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;
