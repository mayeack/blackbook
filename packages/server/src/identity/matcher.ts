/**
 * Nightly probabilistic identity matcher (intelligence §1.5–1.6): block → score → decide → merge.
 *
 * Decision bands (p from matcherScore):
 *   merge               p ≥ 0.98, ≥2 evidence families including a non-name one (G1), and every guard passes
 *                       (G2 co-presence, G3 do_not_merge, G4 distinct Contacts cards, G5 cluster sanity, G7 both
 *                       priority/hidden). At most MAX_MERGES_PER_NIGHT per 24 h (G6); the rest are 'held' and an
 *                       alert is raised. Each merge is a journaled pointer merge with method 'probabilistic' and the
 *                       evidence (bits, families, counts; never handles or names), so undo splits the pair and writes
 *                       do_not_merge, which G3 then respects on every later night.
 *   possible_duplicate  0.70 ≤ p < 0.98, or p ≥ 0.98 without enough families: kept apart, stored in
 *                       match_candidates for the LLM tie-break (identity/tiebreak.ts, 02:50: p ≥ 0.85 with ≥2
 *                       families only) and the person page's one-tap merge.
 *   blocked             in band but a guard fails (a vetoed pair whose score without the veto is in band too).
 *   separate            below the band: no action (an earlier candidate row is closed).
 * A 'dismissed' candidate (the user said "not the same") is never merged and keeps its status.
 * Nothing here logs names, handles or keys; the job stats are counts.
 */
import { uuidv7 } from '@yb/shared';
import { sourceRun } from '../adapters/common/context';
import { canonicalId } from '../db/canon';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { IS_LINK_ROW, refreshLinkAlert } from './linkHolds';
import { chooseSurvivor, mergePeople, MergeRefusedError } from './merge';
import { guardFailures } from './matcherGuards';
import { loadBook } from './matcherProfiles';
import { blockPairs, priorBits, scorePair, type Family, type PairScore } from './matcherScore';

export const AUTO_MERGE_P = 0.98;
export const POSSIBLE_P = 0.7;
/** G6: probabilistic + LLM merges per 24 h. */
export const MAX_MERGES_PER_NIGHT = 25;
export const MATCHER_SOURCE = 'identity-match';
const DAY_MS = 86_400_000;

export type CandidateStatus = 'merged' | 'held' | 'possible_duplicate' | 'blocked' | 'separate' | 'dismissed';
export type Decision = 'merge' | 'possible_duplicate' | 'blocked' | 'separate';

/** The band for a scored pair, given the guards it fails ('G1' is added when only the family rule stops it). */
export function decide(s: Pick<PairScore, 'p' | 'pRaw' | 'families'>, guards: readonly string[]): { decision: Decision; guards: string[] } {
  if (s.pRaw < POSSIBLE_P) return { decision: 'separate', guards: [...guards] };
  if (guards.length) return { decision: 'blocked', guards: [...guards] };
  if (s.p < POSSIBLE_P) return { decision: 'separate', guards: [] };
  const enough = s.families.length >= 2 && s.families.some((f) => f !== 'name');
  if (s.p >= AUTO_MERGE_P && enough) return { decision: 'merge', guards: [] };
  return { decision: 'possible_duplicate', guards: s.p >= AUTO_MERGE_P ? ['G1'] : [] };
}

export interface MatcherOptions {
  now?: number;
  jobRunId?: number | null;
  /** G6 cap (a one-time backfill may raise it). */
  maxMerges?: number;
  signal?: AbortSignal;
}

export interface MatcherStats {
  people: number;
  pairs: number;
  in_band: number;
  merged: number;
  held: number;
  possible: number;
  blocked: number;
  dismissed: number;
  closed: number;
  refused: number;
}

interface Candidate {
  s: PairScore;
  status: CandidateStatus;
  guards: string[];
}

const FAMILY_LABEL: Record<Family, string> = { name: 'name', handle: 'IG handle', graph: 'graph', self_id: 'self-intro', context: 'same city' };

