import { describe, expect, it } from 'vitest';
import {
  burstIndexes,
  choose,
  combine,
  compact,
  gapFactor,
  handleIsPerformer,
  HOUR,
  isPerformer,
  MINUTE,
  namesHappening,
  personLabels,
  type HappeningLabels,
} from '../../../src/intel/metAt/score';

const labels = (o: Partial<Record<keyof HappeningLabels, string[]>>): HappeningLabels => ({
  performers: new Set(o.performers ?? []),
  venues: new Set(o.venues ?? []),
  titleTokens: new Set(o.titleTokens ?? []),
  titles: new Set(o.titles ?? []),
});

describe('met-at scoring', () => {
  it('gap factor: inside 1, up to 2 h before 0.8, after the end 0.9 / 0.8 / 0.7 up to 12 / 24 / 36 h, else 0', () => {
    const s = 100 * HOUR;
    const e = s + 4 * HOUR;
    expect(gapFactor(s, s, e)).toBe(1);
    expect(gapFactor(e, s, e)).toBe(1);
    expect(gapFactor(s - 2 * HOUR, s, e)).toBe(0.8);
    expect(gapFactor(s - 2 * HOUR - 1, s, e)).toBe(0);
    expect(gapFactor(e + 12 * HOUR, s, e)).toBe(0.9);
    expect(gapFactor(e + 12 * HOUR + 1, s, e)).toBe(0.8);
    expect(gapFactor(e + 24 * HOUR + 1, s, e)).toBe(0.7);
    expect(gapFactor(e + 36 * HOUR, s, e)).toBe(0.7);
    expect(gapFactor(e + 36 * HOUR + 1, s, e)).toBe(0);
  });

  it('combines several signals as a noisy-OR capped at 0.95', () => {
    expect(combine([0.6])).toBeCloseTo(0.6);
    expect(combine([0.5, 0.5])).toBeCloseTo(0.75);
    expect(combine([0.85, 0.8])).toBe(0.95);
    expect(combine([])).toBe(0);
  });

  it('takes the max; a close runner-up elsewhere costs × 0.6, at the same venue it does not', () => {
    const t = 10 * HOUR;
    const a = { item: 'a', score: 0.75, start: 9 * HOUR, end: 12 * HOUR, venues: new Set(['alpha hall']) };
    const b = { item: 'b', score: 0.675, start: 4 * HOUR, end: 8 * HOUR, venues: new Set(['beta room']) };
    expect(choose(t, [b, a])).toEqual({ item: 'a', score: 0.75 * 0.6, ambiguous: true });
    expect(choose(t, [b, { ...a, venues: new Set(['beta room']) }])).toEqual({ item: 'a', score: 0.75, ambiguous: false });
    // Runner-up under 0.9 × best: no penalty.
    expect(choose(t, [{ ...b, score: 0.6 }, a])).toEqual({ item: 'a', score: 0.75, ambiguous: false });
    // Unknown venues are never "the same place".
    expect(choose(t, [{ ...b, venues: new Set<string>() }, { ...a, venues: new Set<string>() }])?.ambiguous).toBe(true);
    expect(choose(t, [])).toBeNull();
    expect(choose(t, [{ ...a, score: 0 }])).toBeNull();
  });

  it('a tie goes to the shortest candidate that contains t', () => {
    const t = 10 * HOUR;
    const long = { item: 'long', score: 0.75, start: 6 * HOUR, end: 14 * HOUR, venues: new Set(['x']) };
    const short = { item: 'short', score: 0.75, start: 9 * HOUR, end: 11 * HOUR, venues: new Set(['y']) };
    const outside = { item: 'outside', score: 0.75, start: 11 * HOUR, end: 11 * HOUR + MINUTE, venues: new Set(['z']) };
    expect(choose(t, [long, outside, short])?.item).toBe('short');
  });

  it('marks every time inside a window that holds enough of them', () => {
    const base = 1_000 * HOUR;
    const times = [base, base + 30_000, base + 60_000, base + 90_000, base + 119_000, base + 10 * HOUR, base + 20 * HOUR];
    expect([...burstIndexes(times, 5, 2 * MINUTE)].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(burstIndexes(times.slice(0, 4), 5, 2 * MINUTE).size).toBe(0);
    // Unsorted input: indexes refer to the input order.
    expect([...burstIndexes([base + 20 * HOUR, base + 60_000, base, base + 30_000, base + 90_000, base + 100_000], 5, 2 * MINUTE)].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('a name or handle that IS the happening (performer, venue, title) or any ticket performer is dropped', () => {
    const h = labels({ performers: ['maravex'], venues: ['lumenhall'], titleTokens: ['rosa', 'quill', 'birthday'], titles: ['rosaquillbirthday'] });
    expect(namesHappening(personLabels(['Mara Vex'], []), h)).toBe(true);
    expect(namesHappening(personLabels(['Rosa Quill'], []), h)).toBe(true);
    expect(namesHappening(personLabels(['Rosa Other'], []), h)).toBe(false);
    expect(namesHappening(personLabels(['Nia Sample'], ['lumen.hall']), h)).toBe(true);
    expect(namesHappening(personLabels(['Nia Sample'], ['maravexmusic']), h)).toBe(true);
    expect(namesHappening(personLabels(['Nia Sample'], ['nia.sample']), h)).toBe(false);
    const performers = new Set(['neonharbor']);
    expect(isPerformer(personLabels(['Someone Else'], ['neonharbor.official']), performers)).toBe(true);
    expect(isPerformer(personLabels(['Neon Harbor'], []), performers)).toBe(true);
    expect(isPerformer(personLabels(['Nia Sample'], ['nia.sample']), performers)).toBe(false);
  });

  it('an artist-style handle around a performer name is the artist; a person who merely shares the name is not', () => {
    for (const h of ['marina', 'marina.official', 'itsmarina', 'marinamusic', 'the_marina', 'dj.marina', 'marina_tv2', 'realmarinaofficial']) {
      expect(handleIsPerformer(compact(h), 'marina')).toBe(true);
    }
    for (const h of ['marina.sample', 'marinas', 'samplemarina', 'mari']) expect(handleIsPerformer(compact(h), 'marina')).toBe(false);
    // A very short performer name only ever matches exactly.
    expect(handleIsPerformer('abc', 'abc')).toBe(true);
    expect(handleIsPerformer('abcofficial', 'abc')).toBe(false);
    const performers = new Set(['marina']);
    expect(isPerformer(personLabels(['Marina Sample'], ['marina.sample']), performers)).toBe(false);
    expect(isPerformer(personLabels(['Someone'], ['marina.official']), performers)).toBe(true);
    const h = labels({ performers: ['marina'], venues: ['lumenhall'] });
    expect(namesHappening(personLabels(['Marina Sample'], ['marina.sample']), h)).toBe(false);
    expect(namesHappening(personLabels(['Nia Sample'], ['itsmarina']), h)).toBe(true);
    expect(namesHappening(personLabels(['Nia Sample'], ['lumenhallnyc']), h)).toBe(true);
  });

  it('any ticket performer at all: the name exactly, or with an artist word around it; a year, an x or "its" is a person', () => {
    const performers = new Set(['dixon', 'maya', 'sasha', 'jordan', 'marina']);
    for (const h of ['dixon1994', 'maya92', 'maya.92', 'sashax', 'x.sasha.x', 'imjordan', 'itsjordan', 'realmarina', 'the_marina']) {
      expect(isPerformer(personLabels(['Lee Sample'], [h]), performers)).toBe(false);
    }
    for (const h of ['dixon', 'dixon.official', 'dixonmusic2', 'dj.maya', 'realmarinaofficial', 'marina_tv2', 'sasha.mgmt', 'itsjordanmusic']) {
      expect(isPerformer(personLabels(['Lee Sample'], [h]), performers)).toBe(true);
    }
    // At that performer's own show the usual affixes still mark the artist's account.
    const h = labels({ performers: ['dixon'] });
    for (const x of ['dixon1994', 'itsdixon', 'dixonx']) expect(namesHappening(personLabels(['Lee Sample'], [x]), h)).toBe(true);
  });
});
