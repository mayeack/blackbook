import { describe, expect, it } from 'vitest';
import { rebuildPersonCanon } from '../../../src/db/canon';
import { closenessOf, closenessScore, meetsCloseness } from '../../../src/pipeline/ties/closeness';
import { memDb, seedPerson, T0 } from '../../helpers';

describe('closeness 1–10', () => {
  it('spreads shown people over 2–10 from max(T, H/2); the background is 1', () => {
    const at = (tie: number | null, historical: number | null = null) => closenessScore({ tie, historical, shown: true });
    expect([at(95), at(80), at(79.9), at(65), at(50), at(40), at(30), at(22), at(15), at(7), at(6.9), at(0)]).toEqual([10, 10, 9, 9, 8, 7, 6, 5, 4, 3, 2, 2]);
    expect(at(null)).toBe(2); // shown, no stats yet
    expect(at(5, 90)).toBe(7); // an old close friend gone quiet keeps half of their history
    expect(at(60, 20)).toBe(8); // history never pulls someone down
    expect(at(Number.NaN, null)).toBe(2);
    expect(closenessScore({ tie: 99, historical: 99, shown: false })).toBe(1);
  });

  it('reads a person: roster-only / hidden / service = 1, shown without stats = 2, merged-away ids resolve', () => {
    const db = memDb();
    const close = seedPerson(db, { display_name: 'Close Example' });
    const fresh = seedPerson(db, { display_name: 'Fresh Example' });
    const seen = seedPerson(db, { display_name: 'Seen Example', status: 'roster_only' });
    const hidden = seedPerson(db, { display_name: 'Hidden Example', is_hidden: 1 });
    const svc = seedPerson(db, { display_name: 'Service Example', status: 'service' });
    const dup = seedPerson(db, { display_name: 'Close Dup', status: 'merged', merged_into_id: close });
    rebuildPersonCanon(db);
    const stat = db.prepare('INSERT INTO person_stats (person_id, tie_strength, historical_strength, computed_at) VALUES (?, ?, ?, ?)');
    stat.run(close, 72, 80, T0);
    stat.run(hidden, 90, 90, T0);
    expect([close, dup, fresh, seen, hidden, svc].map((id) => closenessOf(db, id))).toEqual([9, 9, 2, 1, 1, 1]);
    expect(closenessOf(db, 'no-such-person')).toBe(1);
  });

  it('the owner’s own asks win over a feature’s minimum', () => {
    expect(meetsCloseness(7, 7)).toBe(true);
    expect(meetsCloseness(4, 7)).toBe(false);
    expect(meetsCloseness(4, 7, { priority: true })).toBe(true);
    expect(meetsCloseness(1, 7, { requested: true })).toBe(true);
  });
});
