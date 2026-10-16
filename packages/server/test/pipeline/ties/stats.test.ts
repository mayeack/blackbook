import { describe, expect, it } from 'vitest';
import { dayConverter, dayNumber, dayString, weekStart } from '../../../src/pipeline/ties/days';
import {
  computeTie,
  decilePriors,
  DEFAULT_THRESHOLDS,
  expectedGap,
  gapSummary,
  quantile,
  stateLabel,
  weeklySeries,
  type TieInputs,
  type TouchDay,
} from '../../../src/pipeline/ties/stats';
import { groupSessionUnits, touchDays, type InteractionRow } from '../../../src/pipeline/ties/touch';

const TODAY = dayNumber('2026-10-14');

const day = (d: number, units = 1, dm = true): TouchDay => ({ day: d, units, dm, lastAt: d * 86_400_000, lastIn: d * 86_400_000, lastOut: null });

/** Contact every `every` days, `count` times, the last one `silence` days before today. */
function cadence(every: number, count: number, silence: number, units = 1): TouchDay[] {
  const last = TODAY - silence;
  return Array.from({ length: count }, (_, i) => day(last - (count - 1 - i) * every, units));
}

function tie(days: TouchDay[], o: Partial<TieInputs> = {}, prior = 30) {
  const inp: TieInputs = {
    today: TODAY,
    days,
    sessions365: { total: 0, mine: 0 },
    priority: false,
    hasAddressBook: false,
    hasMessageHistory: true,
    partifulSharedEvents: null,
    firstSeenDay: (days[0]?.day ?? TODAY) - 1,
    suppressFading: false,
    ...o,
  };
  return computeTie(inp, gapSummary(days, TODAY), prior, DEFAULT_THRESHOLDS);
}

describe('cadence-aware fading (intelligence §3 sanity checks)', () => {
  it('a daily texter is flagged at the 21-day floor, not before', () => {
    expect(tie(cadence(1, 300, 20)).state).not.toBe('fading');
    const r = tie(cadence(1, 300, 21));
    expect(r.state).toBe('fading');
    expect(r.expectedGap!).toBeLessThan(1.1);
    expect(r.expectedGapFloor).toBe(7);
    expect(r.fadingRatio).toBe(3);
    expect(r.historical).toBeGreaterThan(99);
  });

  it('a weekly friend fades after about three weeks', () => {
    expect(tie(cadence(7, 52, 21)).state).not.toBe('fading');
    const r = tie(cadence(7, 52, 24));
    expect(r.state).toBe('fading');
    expect(r.medianGap).toBe(7);
    expect(r.expectedGap!).toBeGreaterThan(7);
    expect(r.expectedGap!).toBeLessThan(8.5);
  });

  it('a monthly friend fades at about 90 days', () => {
    expect(tie(cadence(30, 24, 80, 2)).state).not.toBe('fading');
    expect(tie(cadence(30, 24, 91, 2)).state).toBe('fading');
  });

  it('priority people use the lower thresholds', () => {
    const days = cadence(7, 52, 16);
    expect(tie(days).state).not.toBe('fading');
    const p = tie(days, { priority: true });
    expect(p.state).toBe('fading');
    // severity = (H/100)·min(1, log2(F)/3)·1.5
    expect(p.severity).toBeCloseTo(Math.min(1, (p.historical / 100) * Math.min(1, Math.log2(p.fadingRatio!) / 3) * 1.5), 3);
  });

  it('cooling: a once-daily friend who went quiet for months and just surfaced once', () => {
    const old = Array.from({ length: 145 }, (_, i) => day(TODAY - 365 + i));
    const r = tie([...old, day(TODAY - 10)]);
    expect(r.fadingRatio!).toBeLessThan(3);
    expect(r.momentum).toBeLessThanOrEqual(-1);
    expect(r.state).toBe('cooling');
  });

  it('dormant after a year of silence; cold start for new and thin ties', () => {
    expect(tie(cadence(7, 60, 400)).state).toBe('dormant');
    expect(tie(cadence(3, 4, 30)).state).toBe('new');
    expect(tie(cadence(1, 20, 1), { firstSeenDay: TODAY - 20 }).state).toBe('new'); // known < 60 days
    expect(tie([]).state).toBe('new');
  });

  it('suppressed fading never surfaces as "fading"', () => {
    const r = tie(cadence(1, 300, 30), { suppressFading: true });
    expect(r.fadingSuppressed).toBe(true);
    expect(r.state).not.toBe('fading');
    expect(r.severity).toBeNull();
  });

  it('reciprocity and tie strength', () => {
    const r = tie(cadence(1, 120, 0), { sessions365: { total: 10, mine: 8 } });
    expect(r.iStartShare).toBe(0.8);
    expect(r.reciprocity).toBe(0.4);
    expect(r.tieStrength).toBeGreaterThan(70 * 0.82);
    expect(r.tieStrength).toBeLessThanOrEqual(100);
    const balanced = tie(cadence(1, 120, 0), { sessions365: { total: 10, mine: 5 } });
    expect(balanced.reciprocity).toBe(1);
    expect(balanced.tieStrength).toBeGreaterThan(r.tieStrength);
    expect(balanced.state).toBe('strong');
  });

  it('the Partiful seed gives people without messages a history score', () => {
    const r = tie([], { hasMessageHistory: false, partifulSharedEvents: 7 });
    expect(r.historical).toBeCloseTo(100 * (1 - Math.exp(-15 / 30)), 1);
    expect(r.state).toBe('new');
  });

  it('address-book people with a 1:1 day can fade after 90 days (E_prior 30)', () => {
    const days = [day(TODAY - 200), day(TODAY - 170), day(TODAY - 140)];
    const r = tie(days, { hasAddressBook: true, priority: true, firstSeenDay: TODAY - 400 });
    expect(r.coldStart).toBe(false);
    expect(tie(days, { hasAddressBook: false, priority: true, firstSeenDay: TODAY - 400 }).coldStart).toBe(true);
  });

  it('helpers: quantiles, shrinkage, decile priors, labels', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
    expect(expectedGap(0, null, 30)).toBe(30);
    expect(expectedGap(100, 2, 30)).toBeLessThan(2.3);
    expect(expectedGap(1, 500, 500)).toBe(120);
    expect(decilePriors([{ volume: 1, median: 5 }])(1)).toBe(30);
    const entries = Array.from({ length: 100 }, (_, i) => ({ volume: i, median: i < 50 ? 40 : 4 }));
    const prior = decilePriors(entries);
    expect(prior(3)).toBe(40);
    expect(prior(95)).toBe(4);
    expect(prior(10_000)).toBe(4);
    expect(stateLabel('fading')).toBe('Fading');
    expect(stateLabel(null)).toBeNull();
  });

  it('weekly sparkline: Monday weeks, units per week, T at week end', () => {
    const days = cadence(1, 60, 0);
    const series = weeklySeries(days, TODAY, 1, weekStart);
    expect(series.length).toBeGreaterThanOrEqual(9);
    expect(series.length).toBeLessThanOrEqual(26);
    expect(new Date(series[0]!.week * 86_400_000).getUTCDay()).toBe(1);
    expect(series[series.length - 1]!.week).toBe(weekStart(TODAY));
    expect(series.slice(1, -1).every((s) => s.units === 7)).toBe(true);
    expect(series[series.length - 1]!.t).toBeGreaterThan(series[0]!.t);
  });
});

