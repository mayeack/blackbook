/**
 * Address-book ingest and the probabilistic identity matcher (intelligence §1.2, §1.5–1.6).
 *
 * addressbook_cards (S): one row per Contacts card the collector has returned. content_hash drives the hourly
 * diff (only changed cards are re-applied, so undoing an agent change sticks until the card itself changes);
 * `fields` keeps the parsed display fields so a person backed by several cards can pick its primary card;
 * removed_at marks a card that left the dump (its addressbook_id identity is then detached, journaled).
 *
 * match_candidates gains the per-feature weights (bits, for "why" and the future LLM tie-break) and the time of
 * the last nightly scoring.
 */
export const sql = /* sql */ `
CREATE TABLE addressbook_cards (
  card_id TEXT PRIMARY KEY,
  identity_id TEXT REFERENCES identities(id),
  content_hash TEXT NOT NULL,
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  modified_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  removed_at INTEGER
) STRICT;
CREATE INDEX abc_identity ON addressbook_cards(identity_id);

ALTER TABLE match_candidates ADD COLUMN features TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(features));
ALTER TABLE match_candidates ADD COLUMN scored_at INTEGER;
CREATE INDEX mc_b ON match_candidates(b_id);
`;
