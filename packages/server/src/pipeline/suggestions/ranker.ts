/**
 * Digest selection (intelligence §5 "Selection", PLAN "Suggestions, self-learning and wildcards"). Pure: the stage
 * scores candidates (base × w_kind × θ factors × priority × party invites × fatigue) and applies cooldowns/mutes first; this picks.
 *
 *   1. Time-critical items (pre-event within 36 h, travel within 48 h) are forced in, best first.
 *   2. Greedy by score with diversity: the 2nd item of a kind competes at ×0.6, never more than 2 of one kind.
 *      A candidate about someone already picked is merged into that item (one composite item per person).
 *   3. Floor 0.25; if fewer than 3 items clear it, the floor relaxes to 0.15. Cap = the digest's cap (3–5).
 *   4. 🎲 wildcard slot: never the day after a wildcard; otherwise with probability ε/(1−ε) (so that, with the
 *      no-two-days-in-a-row rule, the long-run share of digests with a wildcard is ε). The wildcard generator is
 *      drawn uniformly among those with an eligible candidate, then a candidate uniformly within it. It is an
 *      extra item, but the digest never exceeds 5: at 5 the last non-forced pick makes room.
 * Ties break on the dedupe key, so a seed reproduces a digest exactly.
 */
import type { SuggestionKind, WildcardGenerator } from '@yb/shared';
import { pick } from './rng';
import { SELECTION, suggestionDedupeKey, type RankContext, type RankResult, type Ranker, type ScoredCandidate } from './types';

export interface RankDetail {
  forced: boolean;
  /** ×0.6 diversity penalty applied when it was picked. */
  penalized: boolean;
  relaxedFloor: boolean;
  /** Candidates about the same person folded into this item. */
  merged: { suggestionId: string; kind: SuggestionKind }[];
  ordinal: number;
}

export interface DetailedRankResult extends RankResult {
  details: Map<string, RankDetail>;
  wildcardAllowed: boolean;
  wildcardRoll: number;
  /** P(wildcard) used on this digest (0 when not allowed). */
  wildcardChance: number;
  floorRelaxed: boolean;
  merged: number;
}

const byScore = (a: ScoredCandidate, b: ScoredCandidate) =>
  b.score - a.score || (suggestionDedupeKey(a) < suggestionDedupeKey(b) ? -1 : suggestionDedupeKey(a) > suggestionDedupeKey(b) ? 1 : 0);

/** The per-digest wildcard probability that yields a long-run rate of ε under "never two days in a row". */
export function wildcardChance(epsilon: number): number {
  const e = Math.min(1, Math.max(0, Number.isFinite(epsilon) ? epsilon : 0));
  if (e <= 0) return 0;
  if (e >= 0.5) return 1;
  return e / (1 - e);
}

