/**
 * Collision-aware names: "First L." unless it reads as the owner's own short name or as another person named
 * alongside; then the full last name. Every name here is invented.
 */
import { describe, expect, it } from 'vitest';
import { briefNames } from '../../src/delivery/text';
import { collisionAware, nameKey, ownerNames } from '../../src/identity/ownerNames';
import { memDb, seedIdentity, seedPerson } from '../helpers';

const person = (id: string, firstName: string | null, lastName: string | null, displayName = [firstName, lastName].filter(Boolean).join(' ')) => ({
  id,
  firstName,
  lastName,
  displayName,
  nickname: null,
});
const owner = (firstName: string, lastName: string | null) => ({ firstName, lastName, displayName: '', nickname: null });

describe('briefNames', () => {
  it('keeps "First L." when nothing collides', () => {
    const ava = person('a', 'Ava', 'Quillfeather');
    const ben = person('b', 'Ben', 'Ostrander');
    const n = briefNames([ava, ben], [owner('Rowan', 'Teller')]);
    expect([n.of(ava), n.of(ben)]).toEqual(['Ava Q.', 'Ben O.']);
    expect([...n.ambiguousFirstNames]).toEqual(['Rowan']);
    // No owner known yet: nothing to collide with.
    expect(briefNames([ava], []).of(ava)).toBe('Ava Q.');
  });

  it('a short name that reads as the owner’s own gets the full last name; others with the first name keep the rule', () => {
    const friend = person('a', 'Ava', 'Quillfeather');
    const other = person('b', 'Ava', 'Brightwater');
    const n = briefNames([friend, other], [owner('Ava', 'Quinn')]);
    expect(n.of(friend)).toBe('Ava Quillfeather');
    expect(n.of(other)).toBe('Ava B.');
    // A first name that is the owner's doesn't pin anyone down in LLM copy.
    expect(n.ambiguousFirstNames.has('Ava')).toBe(true);
    // Case and spacing don't tell names apart.
    expect(briefNames([person('c', 'ava', 'quillfeather')], [owner('AVA', 'Quinn')]).of(person('c', 'ava', 'quillfeather'))).toBe('ava quillfeather');
  });

  it('two people with the same short name in one brief both get the full last name', () => {
    const a = person('a', 'Ben', 'Ostrander');
    const b = person('b', 'Ben', 'Osgood');
    const c = person('c', 'Cleo', 'Marsh');
    const n = briefNames([a, b, c, a], [owner('Rowan', 'Teller')]);
    expect([n.of(a), n.of(b), n.of(c)]).toEqual(['Ben Ostrander', 'Ben Osgood', 'Cleo M.']);
    expect(n.ambiguousFirstNames).toEqual(new Set(['Rowan', 'Ben']));
    // The same person twice (two items about one friend) is no collision.
    expect(briefNames([a, a], []).of(a)).toBe('Ben O.');
    // Identical full names stay full: nothing else in a name tells them apart.
    const twin = person('d', 'Ben', 'Ostrander');
    const t = briefNames([a, twin], []);
    expect([t.of(a), t.of(twin)]).toEqual(['Ben Ostrander', 'Ben Ostrander']);
  });

  it('without a last name there is nothing longer to use; display-name-only people collide by their display words', () => {
    const solo = person('a', 'Ava', null);
    expect(briefNames([solo], [owner('Ava', null)]).of(solo)).toBe('Ava');
    const shown = person('b', null, null, 'Ava Quillfeather');
    expect(briefNames([shown], [owner('Ava', 'Quinn')]).of(shown)).toBe('Ava Quillfeather');
  });
});

describe('collisionAware', () => {
  it('works with any short/long forms and reports who collided', () => {
    const forms = { short: (p: { id: string; n: string }) => p.n.slice(0, 3), long: (p: { id: string; n: string }) => p.n };
    const x = { id: 'x', n: 'abcdef' };
    const y = { id: 'y', n: 'abcxyz' };
    const z = { id: 'z', n: 'qrstuv' };
    const named = collisionAware([x, y, z], ['QRS'], forms);
    expect([named.of(x), named.of(y), named.of(z)]).toEqual(['abcdef', 'abcxyz', 'qrstuv']);
    expect(named.colliding).toEqual(new Set(['x', 'y', 'z']));
    // A person outside the set is checked against the owner and the set.
    expect(named.of({ id: 'w', n: 'abc123' })).toBe('abc123');
    expect(named.of({ id: 'v', n: 'mno123' })).toBe('mno');
    expect(nameKey('  Ava  Q. ')).toBe('ava q.');
  });
});

describe('ownerNames', () => {
  it('none before the owner row exists; the "Me" placeholder is no name', () => {
    const db = memDb();
    expect(ownerNames(db)).toEqual([]);
    seedPerson(db, { display_name: 'Me', first_name: null, last_name: null, kind: 'me', origin: 'system' });
    expect(ownerNames(db)).toEqual([]);
  });

  it('reads the owner’s Contacts card identity, the card fields (with a nickname) and records merged into me', () => {
    const db = memDb();
    const me = seedPerson(db, { display_name: 'Me', first_name: null, last_name: null, kind: 'me', origin: 'system' });
    const card = seedIdentity(db, me, 'addressbook_id', 'card-owner', { display_name: 'Ava  Quinn', source: 'addressbook', match_method: 'addressbook' });
    db.prepare(`INSERT INTO addressbook_cards (card_id, identity_id, content_hash, fields, first_seen_at, last_seen_at) VALUES (?, ?, 'h', ?, 0, 0)`).run(
      'card-owner',
      card,
      JSON.stringify({ displayName: 'Ava Quinn', given: 'Ava', family: 'Quinn', nickname: 'Avie', org: null, job: null, birthday: null }),
    );
    seedPerson(db, { display_name: 'Ava M. Quinn', first_name: 'Ava', last_name: 'Quinn', status: 'merged', merged_into_id: me });
    // Someone else's card says nothing about the owner.
    const other = seedPerson(db, { display_name: 'Ben Ostrander', first_name: 'Ben', last_name: 'Ostrander' });
    seedIdentity(db, other, 'addressbook_id', 'card-other', { display_name: 'Ben Ostrander', source: 'addressbook', match_method: 'addressbook' });

    const names = ownerNames(db);
    expect(names.map((n) => `${n.firstName} ${n.lastName}`).sort()).toEqual(['Ava Quinn', 'Ava Quinn', 'Ava Quinn', 'Avie Quinn']);
    const shorts = briefNames([person('x', 'Avie', 'Quillfeather'), person('y', 'Ben', 'Osgood')], names);
    expect(shorts.of(person('x', 'Avie', 'Quillfeather'))).toBe('Avie Quillfeather');
    expect(shorts.of(person('y', 'Ben', 'Osgood'))).toBe('Ben O.');
  });
});
