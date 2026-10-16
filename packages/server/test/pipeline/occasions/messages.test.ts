import { describe, expect, it } from 'vitest';
import { localDate } from '@yb/shared';
import { MessageScanner, type OccasionWindow } from '../../../src/pipeline/occasions/messages';
import { PeopleIndex } from '../../../src/pipeline/occasions/people';
import { buildWorld, evening, HOUR, TZ } from './world';

const win = (day: number, hours = 3): OccasionWindow => ({
  startsAt: evening(day),
  endsAt: evening(day) + hours * HOUR,
  allDay: false,
  days: new Set([localDate(evening(day), TZ)]),
  tokens: ['dinner', 'kettle'],
  strong: new Set(['kettle']),
  kindWords: new Set(['dinner']),
});

describe('message scanner window', () => {
  it('the sliding window answers exactly like a fresh read, whatever order the occasions come in', () => {
    const w = buildWorld();
    const people = new PeopleIndex(w.db);
    const shared = new MessageScanner(w.db, people, TZ);
    let scanned = 0;
    // forward (the pass's order), overlapping and disjoint jumps, a long occasion, then backwards
    for (const [day, hours] of [[-60, 3], [-40, 3], [-31, 3], [-30, 3], [-30, 72], [-10, 3], [-3, 3], [-2, 3], [1, 3], [-45, 3], [-5, 3]] as const) {
      const fresh = new MessageScanner(w.db, people, TZ).scan(win(day, hours));
      const got = shared.scan(win(day, hours));
      expect(got).toEqual(fresh);
      scanned += got.scanned;
    }
    expect(scanned).toBeGreaterThan(0);
  });
});
