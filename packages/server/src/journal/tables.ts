/**
 * Journaled tables (class J): every write goes through journal/batch.ts so it can be undone.
 * `onUndoInsert` says how an insert is reversed: tombstone (never delete people, identities, facts, …) or
 * delete (pure link and block rows). Columns in `volatile` are restored but ignored by conflict and
 * dependency checks: ingestion bumps them outside the journal.
 */
export interface JournaledTable {
  key: readonly string[];
  onUndoInsert: 'tombstone' | 'delete' | 'none';
  /** Patch that retires a row (status flags, retraction time). */
  tombstone?: (now: number) => Record<string, unknown>;
  volatile?: readonly string[];
}

const retracted = () => ({ status: 'retracted' });

export const JOURNALED: Readonly<Record<string, JournaledTable>> = {
  people: { key: ['id'], onUndoInsert: 'tombstone', tombstone: () => ({ status: 'suppressed' }) },
  identities: {
    key: ['id'],
    onUndoInsert: 'tombstone',
    tombstone: () => ({ status: 'detached' }),
    volatile: ['first_seen_at', 'last_seen_at'],
  },
  merges: { key: ['id'], onUndoInsert: 'tombstone', tombstone: (now) => ({ undone_at: now }) },
  do_not_merge: { key: ['a_id', 'b_id'], onUndoInsert: 'delete' },
  identity_blocks: { key: ['kind', 'key', 'person_id'], onUndoInsert: 'delete' },
  facts: { key: ['id'], onUndoInsert: 'tombstone', tombstone: (now) => ({ status: 'rejected', retracted_at: now }) },
  fact_blocks: { key: ['person_id', 'type', 'value_norm'], onUndoInsert: 'delete' },
  edge_labels: { key: ['id'], onUndoInsert: 'tombstone', tombstone: () => ({ status: 'rejected' }) },
  commitments: { key: ['id'], onUndoInsert: 'tombstone', tombstone: retracted },
  reply_debts: { key: ['id'], onUndoInsert: 'tombstone', tombstone: retracted },
  circles: { key: ['id'], onUndoInsert: 'tombstone', tombstone: retracted },
  // excluded=1 is the sticky "not in this circle" block that auto-circles respect.
  circle_members: { key: ['circle_id', 'person_id'], onUndoInsert: 'tombstone', tombstone: () => ({ excluded: 1 }) },
  tags: { key: ['id'], onUndoInsert: 'tombstone', tombstone: retracted },
  person_tags: { key: ['person_id', 'tag_id'], onUndoInsert: 'delete' },
  locations: { key: ['id'], onUndoInsert: 'tombstone', tombstone: retracted },
  person_locations: { key: ['person_id', 'location_id'], onUndoInsert: 'delete' },
  notes: { key: ['id'], onUndoInsert: 'tombstone', tombstone: retracted },
  settings: { key: ['key'], onUndoInsert: 'delete' },
  event_attendees: { key: ['id'], onUndoInsert: 'tombstone', tombstone: () => ({ status: 'rejected' }) },
  interactions: { key: ['id'], onUndoInsert: 'tombstone', tombstone: (now) => ({ retracted_at: now }) },
};

/** Never compared by conflict/dependency checks (every journaled write bumps it). */
export const ALWAYS_VOLATILE = new Set(['updated_at']);

export function journaled(table: string): JournaledTable {
  const t = JOURNALED[table];
  if (!t) throw new Error(`${table} is not a journaled table`);
  return t;
}

export type RowKey = Record<string, unknown>;

/** Single-column keys are stored as the bare value; composite keys as a JSON array in key-column order. */
export function encodeKey(table: string, key: RowKey): string {
  const cols = journaled(table).key;
  const values = cols.map((c) => {
    const v = key[c];
    if (v === undefined || v === null) throw new Error(`${table}: key column ${c} is missing`);
    return v;
  });
  return cols.length === 1 ? String(values[0]) : JSON.stringify(values);
}

export function decodeKey(table: string, entityKey: string): RowKey {
  const cols = journaled(table).key;
  if (cols.length === 1) return { [cols[0]!]: entityKey };
  const values = JSON.parse(entityKey) as unknown[];
  return Object.fromEntries(cols.map((c, i) => [c, values[i]]));
}
