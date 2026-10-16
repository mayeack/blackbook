/**
 * Pair aggregation (intelligence §2 "Aggregation"): every edge_evidence row (all writers) plus the relation labels
 * in edge_labels → one entry per canonical pair: per-type weight / count / latest time, W, strength, tier and the
 * dominant type. Rebuilt from timestamps on every run, so decay just falls out of the recompute.
 *
 * Pairs are canonical (person_canon; a merge folds its evidence into the survivor), both ends real people
 * (kind person, active / provisional / roster-only, not hidden): the owner, hidden, service and suppressed people
 * never get an edge. Sticky "wrong"s (edge_labels label 'evidence:<type>' or 'evidence:*' with status 'active' =
 * block in force; an undo tombstones it to 'rejected') drop that evidence for the pair. Written to edge_stats (D) by writeEdgeStats.
 */
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import {
  CLOSE_LABELS,
  contribution,
  EVIDENCE_BLOCK_PREFIX,
  LABEL_WEIGHTS,
  labelFamily,
  ROSTER_FACTOR,
  strengthOf,
  tierOf,
  TYPE_CAPS,
  type EdgeTierName,
} from './weights';

const PAGE = 5000;
/** Pairs weaker than this aren't stored. */
export const MIN_STORED_STRENGTH = 0.01;

export interface TypeAgg {
  w: number;
  n: number;
  last: number | null;
}

export interface PairAgg {
  a: string;
  b: string;
  byType: Record<string, TypeAgg>;
  /** Σ weight of family / partner / roommate labels (circle detection uses only those labels). */
  closeLabelW: number;
  weight: number;
  strength: number;
  tier: EdgeTierName;
  dominant: string | null;
  last: number | null;
  evidenceCount: number;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface EdgeContext {
  canon: Map<string, string>;
  /** eligible canonical person → is roster-only */
  eligible: Map<string, boolean>;
}

export function loadEdgeContext(db: DB): EdgeContext {
  const canon = new Map(db.prepare('SELECT person_id, canonical_id FROM person_canon').raw().all() as [string, string][]);
  const eligible = new Map<string, boolean>();
  for (const [id, status] of db
    .prepare(
      `SELECT id, status FROM people WHERE kind = 'person' AND status IN ('active','provisional','roster_only')
       AND merged_into_id IS NULL AND is_hidden = 0`,
    )
    .raw()
    .all() as [string, string][]) {
    eligible.set(id, status === 'roster_only');
  }
  return { canon, eligible };
}

/** Finishes per-type sums into the pair's totals (caps, roster factor, blocks). */
export function finishPair(p: PairAgg, roster: boolean, blocked: Set<string> | undefined): PairAgg {
  if (blocked?.has('*')) p.byType = {};
  let W = 0;
  let dominant: string | null = null;
  let best = 0;
  let last: number | null = null;
  let count = 0;
  for (const [type, t] of Object.entries(p.byType)) {
    if (blocked?.has(type)) {
      delete p.byType[type];
      continue;
    }
    let w = Math.min(t.w, TYPE_CAPS[type] ?? Infinity);
    if (roster) w *= ROSTER_FACTOR;
    t.w = r4(w);
    if (t.w <= 0) {
      delete p.byType[type];
      continue;
    }
    W += t.w;
    count += t.n;
    if (t.w > best || (t.w === best && dominant !== null && type < dominant)) {
      best = t.w;
      dominant = type;
    }
    if (t.last !== null && (last === null || t.last > last)) last = t.last;
  }
  if (blocked?.has('*') || blocked?.has('label')) p.closeLabelW = 0;
  else if (roster) p.closeLabelW *= ROSTER_FACTOR;
  p.weight = r4(W);
  p.strength = r4(strengthOf(W));
  p.tier = tierOf(p.strength);
  p.dominant = dominant;
  p.last = last;
  p.evidenceCount = count;
  return p;
}

/** Aggregates all evidence and labels (one page of evidence per step). */
export function* aggregateEdges(db: DB, now: number, ctx: EdgeContext = loadEdgeContext(db)): Generator<void, Map<string, PairAgg>> {
  const pairs = new Map<string, PairAgg>();
  const resolve = (id: string): string | null => {
    const c = ctx.canon.get(id) ?? id;
    return ctx.eligible.has(c) ? c : null;
  };
  const get = (x: string, y: string): PairAgg => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const k = `${a}|${b}`;
    let p = pairs.get(k);
    if (!p) pairs.set(k, (p = { a, b, byType: {}, closeLabelW: 0, weight: 0, strength: 0, tier: 'faint', dominant: null, last: null, evidenceCount: 0 }));
    return p;
  };
  const add = (p: PairAgg, type: string, w: number, at: number | null) => {
    if (!(w > 0)) return;
    const t = (p.byType[type] ??= { w: 0, n: 0, last: null });
    t.w += w;
    t.n++;
    if (at !== null && (t.last === null || at > t.last)) t.last = at;
  };

