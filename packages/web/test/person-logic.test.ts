import { describe, expect, it } from 'vitest';
import type { FactView } from '@yb/shared';
import type { SessionItem } from '../src/api/types';
import {
  cadenceLine,
  egoLayout,
  evidenceHref,
  evidenceLabel,
  gaugeArc,
  groupFacts,
  initiativeLine,
  loopSubtitle,
  pairPath,
  personTab,
  ringDash,
  sparklineCoords,
  sparklinePoints,
  stateColorVar,
} from '../src/pages/person/logic';
import { nextStep, parseLocateTarget, SCAN_BUDGET } from '../src/pages/person/locate';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 16, 12).getTime();

const fact = (o: Partial<FactView>): FactView => ({
  id: 'f',
  type: 'interest',
  value: 'climbing',
  status: 'confirmed',
  sensitive: false,
  confidence: 0.9,
  support: 1,
  validFrom: null,
  validTo: null,
  recordedAt: 0,
  retractedAt: null,
  source: 'llm',
  evidence: [],
  ...o,
});

describe('person header', () => {
  it('cadence line: "usually every ~9d · last 41d ago"', () => {
    expect(cadenceLine({ expectedGapD: 8.6, lastAt: NOW - 41 * DAY }, NOW)).toBe('usually every ~9d · last 41d ago');
    expect(cadenceLine({ expectedGapD: null, lastAt: NOW - DAY }, NOW)).toBe('last yesterday');
    expect(cadenceLine({ expectedGapD: 0.2, lastAt: null }, NOW)).toBe('usually every ~1d');
    expect(cadenceLine(null, NOW)).toBeNull();
  });

  it('initiative line needs enough contact days', () => {
    expect(initiativeLine({ iStartShare: 0.82, contactDays365: 20 })).toBe('you start 82% of conversations');
    expect(initiativeLine({ iStartShare: 0.2, contactDays365: 20 })).toBe('they start 80% of conversations');
    expect(initiativeLine({ iStartShare: 0.5, contactDays365: 20 })).toBe('you each start about half the conversations');
    expect(initiativeLine({ iStartShare: 0.9, contactDays365: 2 })).toBeNull();
  });

  it('ring dash covers T/100 of the circumference', () => {
    const r = 10;
    const c = 2 * Math.PI * r;
    expect(ringDash(50, r).length).toBeCloseTo(c / 2);
    expect(ringDash(150, r).fraction).toBe(1);
    expect(ringDash(null, r).fraction).toBe(0);
    expect(stateColorVar('fading')).toBe('var(--state-fading)');
    expect(stateColorVar(null)).toBe('var(--state-dormant)');
  });

  it('sparkline maps T 0–100 into the box, oldest left', () => {
    const pts = [
      { date: '2026-09-01', t: 0, units: 0 },
      { date: '2026-09-08', t: 100, units: 3 },
    ];
    expect(sparklineCoords(pts, 100, 20, 0)).toEqual([
      [0, 20],
      [100, 0],
    ]);
    expect(sparklinePoints(pts.slice(0, 1), 100, 20)).toBe('');
  });

  it('tab from the URL: ?m= opens the timeline', () => {
    expect(personTab(new URLSearchParams(''))).toBe('overview');
    expect(personTab(new URLSearchParams('m=12'))).toBe('timeline');
    expect(personTab(new URLSearchParams('m=12&tab=overview'))).toBe('overview');
    expect(personTab(new URLSearchParams('tab=connections'))).toBe('connections');
    expect(personTab(new URLSearchParams('tab=bogus'))).toBe('overview');
  });
});

describe('open loops, facts, evidence', () => {
  it('loop subtitles say who owes what and when', () => {
    expect(loopSubtitle({ type: 'reply_debt', since: NOW - 3 * DAY, due: null, owner: 'me', likely: true, detail: null }, NOW)).toBe('Likely owe a reply · asked 3d ago');
    expect(
      loopSubtitle({ type: 'commitment', since: NOW - 10 * DAY, due: { precision: 'date', start: NOW - 2 * DAY, end: null }, owner: 'me', likely: false, detail: 'gym link' }, NOW),
    ).toBe('You promised 10d ago · was due 2d ago · gym link');
    expect(loopSubtitle({ type: 'commitment', since: NOW - DAY, due: { precision: 'none', start: null, end: null }, owner: 'them', likely: false, detail: null }, NOW)).toBe(
      'They promised yesterday',
    );
  });

  it('groups facts in a fixed order, best supported first', () => {
    const g = groupFacts([
      fact({ id: '1', type: 'employer', value: 'Acme' }),
      fact({ id: '2', type: 'interest', value: 'chess', support: 1 }),
      fact({ id: '3', type: 'interest', value: 'climbing', support: 4 }),
      fact({ id: '4', type: 'pet', value: 'a dog' }),
    ]);
    expect(g.map((x) => x.group)).toEqual(['Interests', 'Work & school', 'Life']);
    expect(g[0]!.facts.map((f) => f.id)).toEqual(['3', '2']);
  });

  it('evidence links stay in-app and messages carry the time hint', () => {
    expect(evidenceHref({ kind: 'message', href: '/p/x?m=5', at: 77 })).toBe('/p/x?m=5&at=77');
    expect(evidenceHref({ kind: 'event', href: '/e/1', at: 77 })).toBe('/e/1');
    expect(evidenceHref({ kind: 'message', href: 'https://example.com', at: null })).toBeNull();
    expect(evidenceLabel({ kind: 'message', label: null, at: NOW - 2 * DAY }, NOW)).toBe('Message · 2d ago');
    expect(evidenceLabel({ kind: 'fact', label: 'Lives in Springfield', at: null })).toBe('Lives in Springfield');
  });
});