export function rankDetailed(candidates: readonly ScoredCandidate[], ctx: RankContext): DetailedRankResult {
  const regular = candidates.filter((c) => !c.isWildcard && Number.isFinite(c.score)).sort(byScore);
  const pool = candidates.filter((c) => c.isWildcard && c.wildcardGenerator && Number.isFinite(c.score));
  const considered: Partial<Record<SuggestionKind, number>> = {};
  for (const c of regular) considered[c.kind] = (considered[c.kind] ?? 0) + 1;

  const cap = Math.min(SELECTION.maxCap, Math.max(SELECTION.minCap, Math.round(ctx.cap)));
  const selected: ScoredCandidate[] = [];
  const details = new Map<string, RankDetail>();
  const kindCount = new Map<SuggestionKind, number>();
  const personOwner = new Map<string, string>(); // person id → suggestion id of the item that holds them
  const done = new Set<string>(); // suggestion ids picked or merged
  let merged = 0;

  const holderOf = (c: ScoredCandidate): string | null => {
    for (const p of c.personIds) {
      const h = personOwner.get(p);
      if (h) return h;
    }
    return null;
  };
  const take = (c: ScoredCandidate, d: Omit<RankDetail, 'merged' | 'ordinal'>) => {
    selected.push(c);
    done.add(c.suggestionId);
    kindCount.set(c.kind, (kindCount.get(c.kind) ?? 0) + 1);
    for (const p of c.personIds) if (!personOwner.has(p)) personOwner.set(p, c.suggestionId);
    details.set(c.suggestionId, { ...d, merged: [], ordinal: 0 });
  };
  const mergeInto = (holder: string, c: ScoredCandidate) => {
    details.get(holder)?.merged.push({ suggestionId: c.suggestionId, kind: c.kind });
    done.add(c.suggestionId);
    merged++;
  };

  // 1. forced
  for (const c of regular) {
    if (!c.timeCritical || done.has(c.suggestionId)) continue;
    const holder = holderOf(c);
    if (holder) {
      mergeInto(holder, c);
      continue;
    }
    if (selected.length >= SELECTION.maxCap) break;
    take(c, { forced: true, penalized: false, relaxedFloor: false });
  }

  // 2. greedy with diversity, floor, relaxed floor
  const greedy = (floor: number, relaxed: boolean) => {
    while (selected.length < cap) {
      let best: ScoredCandidate | null = null;
      let bestAdj = -Infinity;
      let bestPenalized = false;
      for (const c of regular) {
        if (done.has(c.suggestionId)) continue;
        const n = kindCount.get(c.kind) ?? 0;
        if (n >= SELECTION.maxPerKind) continue;
        const adj = c.score * (n >= 1 ? SELECTION.sameKindPenalty : 1);
        if (adj < floor) continue;
        if (adj > bestAdj) {
          best = c;
          bestAdj = adj;
          bestPenalized = n >= 1;
        }
      }
      if (!best) return;
      const holder = holderOf(best);
      if (holder) {
        mergeInto(holder, best);
        continue;
      }
      take(best, { forced: false, penalized: bestPenalized, relaxedFloor: relaxed });
    }
  };
  greedy(SELECTION.floor, false);
  let floorRelaxed = false;
  if (selected.length < SELECTION.minCap) {
    const before = selected.length;
    greedy(SELECTION.relaxedFloor, true);
    floorRelaxed = selected.length > before;
  }

  // 3. wildcard
  const epsilon = Number(ctx.settings['learner.wildcard_epsilon'] ?? 0);
  const wildcardAllowed = !ctx.wildcardYesterday && epsilon > 0;
  const chance = wildcardAllowed ? wildcardChance(epsilon) : 0;
  const roll = ctx.rng();
  let wildcard: ScoredCandidate | null = null;
  if (wildcardAllowed && roll < chance) {
    const chosenKeys = new Set(selected.map(suggestionDedupeKey));
    const eligible = pool.filter((c) => !chosenKeys.has(suggestionDedupeKey(c)) && !done.has(c.suggestionId) && !holderOf(c));
    const gens = [...new Set(eligible.map((c) => c.wildcardGenerator as WildcardGenerator))].sort();
    const g = pick(ctx.rng, gens);
    if (g) {
      const within = eligible.filter((c) => c.wildcardGenerator === g).sort(byScore);
      wildcard = pick(ctx.rng, within) ?? null;
    }
    if (wildcard) {
      if (selected.length >= SELECTION.maxCap) {
        const idx = selected.map((c) => !details.get(c.suggestionId)?.forced).lastIndexOf(true);
        if (idx >= 0) {
          const [dropped] = selected.splice(idx, 1);
          if (dropped) {
            details.delete(dropped.suggestionId);
            done.delete(dropped.suggestionId);
            for (const [p, h] of personOwner) if (h === dropped.suggestionId) personOwner.delete(p);
          }
        } else wildcard = null; // five forced items: no room
      }
      if (wildcard) take(wildcard, { forced: false, penalized: false, relaxedFloor: false });
    }
  }

  selected.forEach((c, i) => {
    const d = details.get(c.suggestionId);
    if (d) d.ordinal = i + 1;
  });
  return {
    selected,
    wildcard,
    seed: ctx.seed,
    cap,
    considered,
    details,
    wildcardAllowed,
    wildcardRoll: roll,
    wildcardChance: chance,
    floorRelaxed,
    merged,
  };
}

export const defaultRanker: Ranker = { rank: (candidates, ctx) => rankDetailed(candidates, ctx) };
