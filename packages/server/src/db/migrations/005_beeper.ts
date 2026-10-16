/**
 * Instagram (Beeper Desktop + "Download your information" export). The Beeper adapter itself needs no schema: its
 * per-chat state lives in source_cursors (source 'instagram', scope = chat id). The DYI importer adds:
 *   import_files       every file an importer looked at, keyed by content hash, so a re-dropped, renamed or touched
 *                      export is recognised without re-importing; (path, size, mtime) lets the hourly scan skip
 *                      hashing unchanged files. Importers never move or delete the owner's files.
 *   ig_dyi_threads     a DYI thread's mapping, decided once: onto a Beeper conversation (≥3 messages matched on ±2 s
 *                      and the same text hash, intelligence §1.1) or onto its own instagram_dyi conversation, so
 *                      re-imports and later exports land in the same place.
 *   instagram_follows  (E) followers / following from DYI exports, with their dates: me ↔ an instagram_username
 *                      identity (so it follows the identity through merges). Not an edge: edges are person ↔ person.
 */
export const sql = /* sql */ `
CREATE TABLE import_files (
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('imported','failed','ignored')),
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  stats TEXT CHECK (json_valid(stats)),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, sha256)
) STRICT, WITHOUT ROWID;
CREATE INDEX import_files_path ON import_files(source, path);

CREATE TABLE ig_dyi_threads (
  thread_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  matched INTEGER NOT NULL CHECK (matched IN (0,1)),
  votes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE instagram_follows (
  identity_id TEXT NOT NULL REFERENCES identities(id),
  direction TEXT NOT NULL CHECK (direction IN ('follower','following')),
  followed_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, direction)
) STRICT, WITHOUT ROWID;
`;
