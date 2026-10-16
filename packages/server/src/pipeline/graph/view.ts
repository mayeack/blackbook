/**
 * Read helpers over edge_stats for other modules (person Connections tab, pair page, intros, Ask graph_neighbors),
 * and the one write other modules may need: a sticky "wrong" on a pair's evidence.
 *
 * Ids are canonical person ids; edge_stats never holds the owner, hidden, merged-away or service people.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import type { JournalTx } from '../../journal/batch';
import type { TypeAgg } from './aggregate';
import { evidenceBlockLabel, type EdgeTierName } from './weights';

export interface EdgeView {
  a: string;
  b: string;
  weight: number;
  strength: number;
  tier: EdgeTierName;
  dominantType: string | null;
  types: string[];
  /** Per evidence type: weight after decay/caps, evidence rows, latest time. */
  breakdown: Record<string, TypeAgg>;
  evidenceCount: number;
  lastAt: number | null;
}

interface Row {
  a_id: string;
  b_id: string;
  weight: number;
  strength: number;
  tier: EdgeTierName;
  dominant_type: string | null;
  types: string;
  breakdown: string;
  evidence_count: number;
  last_at: number | null;
}

const toView = (r: Row): EdgeView => ({
  a: r.a_id,
  b: r.b_id,
  weight: r.weight,
  strength: r.strength,
  tier: r.tier,
  dominantType: r.dominant_type,
  types: JSON.parse(r.types) as string[],
  breakdown: JSON.parse(r.breakdown) as Record<string, TypeAgg>,
  evidenceCount: r.evidence_count,
  lastAt: r.last_at,
});

/** The aggregated edge between two canonical people, or null. */
export function readEdge(db: DB, x: string, y: string): EdgeView | null {
  const [a, b] = x < y ? [x, y] : [y, x];
  const r = db.prepare('SELECT * FROM edge_stats WHERE a_id = ? AND b_id = ?').get(a, b) as Row | undefined;
  return r ? toView(r) : null;
}

/** A person's edges (strongest first), visible neighbors only. */
export function neighborEdges(db: DB, personId: string, o: { minStrength?: number; limit?: number } = {}): EdgeView[] {
  return (
    db
      .prepare(
        `SELECT e.* FROM edge_stats e
         JOIN person_visible v ON v.id = CASE WHEN e.a_id = @p THEN e.b_id ELSE e.a_id END
         WHERE (e.a_id = @p OR e.b_id = @p) AND e.strength >= @min
         ORDER BY e.strength DESC, v.id LIMIT @limit`,
      )
      .all({ p: personId, min: o.minStrength ?? 0, limit: o.limit ?? 200 }) as Row[]
  ).map(toView);
}

export interface PairEvidenceRow {
  type: string;
  /** 'conv:<id>' | 'event:<id>' | 'occ:<id>' | 'm:<id>' | 'legacy' */
  ref: string;
  at: number | null;
  wRaw: number;
  /** Directed types (invited_by, plus_one): the canonical "from" person; null for undirected ones. */
  from: string | null;
}

/**
 * The raw evidence between two canonical people (every merged-in id included), newest first: chips ("11 shared
 * group chats"), the pair page timeline. Blocked ("wrong") types are left out.
 */
export function pairEvidence(db: DB, x: string, y: string, limit = 500): PairEvidenceRow[] {
  const cluster = (id: string) => {
    const ids = db.prepare('SELECT person_id FROM person_canon WHERE canonical_id = ?').pluck().all(id) as string[];
    return ids.includes(id) ? ids : [id, ...ids];
  };
  const cx = cluster(x);
  const cy = cluster(y);
  const [a, b] = x < y ? [x, y] : [y, x];
  const blocked = new Set(
    (db.prepare(`SELECT label FROM edge_labels WHERE a_id = ? AND b_id = ? AND status = 'active' AND label LIKE 'evidence:%'`).pluck().all(a, b) as string[]).map((l) =>
      l.slice('evidence:'.length),
    ),
  );
  if (blocked.has('*')) return [];
  const rows = db
    .prepare(
      `SELECT type, ref, at, w_raw, directed, a_id FROM edge_evidence
       WHERE (a_id IN (SELECT value FROM json_each(@x)) AND b_id IN (SELECT value FROM json_each(@y)))
          OR (a_id IN (SELECT value FROM json_each(@y)) AND b_id IN (SELECT value FROM json_each(@x)))
       ORDER BY at DESC, id DESC LIMIT @limit`,
    )
    .all({ x: JSON.stringify(cx), y: JSON.stringify(cy), limit }) as { type: string; ref: string; at: number | null; w_raw: number; directed: number; a_id: string }[];
  return rows
    .filter((r) => !blocked.has(r.type))
    .map((r) => ({ type: r.type, ref: r.ref, at: r.at, wRaw: r.w_raw, from: r.directed ? (cx.includes(r.a_id) ? x : y) : null }));
}

/**
 * Records a sticky "wrong" on one evidence type between two people (`'*'`: they don't know each other): an
 * edge_labels row with label 'evidence:<type>' and status 'active' (= the block is in force), written in the
 * caller's journal batch. The aggregation drops that evidence on every later run; undoing the batch tombstones the
 * row (status 'rejected' = block lifted). Returns false if it was already blocked. edge_stats follows on the next
 * graph run (or call refreshEdgeStats).
 */
export function rejectEdgeEvidence(t: JournalTx, x: string, y: string, type: string | '*', origin: 'user' | 'llm' = 'user'): boolean {
  if (x === y) throw new Error('an edge needs two different people');
  const [a, b] = x < y ? [x, y] : [y, x];
  const label = evidenceBlockLabel(type);
  if (label.length > 40) throw new Error('evidence type too long');
  const cur = t.db.prepare('SELECT id, status FROM edge_labels WHERE a_id = ? AND b_id = ? AND label = ?').get(a, b, label) as
    | { id: string; status: string }
    | undefined;
  if (cur) return cur.status === 'active' ? false : t.update('edge_labels', { id: cur.id }, { status: 'active' });
  t.insert('edge_labels', { id: uuidv7(t.now), a_id: a, b_id: b, label, directed: 0, confidence: 1, status: 'active', origin });
  return true;
}
