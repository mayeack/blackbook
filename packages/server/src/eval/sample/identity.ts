/**
 * G2 identity pairs (intelligence §8, scaled down): matcher pairs in three bands — p ≥ 0.98 (plus the agent's
 * merges), 0.70–0.98 and < 0.70 — the low band topped up with same-name "twins" the matcher never paired (so
 * duplicate recall has negatives to find misses in). Every agent merge from the first week comes first (up to 40,
 * within the set's size).
 * The prediction is the system's decision for the pair, as one claim the owner judges ("Same person" /
 * "Different people"). Pairs with a hidden person, or the owner's own "not the same" (dismissed / do_not_merge
 * from the user), are never sampled.
 */
import type { IdentityPayload, NewItem, StoredPrediction } from '../types';
import { DAY, shortName, shuffle } from '../util';
import { fillStrata, type SampleContext, type SampleResult } from './context';

export const FIRST_WEEK_CAP = 40;
const AGENT_METHODS = ['deterministic', 'probabilistic', 'llm_tiebreak'];
const BAND_W: Record<string, number> = { auto: 1, possible: 1, low: 0.5, twin: 0.5 };

interface PairCand {
  a: string;
  b: string;
  band: IdentityPayload['band'];
  p: number | null;
  candidateId: number | null;
  status: string | null;
  families: string[];
  guards: string[];
  merge: { id: string; method: string; undone: boolean; score: number | null } | null;
}

const pairRef = (a: string, b: string) => (a < b ? `pair:${a}|${b}` : `pair:${b}|${a}`);
const parseList = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s ?? '[]') as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

export async function sampleIdentity(c: SampleContext): Promise<SampleResult> {
  const db = c.db;
  const merges = db
    .prepare(
      `SELECT id, survivor_id, merged_id, method, score, created_at, undone_at FROM merges WHERE method IN (${AGENT_METHODS.map(() => '?').join(',')}) ORDER BY created_at, id`,
    )
    .all(...AGENT_METHODS) as { id: string; survivor_id: string; merged_id: string; method: string; score: number | null; created_at: number; undone_at: number | null }[];
  const mergeOf = new Map<string, (typeof merges)[number]>();
  for (const m of merges) mergeOf.set(pairRef(m.survivor_id, m.merged_id), m);
  const userNo = new Set(
    (db.prepare(`SELECT a_id, b_id FROM do_not_merge WHERE source = 'user'`).all() as { a_id: string; b_id: string }[]).map((r) => pairRef(r.a_id, r.b_id)),
  );
  const cands = new Map<string, PairCand>();
  const firstAt = merges[0]?.created_at ?? null;

  // matcher pairs
  for (const r of db.prepare(`SELECT id, a_id, b_id, p, status, families, guards_failed FROM match_candidates WHERE status <> 'dismissed'`).all() as {
    id: number;
    a_id: string;
    b_id: string;
    p: number;
    status: string;
    families: string;
    guards_failed: string;
  }[]) {
    const ref = pairRef(r.a_id, r.b_id);
    const m = mergeOf.get(ref) ?? null;
    cands.set(ref, {
      a: r.a_id,
      b: r.b_id,
      band: r.p >= 0.98 || m ? 'auto' : r.p >= 0.7 ? 'possible' : 'low',
      p: r.p,
      candidateId: r.id,
      status: r.status,
      families: parseList(r.families),
      guards: parseList(r.guards_failed),
      merge: m ? { id: m.id, method: m.method, undone: m.undone_at !== null, score: m.score } : null,
    });
  }
  // agent merges the matcher table doesn't hold (deterministic links, pre-matcher merges)
  for (const m of merges) {
    const ref = pairRef(m.survivor_id, m.merged_id);
    const first = firstAt !== null && m.created_at < firstAt + 7 * DAY;
    const prev = cands.get(ref);
    if (prev) {
      if (first) prev.band = 'first_week';
      continue;
    }
    cands.set(ref, {
      a: m.survivor_id,
      b: m.merged_id,
      band: first ? 'first_week' : 'auto',
      p: m.score,
      candidateId: null,
      status: 'merged',
      families: [],
      guards: [],
      merge: { id: m.id, method: m.method, undone: m.undone_at !== null, score: m.score },
    });
  }
  // same-name twins the matcher never paired (predicted: different people)
  for (const r of db
    .prepare(
      `SELECT a.id AS a, b.id AS b FROM person_visible a JOIN person_visible b
         ON b.last_name = a.last_name COLLATE NOCASE AND b.first_name = a.first_name COLLATE NOCASE AND a.id < b.id
       WHERE a.first_name IS NOT NULL AND length(trim(a.first_name)) >= 2 AND a.last_name IS NOT NULL AND length(trim(a.last_name)) >= 2
       LIMIT 5000`,
    )
    .all() as { a: string; b: string }[]) {
    const ref = pairRef(r.a, r.b);
    if (cands.has(ref)) continue;
    cands.set(ref, { a: r.a, b: r.b, band: 'twin', p: null, candidateId: null, status: null, families: [], guards: [], merge: null });
  }

  const pool = [...cands.entries()].filter(([ref]) => !c.exclude.has(ref) && !userNo.has(ref));
  if (!pool.length || c.size <= 0) return { items: [], pool: 0 };
  const groups = new Map<string, PairCand[]>();
  for (const [, p] of shuffle(pool, c.rand)) {
    let g = groups.get(p.band);
    if (!g) groups.set(p.band, (g = []));
    g.push(p);
  }
  // Every first-week merge (capped) on top of the banded sample.
  const firstWeek = groups.get('first_week') ?? [];
  groups.delete('first_week');
  const items: NewItem[] = [];
  for (const p of firstWeek) {
    if (items.length >= Math.min(FIRST_WEEK_CAP, c.size)) break;
    const it = buildPair(c, p, 'first_week');
    if (it) items.push(it);
  }
  items.push(...(await fillStrata(groups, (k) => BAND_W[k] ?? 0.5, Math.max(0, c.size - items.length), (p, stratum) => buildPair(c, p, stratum))));
  return { items, pool: pool.length };
}

