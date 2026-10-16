/**
 * Obligations (intelligence §5 "Reply debt", "Commitments"): the columns the hourly passes and the extraction hook
 * need on top of the 001 tables, plus the needs_reply verdict cache.
 *
 * commitments (J)
 *   origin      who made the row: 'llm' (extraction), 'user', 'command' (self-thread), 'agent', 'legacy' (old app
 *               reminders; the default so existing rows read as legacy)
 *   made_at     when the promise was made (the cited message's time; created_at is system time). Drives the vague
 *               "due after 21 days" rule and the auto-close window [made_at, due_end + 7 d]
 *   source_msg  the first cited message
 *   what_norm   normalized `what` tokens (dedup of repeated extractions)
 *   sensitive   never shown in iMessage or push
 * reply_debts (J)
 *   debt_msg         the message that needs the reply (last_inbound_msg is the latest inbound of the unanswered run)
 *   heuristic_score  h (0–1) of the debt message
 *   llm_state        the extraction verdict that decided it (null: heuristic only, shown as "likely")
 *   run_id           the pass that wrote it
 * reply_verdicts (S) — the extraction's `needs_reply` per window, written by recordNeedsReplyVerdict(); the hourly
 *   pass reads the newest verdict that covers a conversation's last inbound message. Never journaled (it is LLM
 *   output, like llm_requests); a verdict never holds message text.
 */
export const sql = /* sql */ `
ALTER TABLE commitments ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'
  CHECK (origin IN ('llm','user','command','agent','legacy'));
ALTER TABLE commitments ADD COLUMN made_at INTEGER;
ALTER TABLE commitments ADD COLUMN source_msg INTEGER;
ALTER TABLE commitments ADD COLUMN what_norm TEXT;
ALTER TABLE commitments ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0,1));
CREATE INDEX commit_conv ON commitments(conversation_id, status) WHERE conversation_id IS NOT NULL;

ALTER TABLE reply_debts ADD COLUMN debt_msg INTEGER;
ALTER TABLE reply_debts ADD COLUMN heuristic_score REAL;
ALTER TABLE reply_debts ADD COLUMN llm_state TEXT
  CHECK (llm_state IS NULL OR llm_state IN ('needs_reply','no_reply_needed','already_replied','n_a'));
ALTER TABLE reply_debts ADD COLUMN run_id TEXT;
CREATE INDEX debt_person ON reply_debts(person_id, status);

CREATE TABLE reply_verdicts (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  through_msg INTEGER NOT NULL,
  through_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('needs_reply','no_reply_needed','already_replied','n_a')),
  msg_id INTEGER,
  reason TEXT CHECK (reason IS NULL OR reason IN ('question','request','invitation','plan_confirm','emotional','other')),
  urgency TEXT NOT NULL CHECK (urgency IN ('low','normal','high')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  window_id TEXT,
  prompt_version TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, through_msg)
) STRICT, WITHOUT ROWID;
CREATE INDEX rv_conv_time ON reply_verdicts(conversation_id, through_at DESC);
`;
