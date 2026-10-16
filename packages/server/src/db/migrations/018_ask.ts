/**
 * Ask your network (PLAN "Ask your network", intelligence §7): conversation history, the retrieval indexes Ask
 * maintains, and the stable short ids it cites.
 *
 *   - ask_conversations / ask_turns (S): the owner's questions and the answers (web and iMessage `?`). Answers are
 *     stored de-tokenized for display (`answer`) and as the model wrote them with only valid citation ids left
 *     (`model_answer`, pseudonym tokens intact) so a follow-up can replay the thread without re-identifying anyone.
 *     Never journaled: Ask is read-only and writes nothing the agent could undo.
 *   - ask_fts_docs (D): an INTEGER surrogate `n` per indexed person / occasion / Partiful event. `n` is the rowid
 *     of the person's people_fts row and of the event's ask_events_fts row (the "INTEGER rowid" rule: FTS
 *     rows on TEXT-keyed tables are addressed through it), and it is the stable event citation id E<base36 n>.
 *     Rows are never deleted, so a cited E id keeps pointing at the same happening.
 *   - ask_events_fts (D): trigram index over occasion / Partiful event titles and venues (app-maintained, like
 *     people_fts in 001). Both are refreshed lazily before a search (ask/fts.ts), incrementally by watermark with a
 *     periodic full rebuild; rebuild after a restore by clearing ask_index_state.
 *   - ask_index_state (S): refresh watermarks per index.
 *
 * messages_fts and facts_fts (001) are used as they are: external content on INTEGER rowids (messages.id,
 * facts.seq), kept in sync by triggers.
 */
export const sql = /* sql */ `
CREATE TABLE ask_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web','imessage')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ask_conv_updated ON ask_conversations(updated_at DESC);

CREATE TABLE ask_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ask_conversations(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  channel TEXT NOT NULL CHECK (channel IN ('web','imessage')),
  question TEXT NOT NULL,
  answer TEXT,
  model_answer TEXT,
  citations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations) AND json_type(citations) = 'array'),
  people TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(people) AND json_type(people) = 'array'),
  -- every citation id a tool returned in this turn (valid for follow-ups in the same conversation)
  citable_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citable_ids) AND json_type(citable_ids) = 'array'),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error','degraded')),
  degraded_reason TEXT,
  error_code TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  -- citation ids the model wrote that no tool returned (stripped)
  violations INTEGER NOT NULL DEFAULT 0,
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  cost_usd REAL,
  llm_request TEXT,
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (conversation_id, seq)
) STRICT;
CREATE INDEX ask_turns_created ON ask_turns(created_at DESC);

CREATE TABLE ask_fts_docs (
  n INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person','occasion','event')),
  ref_id TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0 CHECK (indexed IN (0,1)),
  indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, ref_id)
) STRICT;

CREATE VIRTUAL TABLE ask_events_fts USING fts5(title, place, tokenize='trigram remove_diacritics 1');

CREATE TABLE ask_index_state (
  name TEXT PRIMARY KEY CHECK (name IN ('people','events')),
  watermark INTEGER NOT NULL,
  full_at INTEGER NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;
`;