/** merged | held | possible_duplicate | blocked | separate */
function decisionOf(p: PairCand): string {
  if (p.merge) return 'merged';
  if (p.status === 'held' || p.status === 'possible_duplicate' || p.status === 'blocked') return p.status;
  return 'separate';
}

function buildPair(c: SampleContext, p: PairCand, stratum: string): NewItem | null {
  const db = c.db;
  // Neither record hidden, both still real people (a merged side resolves to its survivor).
  const rows = db.prepare(`SELECT id, is_hidden, kind, display_name, first_name, last_name FROM people WHERE id IN (?, ?)`).all(p.a, p.b) as {
    id: string;
    is_hidden: number;
    kind: string;
    display_name: string;
    first_name: string | null;
    last_name: string | null;
  }[];
  if (rows.length !== 2 || rows.some((r) => r.is_hidden || r.kind !== 'person')) return null;
  if (!c.visible(p.a) || !c.visible(p.b)) return null;
  const info = (id: string) => {
    const r = rows.find((x) => x.id === id)!;
    return { id: r.id, displayName: r.display_name, firstName: r.first_name, lastName: r.last_name };
  };
  const A = info(p.a);
  const B = info(p.b);
  const decision = decisionOf(p);
  const same = decision === 'merged' || decision === 'held' || decision === 'possible_duplicate';
  const pTxt = p.p !== null ? ` · p ${p.p.toFixed(2)}` : '';
  const detail =
    decision === 'merged'
      ? `merged automatically (${p.merge!.method})${pTxt}${p.merge!.undone ? ' · later undone' : ''}`
      : decision === 'held' || decision === 'possible_duplicate'
        ? `flagged as a possible duplicate${pTxt}`
        : decision === 'blocked'
          ? `kept apart by a safety guard${pTxt}`
          : p.band === 'twin'
            ? 'same name, never paired'
            : `kept apart${pTxt}`;
  const prediction: StoredPrediction = {
    id: 'pair',
    kind: decision === 'merged' ? 'merge' : same ? 'possible' : 'separate',
    label: same ? 'Same person' : 'Different people',
    detail,
    refs: [`P:${p.a}`, `P:${p.b}`],
    m: { decision, method: p.merge?.method ?? null, p: p.p, subjectId: p.merge?.id ?? (p.candidateId !== null ? String(p.candidateId) : null) },
  };
  const payload: IdentityPayload = { kind: 'identity', a: p.a, b: p.b, band: p.band, candidateId: p.candidateId, mergeId: p.merge?.id ?? null, families: p.families, guards: p.guards };
  const title = `${shortName(A)} ↔ ${shortName(B)}`;
  return { set: 'identity', subjectRef: pairRef(p.a, p.b), stratum, title, frozenAt: c.now, payload, predictions: [prediction], promptVersion: null };
}
