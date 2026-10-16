/**
 * Staging for Partiful notification texts parsed out of chat.db (adapters/imessage/partifulTexts.ts). Class (D):
 * re-derivable from messages, so never journaled. One row per message; the Partiful API adapter and the
 * contract check ("a text names an event the API never returned") read it. Also adds the interactions-by-session
 * index the iMessage pipeline needs.
 */
export const sql = /* sql */ `
CREATE TABLE partiful_text_signals (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','rsvp','reminder','blast','host_rsvp','link','other')),
  event_id TEXT,                      -- partiful.com/e/<id>
  short_code TEXT,                    -- go.partiful.com/<code> (needs a redirect to resolve; never followed here)
  update_id TEXT,                     -- ?update=<id> on text-blast links
  title TEXT,
  inviter_name TEXT,
  guest_name TEXT,                    -- host-side "<guest> responded …"
  rsvp TEXT CHECK (rsvp IN ('invited','going','maybe','declined','waitlist')),
  venue TEXT,
  conversation_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  paired_message_id INTEGER,          -- the text row ↔ its separate link row
  parser_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pts_event ON partiful_text_signals(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX pts_conv_time ON partiful_text_signals(conversation_id, sent_at);

-- Derived interactions are rewritten per session (pipeline/interactions.ts); without this every re-derive scans.
CREATE INDEX inter_session ON interactions(session_id) WHERE session_id IS NOT NULL;
`;