/** "name + IG handle + 2 shared groups" (counts only). */
export function describeEvidence(s: PairScore): string {
  const parts: string[] = [];
  for (const f of s.families) {
    if (f !== 'graph') {
      parts.push(FAMILY_LABEL[f]);
      continue;
    }
    if (s.counts.shared_groups) parts.push(`${s.counts.shared_groups} shared group${s.counts.shared_groups === 1 ? '' : 's'}`);
    if (s.counts.shared_events) parts.push(`${s.counts.shared_events} shared event${s.counts.shared_events === 1 ? '' : 's'}`);
    if (s.bits.jaccard) parts.push('shared friends');
  }
  return parts.join(' + ');
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const roundBits = (bits: Record<string, number>) => Object.fromEntries(Object.entries(bits).map(([k, v]) => [k, round(v, 2)]));

/** Probabilistic merges already made in the last 24 h (they count against G6). */
const recentMerges = (db: DB, now: number) =>
  db
    .prepare(`SELECT count(*) FROM merges WHERE method IN ('probabilistic','llm_tiebreak') AND created_at > ?`)
    .pluck()
    .get(now - DAY_MS) as number;

function upsertCandidate(db: DB, c: Candidate, now: number): void {
  db.prepare(
    `INSERT INTO match_candidates (a_id, b_id, score_bits, p, families, guards_failed, status, features, scored_at, created_at, updated_at)
     VALUES (@a, @b, @bits, @p, @families, @guards, @status, @features, @now, @now, @now)
     ON CONFLICT (a_id, b_id) DO UPDATE SET score_bits = excluded.score_bits, p = excluded.p, families = excluded.families,
       guards_failed = excluded.guards_failed, scored_at = excluded.scored_at,
       features = CASE WHEN json_extract(match_candidates.features, '$.link') IS NULL THEN excluded.features
         ELSE json_set(excluded.features, '$.link', json_extract(match_candidates.features, '$.link')) END,
       status = CASE WHEN match_candidates.status = 'dismissed' THEN 'dismissed'
         WHEN match_candidates.status = 'held' AND json_extract(match_candidates.features, '$.link') IS NOT NULL AND excluded.status <> 'merged' THEN 'held'
         ELSE excluded.status END,
       updated_at = excluded.updated_at`,
  ).run({
    a: c.s.a,
    b: c.s.b,
    bits: round(c.s.scoreBits, 2),
    p: Math.min(1, Math.max(0, round(c.s.p, 4))),
    families: JSON.stringify(c.s.families),
    guards: JSON.stringify(c.guards),
    status: c.status,
    features: JSON.stringify({ bits: roundBits(c.s.bits), counts: c.s.counts }),
    now,
  });
}

/**
 * Open candidates not re-proposed tonight are closed: 'merged' if the two are one person now, else 'separate'.
 * A held deterministic link (linkHolds.ts) stays open until the two are one person.
 */
function closeStale(db: DB, touched: Set<string>, now: number): number {
  const open = db
    .prepare(
      `SELECT id, a_id, b_id, status = 'held' AND ${IS_LINK_ROW} AS link FROM match_candidates WHERE status IN ('pending','possible_duplicate','held','blocked')`,
    )
    .all() as { id: number; a_id: string; b_id: string; link: number }[];
  const set = db.prepare('UPDATE match_candidates SET status = ?, updated_at = ? WHERE id = ?');
  let n = 0;
  for (const r of open) {
    const merged = canonicalId(db, r.a_id) === canonicalId(db, r.b_id);
    if ((r.link && !merged) || (!r.link && touched.has(`${r.a_id}|${r.b_id}`))) continue;
    set.run(merged ? 'merged' : 'separate', now, r.id);
    n++;
  }
  return n;
}

function updateAlert(db: DB, now: number, held: number, cap: number): void {
  if (!held) {
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE source = ? AND resolved_at IS NULL').run(now, MATCHER_SOURCE);
    return;
  }
  const message = `${held} likely duplicate merge${held === 1 ? '' : 's'} held for review (nightly limit ${cap})`;
  db.prepare(`INSERT OR IGNORE INTO alerts (id, source, severity, message, opened_at) VALUES (?, ?, 'warning', ?, ?)`).run(
    uuidv7(now),
    MATCHER_SOURCE,
    message,
    now,
  );
  db.prepare('UPDATE alerts SET message = ? WHERE source = ? AND resolved_at IS NULL').run(message, MATCHER_SOURCE);
}

export function runMatcher(db: DB, o: MatcherOptions = {}): MatcherStats {
  const now = o.now ?? Date.now();
  const cap = o.maxMerges ?? MAX_MERGES_PER_NIGHT;
  const stats: MatcherStats = { people: 0, pairs: 0, in_band: 0, merged: 0, held: 0, possible: 0, blocked: 0, dismissed: 0, closed: 0, refused: 0 };
  const book = loadBook(db);
  stats.people = book.profiles.size;
  const prior = priorBits(book.profiles.size);
  const pairs = blockPairs(book);
  stats.pairs = pairs.length;
  const dismissed = new Set(
    (db.prepare(`SELECT a_id || '|' || b_id FROM match_candidates WHERE status = 'dismissed'`).pluck().all() as string[]),
  );

  const candidates: Candidate[] = [];
  for (const [a, b] of pairs) {
    if (o.signal?.aborted) break;
    const s = scorePair(book, book.profiles.get(a)!, book.profiles.get(b)!, prior);
    if (s.pRaw < POSSIBLE_P) continue;
    const d = decide(s, guardFailures(db, s.a, s.b));
    if (d.decision === 'separate') continue;
    const status: CandidateStatus = dismissed.has(`${s.a}|${s.b}`) ? 'dismissed' : d.decision === 'merge' ? 'held' : d.decision;
    candidates.push({ s, status, guards: d.guards });
  }
  stats.in_band = candidates.length;

  // Merges, best first, re-checking the guards on the current clusters (earlier merges tonight change them).
  const run = sourceRun(db, MATCHER_SOURCE, { now, jobRunId: o.jobRunId ?? null, kind: 'nightly' });
  try {
    let budget = Math.max(0, cap - recentMerges(db, now));
    const queue = candidates
      .filter((c) => c.status === 'held')
      .sort((x, y) => y.s.p - x.s.p || y.s.scoreBits - x.s.scoreBits || (x.s.a + x.s.b < y.s.a + y.s.b ? -1 : 1));
    for (const c of queue) {
      if (o.signal?.aborted) break;
      const a = canonicalId(db, c.s.a);
      const b = canonicalId(db, c.s.b);
      if (a === b) {
        c.status = 'merged';
        continue;
      }
      const fresh = guardFailures(db, a, b);
      if (fresh.length) {
        c.status = 'blocked';
        c.guards = fresh;
        continue;
      }
      if (budget <= 0) continue; // stays 'held' (G6)
      const { survivorId, mergedId } = chooseSurvivor(db, a, b, now);
      const names = db.prepare('SELECT id, display_name FROM people WHERE id IN (?, ?)').all(survivorId, mergedId) as { id: string; display_name: string }[];
      const nameOf = (id: string) => names.find((n) => n.id === id)?.display_name ?? '(unknown)';
      try {
        tx(db, () =>
          mergePeople(db, {
            survivorId,
            mergedId,
            method: 'probabilistic',
            runId: run.ctx.runId(),
            actor: 'agent',
            score: round(c.s.p, 4),
            confidence: round(c.s.p, 4),
            evidence: {
              p: round(c.s.p, 4),
              score_bits: round(c.s.scoreBits, 2),
              families: c.s.families,
              bits: roundBits(c.s.bits),
              counts: c.s.counts,
            },
            title: `Merged ${nameOf(mergedId)} into ${nameOf(survivorId)} (${c.s.p.toFixed(2)}: ${describeEvidence(c.s)})`,
            now,
          }),
        );
        c.status = 'merged';
        budget--;
      } catch (e) {
        if (!(e instanceof MergeRefusedError)) throw e;
        c.status = 'blocked';
        c.guards = [...c.guards, e.reason];
        stats.refused++;
      }
    }

    tx(db, () => {
      const touched = new Set<string>();
      for (const c of candidates) {
        upsertCandidate(db, c, now);
        touched.add(`${c.s.a}|${c.s.b}`);
        if (c.status === 'merged') stats.merged++;
        else if (c.status === 'held') stats.held++;
        else if (c.status === 'possible_duplicate') stats.possible++;
        else if (c.status === 'blocked') stats.blocked++;
        else if (c.status === 'dismissed') stats.dismissed++;
      }
      stats.closed = closeStale(db, touched, now);
      updateAlert(db, now, stats.held, cap);
      refreshLinkAlert(db, now);
    });
    run.finish('ok', { merged: stats.merged, held: stats.held });
  } catch (e) {
    run.finish('error');
    throw e;
  }
  return stats;
}
