import { describe, expect, it } from 'vitest';
import { CanonCycleError, canonicalId, canonicalMembers, computeCanon, rebuildPersonCanon } from '../src/db/canon';
import { memDb, seedPerson } from './helpers';

describe('person canon', () => {
  it('resolves chains to their root', () => {
    const canon = computeCanon(
      new Map<string, string | null>([
        ['a', 'b'],
        ['b', 'c'],
        ['c', null],
        ['d', 'c'],
        ['e', null],
      ]),
    );
    expect(Object.fromEntries(canon)).toEqual({ a: 'c', b: 'c', c: 'c', d: 'c', e: 'e' });
  });

  it('rejects cycles', () => {
    const pointers = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['x', 'a'],
    ]);
    expect(() => computeCanon(pointers)).toThrow(CanonCycleError);
    try {
      computeCanon(pointers);
    } catch (e) {
      expect(new Set((e as CanonCycleError).cycle)).toEqual(new Set(['a', 'b', 'c']));
    }
    expect(() => computeCanon(new Map([['self', 'self']]))).toThrow(CanonCycleError);
  });

  it('rebuilds person_canon from merged_into_id and leaves it untouched on a cycle', () => {
    const db = memDb();
    const c = seedPerson(db);
    const b = seedPerson(db, { status: 'merged', merged_into_id: c });
    const a = seedPerson(db, { status: 'merged', merged_into_id: b });
    expect(rebuildPersonCanon(db)).toEqual({ people: 3, merged: 2 });
    const canon = Object.fromEntries(
      (db.prepare('SELECT person_id, canonical_id FROM person_canon').all() as { person_id: string; canonical_id: string }[]).map((r) => [
        r.person_id,
        r.canonical_id,
      ]),
    );
    expect(canon).toEqual({ [a]: c, [b]: c, [c]: c });
    expect(canonicalId(db, a)).toBe(c);
    expect(new Set(canonicalMembers(db, c))).toEqual(new Set([a, b, c]));

    const before = db.prepare('SELECT * FROM person_canon ORDER BY person_id').all();
    db.prepare(`UPDATE people SET merged_into_id = ?, status = 'merged' WHERE id = ?`).run(a, c); // c → a → b → c
    expect(() => rebuildPersonCanon(db)).toThrow(CanonCycleError);
    expect(() => canonicalId(db, a)).toThrow(CanonCycleError);
    expect(db.prepare('SELECT * FROM person_canon ORDER BY person_id').all()).toEqual(before);
  });
});
