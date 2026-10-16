/**
 * iCloud syncs chat.db out of order: a tapback (or an inline reply) can get a lower ROWID than the message it
 * points at, so the ROWID-cursored ingest sees it first. Reactions whose target hasn't arrived wait here and are
 * resolved after every page (adapters/imessage/ingest.ts). Class (E): raw source rows, never journaled.
 */
export const sql = /* sql */ `
CREATE TABLE pending_reactions (
  source_reaction_id TEXT PRIMARY KEY,   -- the tapback's chat.db guid
  target_source_msg_id TEXT NOT NULL,    -- target guid with the p:N/ / bp: part prefix stripped
  actor_identity_id TEXT,
  is_from_me INTEGER NOT NULL,
  type TEXT NOT NULL,
  emoji TEXT,
  removal INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pending_reactions_target ON pending_reactions(target_source_msg_id);

-- Inline replies that arrived before their thread root are linked once the root lands.
CREATE INDEX msg_reply_unresolved ON messages(thread_root_source_id)
  WHERE reply_to_msg_id IS NULL AND thread_root_source_id IS NOT NULL;
`;