describe('connections geometry', () => {
  it('ego layout: center first, stronger neighbors closer, capped', () => {
    const nodes = egoLayout('me', [
      { id: 'weak', strength: 0.1 },
      { id: 'strong', strength: 0.95 },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, strength: 0.2 })),
    ], 200, 10);
    expect(nodes[0]).toMatchObject({ id: 'me', x: 100, y: 100, center: true });
    expect(nodes).toHaveLength(11);
    const d = (id: string) => {
      const n = nodes.find((x) => x.id === id)!;
      return Math.hypot(n.x - 100, n.y - 100);
    };
    expect(d('strong')).toBeLessThan(d('n0'));
    expect(nodes.some((n) => n.id === 'weak')).toBe(false); // the weakest fall off the cap
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(200);
    }
  });

  it('gauge arc ends where the value says', () => {
    expect(gaugeArc(1, 50, 50, 40)).toBe('M 10 50 A 40 40 0 0 1 90 50');
    expect(gaugeArc(0.5, 50, 50, 40)).toBe('M 10 50 A 40 40 0 0 1 50 10');
    expect(pairPath('a b', 'c')).toBe('/p/a%20b/with/c');
  });
});

// ---------------------------------------------------------------------------------------------- ?m= locate

const session = (id: string, start: number, end: number): SessionItem => ({
  type: 'session',
  id,
  conversationId: 'c',
  source: 'imessage',
  channel: 'imessage',
  conversationKind: 'direct',
  title: null,
  memberCount: null,
  startedAt: start,
  endedAt: end,
  msgCount: 3,
  fromMe: 1,
  fromThem: 2,
  initiatedByMe: true,
});

describe('locating a cited message', () => {
  it('parses m and at', () => {
    expect(parseLocateTarget(new URLSearchParams('m=123&at=456'))).toEqual({ messageId: 123, at: 456 });
    expect(parseLocateTarget(new URLSearchParams('m=abc'))).toBeNull();
    expect(parseLocateTarget(new URLSearchParams('m=0'))).toBeNull();
    expect(parseLocateTarget(new URLSearchParams('m=9&at=x'))).toEqual({ messageId: 9, at: null });
  });

  it('with a time hint: pages until a session spans it, then checks that one', () => {
    const H = 3_600_000;
    const items = [session('s3', 9 * H, 10 * H), session('s2', 5 * H, 6 * H)];
    expect(nextStep({ messageId: 1, at: 3 * H }, { items, hasNextPage: true, pagesLoaded: 1, checked: new Set() })).toEqual({ kind: 'more' });
    expect(nextStep({ messageId: 1, at: 5.5 * H }, { items, hasNextPage: true, pagesLoaded: 1, checked: new Set() })).toEqual({ kind: 'check', sessionId: 's2' });
    // checked and not there: the hint missed, so fall back to scanning the rest, then give up
    expect(nextStep({ messageId: 1, at: 5.5 * H }, { items, hasNextPage: false, pagesLoaded: 1, checked: new Set(['s2']) })).toEqual({ kind: 'check', sessionId: 's3' });
    expect(nextStep({ messageId: 1, at: 5.5 * H }, { items, hasNextPage: false, pagesLoaded: 1, checked: new Set(['s2', 's3']) })).toEqual({ kind: 'give_up' });
    // between sessions: the nearest one that started before it
    expect(nextStep({ messageId: 1, at: 7 * H }, { items, hasNextPage: false, pagesLoaded: 1, checked: new Set() })).toEqual({ kind: 'check', sessionId: 's2' });
  });

  it('without a hint: scans sessions newest first, pages, and stops at the budget', () => {
    const items = [session('a', 3, 4), session('b', 1, 2)];
    expect(nextStep({ messageId: 1, at: null }, { items, hasNextPage: true, pagesLoaded: 1, checked: new Set() })).toEqual({ kind: 'check', sessionId: 'a' });
    expect(nextStep({ messageId: 1, at: null }, { items, hasNextPage: true, pagesLoaded: 1, checked: new Set(['a', 'b']) })).toEqual({ kind: 'more' });
    expect(nextStep({ messageId: 1, at: null }, { items, hasNextPage: false, pagesLoaded: 1, checked: new Set(['a', 'b']) })).toEqual({ kind: 'give_up' });
    const many = new Set(Array.from({ length: SCAN_BUDGET }, (_, i) => `x${i}`));
    expect(nextStep({ messageId: 1, at: null }, { items, hasNextPage: true, pagesLoaded: 1, checked: many })).toEqual({ kind: 'give_up' });
  });
});
