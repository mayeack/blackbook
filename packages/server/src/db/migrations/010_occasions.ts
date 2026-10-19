/**
 * Calendar occasions and deterministic attendee inference (PLAN "Calendar attendee inference", pipeline/occasions).
 *   - occasions gain a pointer merge (merged_into_id: two occasions that turn out to be one happening keep their
 *     ids, so journaled attendee rows never dangle), the calendar treatment they came from, the rule that
 *     classified them, and inference bookkeeping.
 *   - occasion_candidates (D): every attendee candidate with its signals and evidence message ids, resolved or not.
 *     Rebuilt per occasion on each run; it is the packet the later LLM adjudication step reads.
 *   - event_attendees widens two CHECKs (rebuilt in up(), whatever earlier migrations made of the table):
 *     source + 'inferred' | 'calendar_explicit' | 'calendar_text', status + 'withdrawn' (the agent retracting its own
 *     inference; 'rejected' stays the user's sticky block).
 */
import type { DB } from '../connection';

export const sql = /* sql */ `
ALTER TABLE occasions ADD COLUMN merged_into_id TEXT REFERENCES occasions(id);
ALTER TABLE occasions ADD COLUMN calendar_treatment TEXT CHECK (calendar_treatment IN ('attending','feed','candidate'));
ALTER TABLE occasions ADD COLUMN classification_rule TEXT;
ALTER TABLE occasions ADD COLUMN candidate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE occasions ADD COLUMN inferred_at INTEGER;
CREATE INDEX occ_live ON occasions(starts_at) WHERE merged_into_id IS NULL;
CREATE INDEX occ_merged ON occasions(merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX occ_event ON occasions(event_id) WHERE event_id IS NOT NULL;

-- (D) cand_key: 'p:<person id>' (resolved) | 'n:<normalized name>' (unresolved / ambiguous) | 'g:<circle or conversation id>'
CREATE TABLE occasion_candidates (
  occasion_id TEXT NOT NULL REFERENCES occasions(id),
  cand_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person','name','group')),
  person_id TEXT REFERENCES people(id),
  surface TEXT,                        -- the name as written in the owner's calendar (local only)
  role TEXT,
  score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
  signals TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(signals)),
  alternatives TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (occasion_id, cand_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX occ_cand_person ON occasion_candidates(person_id) WHERE person_id IS NOT NULL;

CREATE INDEX inter_occasion ON interactions(occasion_id) WHERE occasion_id IS NOT NULL;
CREATE INDEX ee_ref ON edge_evidence(ref, type);
`;

export const rebuildsTables = true;

const WIDEN: Record<string, readonly string[]> = {
  source: ['inferred', 'calendar_explicit', 'calendar_text'],
  status: ['withdrawn'],
};

/** Adds `values` to the `CHECK (<column> IN (…))` list of a CREATE TABLE statement (no-op when present). */
export function widenCheck(ddl: string, column: string, values: readonly string[], table = 'event_attendees'): string {
  const re = new RegExp(String.raw`(CHECK\s*\(\s*${column}\s+IN\s*\()([^)]*)(\))`, 'i');
  const m = re.exec(ddl);
  if (!m) throw new Error(`${table}: no CHECK list for ${column}`);
  const present = new Set(m[2]!.split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
  const missing = values.filter((v) => !present.has(v));
  if (!missing.length) return ddl;
  return ddl.replace(re, (_all, open: string, list: string, close: string) => `${open}${list}, ${missing.map((v) => `'${v}'`).join(', ')}${close}`);
}

/** SQLite's 12-step rebuild of event_attendees with the widened CHECKs; its indexes and triggers are re-created. */
export function up(db: DB): void {
  const ddl = db.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'event_attendees'`).pluck().get() as string;
  let next = ddl;
  for (const [column, values] of Object.entries(WIDEN)) next = widenCheck(next, column, values);
  if (next === ddl) return;
  const dependents = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE tbl_name = 'event_attendees' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .pluck()
    .all() as string[];
  db.exec(next.replace(/^CREATE TABLE\s+("?)event_attendees\1/i, 'CREATE TABLE event_attendees_v10'));
  db.exec('INSERT INTO event_attendees_v10 SELECT * FROM event_attendees');
  db.exec('DROP TABLE event_attendees');
  db.exec('ALTER TABLE event_attendees_v10 RENAME TO event_attendees');
  for (const s of dependents) db.exec(s);
}
