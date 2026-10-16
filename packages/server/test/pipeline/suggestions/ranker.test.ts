import { describe, expect, it } from 'vitest';
import type { SuggestionKind, WildcardGenerator } from '@yb/shared';
import { rankDetailed, wildcardChance } from '../../../src/pipeline/suggestions/ranker';
import { mulberry32 } from '../../../src/pipeline/suggestions/rng';
import type { RankContext, ScoredCandidate } from '../../../src/pipeline/suggestions/types';
import { nullLogger } from '../../../src/ops/logger';
import { settingDefaults } from '../../../src/settings/registry';
import { memDb, T0 } from '../../helpers';

let seq = 0;
function sc(kind: SuggestionKind, score: number, personIds: string[], extra: Partial<ScoredCandidate> = {}): ScoredCandidate {
  seq++;
  return {
    kind,
    personIds,
    subjectKey: `s${seq}`,
    base: score,
    evidenceIds: [],
    expiresAt: null,
    payload: {},
    suggestionId: `id-${seq}`,
    score,
    factors: { kind: 1, bucket: 1, person: 1, wildcard: 1 },
    isWildcard: false,
    wildcardGenerator: null,
    ...extra,
  };
}

const wild = (g: WildcardGenerator, personIds: string[], kind: SuggestionKind = 'dormant') =>
  sc(kind, 0.05, personIds, { isWildcard: true, wildcardGenerator: g });

const DB = memDb();

function ctx(over: Partial<RankContext> = {}, epsilon = 0.2): RankContext {
  const settings = { ...settingDefaults(), 'learner.wildcard_epsilon': epsilon, self_handles: [] };
  return {
    db: DB,
    now: T0,
    timeZone: 'UTC',
    settings,
    runId: null,
    log: nullLogger,
    rng: mulberry32(1),
    seed: 1,
    cap: 4,
    wildcardYesterday: false,
    ...over,
  };
}

describe('ranker selection', () => {
  it('greedy by score, ≤2 per kind with the 2nd at ×0.6, cap respected', () => {
    const items = [
      sc('reply_debt', 0.9, ['a']),
      sc('reply_debt', 0.85, ['b']),
      sc('reply_debt', 0.8, ['c']),
      sc('fading', 0.5, ['d']),
      sc('cooling', 0.45, ['e']),
      sc('dormant', 0.3, ['f']),
    ];
    const r = rankDetailed(items, ctx({ cap: 4 }, 0));
    expect(r.selected.map((s) => s.personIds[0])).toEqual(['a', 'b', 'd', 'e']);
    expect(r.details.get(items[1]!.suggestionId)?.penalized).toBe(true);
    expect(r.considered).toEqual({ reply_debt: 3, fading: 1, cooling: 1, dormant: 1 });
    // the 2nd reply debt at ×0.6 (0.51) comes after a 0.6 fading; the cap never goes below 3
    const r2 = rankDetailed([sc('reply_debt', 0.9, ['a']), sc('reply_debt', 0.85, ['b']), sc('fading', 0.6, ['d'])], ctx({ cap: 2 }, 0));
    expect(r2.cap).toBe(3);
    expect(r2.selected.map((s) => s.kind)).toEqual(['reply_debt', 'fading', 'reply_debt']);
  });

  it('forces time-critical items in first, even below the floor', () => {
    const items = [sc('reply_debt', 0.9, ['a']), sc('pre_event_brief', 0.05, ['b'], { timeCritical: true }), sc('fading', 0.6, ['c'])];
    const r = rankDetailed(items, ctx({ cap: 3 }, 0));
    expect(r.selected[0]!.kind).toBe('pre_event_brief');
    expect(r.details.get(items[1]!.suggestionId)).toMatchObject({ forced: true, ordinal: 1 });
  });

  it('merges a second item about the same person into the first (one composite item per person)', () => {
    const items = [sc('reply_debt', 0.9, ['a']), sc('fading', 0.8, ['a']), sc('cooling', 0.5, ['b'])];
    const r = rankDetailed(items, ctx({ cap: 4 }, 0));
    expect(r.selected.map((s) => s.suggestionId)).toEqual([items[0]!.suggestionId, items[2]!.suggestionId]);
    expect(r.details.get(items[0]!.suggestionId)?.merged).toEqual([{ suggestionId: items[1]!.suggestionId, kind: 'fading' }]);
    expect(r.merged).toBe(1);
  });

  it('floor 0.25, relaxed to 0.15 when fewer than 3 clear it', () => {
    const items = [sc('reply_debt', 0.5, ['a']), sc('fading', 0.2, ['b']), sc('cooling', 0.16, ['c']), sc('dormant', 0.1, ['d'])];
    const r = rankDetailed(items, ctx({ cap: 5 }, 0));
    expect(r.selected.map((s) => s.personIds[0])).toEqual(['a', 'b', 'c']);
    expect(r.floorRelaxed).toBe(true);
    expect(r.details.get(items[1]!.suggestionId)?.relaxedFloor).toBe(true);
    const r2 = rankDetailed([sc('reply_debt', 0.5, ['a']), sc('fading', 0.4, ['b']), sc('cooling', 0.3, ['c']), sc('dormant', 0.2, ['d'])], ctx({ cap: 5 }, 0));
    expect(r2.selected).toHaveLength(3);
    expect(r2.floorRelaxed).toBe(false);
  });

  it('is reproducible for a seed (ties break on the dedupe key)', () => {
    const items = [sc('fading', 0.5, ['a']), sc('fading', 0.5, ['b']), sc('cooling', 0.5, ['c']), wild('memory', ['m']), wild('dormant_close', ['n'])];
    const a = rankDetailed(items, ctx({ rng: mulberry32(99), seed: 99 }, 0.5));
    const b = rankDetailed([...items].reverse(), ctx({ rng: mulberry32(99), seed: 99 }, 0.5));
    expect(a.selected.map((s) => s.suggestionId)).toEqual(b.selected.map((s) => s.suggestionId));
  });
});