  // labels: relation weights and sticky evidence blocks
  const blocks = new Map<string, Set<string>>();
  const labels = db.prepare('SELECT a_id, b_id, label, status, confidence FROM edge_labels').all() as {
    a_id: string;
    b_id: string;
    label: string;
    status: string;
    confidence: number;
  }[];
  for (const l of labels) {
    const a = resolve(l.a_id);
    const b = resolve(l.b_id);
    if (!a || !b || a === b) continue;
    if (l.label.startsWith(EVIDENCE_BLOCK_PREFIX)) {
      if (l.status !== 'active') continue;
      const k = pairKey(a, b);
      let s = blocks.get(k);
      if (!s) blocks.set(k, (s = new Set()));
      s.add(l.label.slice(EVIDENCE_BLOCK_PREFIX.length) || '*');
      continue;
    }
    if (l.status !== 'active') continue;
    const conf = Math.min(1, Math.max(0, l.confidence));
    const p = get(a, b);
    if (l.label === 'met_via') {
      add(p, 'met_via', 2 * conf, null);
      continue;
    }
    const family = labelFamily(l.label);
    const w = (LABEL_WEIGHTS[family] ?? 0) * conf;
    add(p, 'label', w, null);
    if (CLOSE_LABELS.has(family)) p.closeLabelW += w;
  }
  yield;

  const page = db.prepare('SELECT id, a_id, b_id, type, at, w_raw FROM edge_evidence WHERE id > ? ORDER BY id LIMIT ?');
  let cursor = 0;
  for (;;) {
    const rows = page.all(cursor, PAGE) as { id: number; a_id: string; b_id: string; type: string; at: number | null; w_raw: number }[];
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    for (const e of rows) {
      const a = resolve(e.a_id);
      const b = resolve(e.b_id);
      if (!a || !b || a === b) continue;
      add(get(a, b), e.type, contribution(e.type, e.w_raw, e.at, now), e.at);
    }
    yield;
  }

  for (const [k, p] of pairs) {
    finishPair(p, ctx.eligible.get(p.a) === true || ctx.eligible.get(p.b) === true, blocks.get(k));
    if (!Object.keys(p.byType).length) pairs.delete(k);
  }
  return pairs;
}

export interface EdgeStatsWrite {
  upserted: number;
  deleted: number;
  stored: number;
}

/** Makes edge_stats equal the aggregated pairs (strength ≥ MIN_STORED_STRENGTH), only rewriting changed rows. */
export function* writeEdgeStats(db: DB, pairs: Map<string, PairAgg>, now: number, stepRows = 2000): Generator<void, EdgeStatsWrite> {
  const out: EdgeStatsWrite = { upserted: 0, deleted: 0, stored: 0 };
  const existing = new Map(
    (
      db.prepare('SELECT a_id, b_id, weight, strength, tier, dominant_type, evidence_count, last_at, types, breakdown FROM edge_stats').all() as {
        a_id: string;
        b_id: string;
        weight: number;
        strength: number;
        tier: string;
        dominant_type: string | null;
        evidence_count: number;
        last_at: number | null;
        types: string;
        breakdown: string;
      }[]
    ).map((r) => [`${r.a_id}|${r.b_id}`, r]),
  );
  const ops: (() => void)[] = [];
  const del = db.prepare('DELETE FROM edge_stats WHERE a_id = ? AND b_id = ?');
  const put = db.prepare(
    `INSERT INTO edge_stats (a_id, b_id, weight, strength, tier, dominant_type, evidence_count, last_at, computed_at, types, breakdown)
     VALUES (@a, @b, @weight, @strength, @tier, @dominant, @count, @last, @now, @types, @breakdown)
     ON CONFLICT (a_id, b_id) DO UPDATE SET weight = excluded.weight, strength = excluded.strength, tier = excluded.tier,
       dominant_type = excluded.dominant_type, evidence_count = excluded.evidence_count, last_at = excluded.last_at,
       computed_at = excluded.computed_at, types = excluded.types, breakdown = excluded.breakdown`,
  );
  for (const [k, p] of pairs) {
    if (p.strength < MIN_STORED_STRENGTH) continue;
    out.stored++;
    const types = Object.keys(p.byType).sort();
    const breakdown = JSON.stringify(Object.fromEntries(types.map((t) => [t, p.byType[t]])));
    const row = {
      a: p.a,
      b: p.b,
      weight: p.weight,
      strength: p.strength,
      tier: p.tier,
      dominant: p.dominant,
      count: p.evidenceCount,
      last: p.last,
      now,
      types: JSON.stringify(types),
      breakdown,
    };
    const cur = existing.get(k);
    existing.delete(k);
    if (
      cur &&
      cur.weight === row.weight &&
      cur.strength === row.strength &&
      cur.tier === row.tier &&
      cur.dominant_type === row.dominant &&
      cur.evidence_count === row.count &&
      cur.last_at === row.last &&
      cur.types === row.types &&
      cur.breakdown === row.breakdown
    ) {
      continue;
    }
    ops.push(() => (out.upserted += put.run(row).changes));
  }
  for (const r of existing.values()) ops.push(() => (out.deleted += del.run(r.a_id, r.b_id).changes));
  for (let i = 0; i < ops.length; i += stepRows) {
    const slice = ops.slice(i, i + stepRows);
    tx(db, () => slice.forEach((f) => f()));
    yield;
  }
  return out;
}

