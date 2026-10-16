/**
 * Claim matching between two keyed prediction lists (baseline vs replay, or labeled vs replay): exact key first,
 * then fuzzy within the same person + category (facts: similar value; commitments: similar `what`). One-to-one,
 * greedy by similarity.
 */
import type { KeyedPrediction } from './types';
import { jaccard } from './util';

export interface MatchResult<A, B> {
  pairs: { a: A; b: B }[];
  onlyA: A[];
  onlyB: B[];
}

const FACT_SIM = 0.5;
const COMMITMENT_SIM = 0.3;

function similarity(a: KeyedPrediction, b: KeyedPrediction): number {
  if (a.key === b.key) return 2;
  if (a.kind !== b.kind || a.cat !== b.cat || a.personId !== b.personId) return 0;
  if (a.kind === 'fact') {
    if (a.value && b.value && (a.value.includes(b.value) || b.value.includes(a.value))) return 1.5;
    const j = jaccard(a.value, b.value);
    return j >= FACT_SIM ? 1 + j / 2 : 0;
  }
  if (a.kind === 'commitment') {
    const ownerA = a.key.split('|')[3];
    const ownerB = b.key.split('|')[3];
    if (ownerA !== ownerB) return 0;
    const j = jaccard(a.value, b.value);
    return j >= COMMITMENT_SIM ? 1 + j / 2 : 0;
  }
  return 0;
}

export function matchClaims<A extends KeyedPrediction, B extends KeyedPrediction>(as: readonly A[], bs: readonly B[]): MatchResult<A, B> {
  const cand: { i: number; j: number; s: number }[] = [];
  for (let i = 0; i < as.length; i++) {
    for (let j = 0; j < bs.length; j++) {
      const s = similarity(as[i]!, bs[j]!);
      if (s > 0) cand.push({ i, j, s });
    }
  }
  cand.sort((x, y) => y.s - x.s || x.i - y.i || x.j - y.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: { a: A; b: B }[] = [];
  for (const c of cand) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push({ a: as[c.i]!, b: bs[c.j]! });
  }
  return { pairs, onlyA: as.filter((_, i) => !usedA.has(i)), onlyB: bs.filter((_, j) => !usedB.has(j)) };
}

/** The metric bucket of a claim: 'fact:<cat>', 'commitment', 'needs_reply', 'relation'. */
export const bucketOf = (p: Pick<KeyedPrediction, 'kind' | 'cat'>): string => (p.kind === 'fact' ? `fact:${p.cat}` : p.kind);