describe('days', () => {
  it('converts timestamps to local days in the configured zone', () => {
    const toDay = dayConverter('America/Los_Angeles');
    const lateEvening = Date.UTC(2026, 9, 15, 6, 30); // 23:30 PDT on the 14th
    const afterMidnight = Date.UTC(2026, 9, 15, 7, 30); // 00:30 PDT on the 15th
    expect(dayString(toDay(lateEvening))).toBe('2026-10-14');
    expect(dayString(toDay(afterMidnight))).toBe('2026-10-15');
    expect(dayNumber(dayString(TODAY))).toBe(TODAY);
  });
});

describe('daily touch units', () => {
  const base = { dayOf: (ms: number) => Math.floor(ms / 86_400_000), groupSize: (c: string) => ({ small: 4, mid: 10, big: 30 })[c], now: 400 * 86_400_000 };
  const row = (kind: string, d: number, o: Partial<InteractionRow> = {}): InteractionRow => ({
    kind,
    conversation_id: null,
    started_at: d * 86_400_000 + 3_600_000,
    ended_at: null,
    msgs_from_me: 1,
    msgs_from_them: 1,
    initiated_by_me: 1,
    units: null,
    ...o,
  });

  it('scores each component and caps the day at 2.0', () => {
    const t = touchDays(
      [
        row('dm_session', 1),
        row('dm_session', 2, { msgs_from_them: 0 }),
        row('group_session', 3, { conversation_id: 'small' }),
        row('group_session', 4, { conversation_id: 'mid' }),
        row('group_session', 5, { conversation_id: 'big' }),
        row('group_session', 6, { conversation_id: 'small', msgs_from_me: 0 }),
        row('event', 7, { units: 1.5 }),
        row('event', 8, { units: 1.5 }),
        row('dm_session', 8),
        row('call', 9),
        row('legacy_text', 10),
        row('text_log', 11),
      ],
      { ...base, now: 30 * 86_400_000, reactionTimes: [12 * 86_400_000, 1 * 86_400_000 + 5] },
    );
    const by = new Map(t.days.map((d) => [d.day, d]));
    expect(by.get(1)!.units).toBe(1);
    expect(by.get(1)!.components.tap).toBeUndefined(); // a tapback on a messaging day adds nothing
    expect(by.get(2)!.units).toBe(0.6);
    expect(by.get(3)!.units).toBe(0.3);
    expect(by.get(4)!.units).toBe(0.15);
    expect(by.get(5)!.units).toBe(0.05);
    expect(by.get(6)!.units).toBe(0.05);
    expect(by.get(7)!.units).toBe(1.5);
    expect(by.get(8)!.units).toBe(2);
    expect(by.get(9)!.units).toBe(1.2);
    expect(by.get(10)!.units).toBe(0.6);
    expect(by.get(11)!.units).toBe(1.5);
    expect(by.get(12)!.units).toBe(0.1);
    expect(t.hasMessageHistory).toBe(true);
    expect(t.sessions365.total).toBe(3);
    expect(groupSessionUnits(undefined, true)).toBe(0.05);
  });

  it('ignores the future and counts only last-year sessions for reciprocity', () => {
    const t = touchDays([row('dm_session', 10), row('dm_session', 401), row('dm_session', 399, { initiated_by_me: 0 })], base);
    expect(t.days.map((d) => d.day)).toEqual([10, 399]);
    expect(t.sessions365).toEqual({ total: 1, mine: 0 });
  });
});