describe('🎲 wildcard slot', () => {
  it('long-run rate ≈ ε with never two days in a row', () => {
    expect(wildcardChance(0.2)).toBeCloseTo(0.25);
    expect(wildcardChance(0)).toBe(0);
    expect(wildcardChance(0.6)).toBe(1);
    const rng = mulberry32(2026);
    let yesterday = false;
    let hits = 0;
    const days = 3000;
    for (let d = 0; d < days; d++) {
      const items = [sc('reply_debt', 0.9, ['a']), wild('memory', ['m']), wild('unseen_kind', ['u'], 'cooling')];
      const r = rankDetailed(items, ctx({ rng, wildcardYesterday: yesterday }));
      const w = !!r.wildcard;
      if (w && yesterday) throw new Error('wildcard on two consecutive days');
      if (w) hits++;
      yesterday = w;
    }
    expect(hits / days).toBeGreaterThan(0.17);
    expect(hits / days).toBeLessThan(0.23);
  });

  it('draws the generator uniformly, skips people already picked, and keeps the digest ≤5', () => {
    const counts: Record<string, number> = {};
    for (let seed = 1; seed <= 600; seed++) {
      const items = [sc('reply_debt', 0.9, ['a']), wild('memory', ['m1']), wild('memory', ['m2']), wild('memory', ['m3']), wild('circle_checkin', [], 'circle_neglect')];
      const r = rankDetailed(items, ctx({ rng: mulberry32(seed) }, 0.5));
      if (r.wildcard) counts[r.wildcard.wildcardGenerator!] = (counts[r.wildcard.wildcardGenerator!] ?? 0) + 1;
    }
    // 3 memory candidates vs 1 circle check-in, but generators are drawn uniformly
    expect(counts.memory! / (counts.memory! + counts.circle_checkin!)).toBeGreaterThan(0.4);
    expect(counts.memory! / (counts.memory! + counts.circle_checkin!)).toBeLessThan(0.6);

    const same = rankDetailed([sc('reply_debt', 0.9, ['a']), wild('dormant_close', ['a'])], ctx({ rng: mulberry32(5) }, 0.5));
    expect(same.wildcard).toBeNull();

    const full = [1, 2, 3, 4, 5].map((i) => sc((['reply_debt', 'fading', 'cooling', 'dormant', 'intro'] as const)[i - 1]!, 0.9 - i * 0.05, [`p${i}`]));
    let hit: ReturnType<typeof rankDetailed> | null = null;
    for (let seed = 1; seed < 50 && !hit?.wildcard; seed++) hit = rankDetailed([...full, wild('memory', ['m'])], ctx({ cap: 5, rng: mulberry32(seed) }, 0.5));
    expect(hit?.wildcard).not.toBeNull();
    expect(hit!.selected).toHaveLength(5);
    expect(hit!.selected.at(-1)!.isWildcard).toBe(true);
    expect(hit!.selected.map((s) => s.personIds[0])).not.toContain('p5');
  });

  it('never the day after a wildcard, never with ε = 0', () => {
    for (let seed = 1; seed < 100; seed++) {
      expect(rankDetailed([wild('memory', ['m'])], ctx({ rng: mulberry32(seed), wildcardYesterday: true }, 0.9)).wildcard).toBeNull();
      expect(rankDetailed([wild('memory', ['m'])], ctx({ rng: mulberry32(seed) }, 0)).wildcard).toBeNull();
    }
  });
});
