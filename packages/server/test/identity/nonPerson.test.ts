import { describe, expect, it } from 'vitest';
import { looksLikeOrganization, organizationPeople } from '../../src/identity/nonPerson';
import { memDb, seedIdentity, seedPerson } from '../helpers';

describe('looksLikeOrganization', () => {
  it('venue and business words mark any record, as whole words, accents folded', () => {
    for (const name of ['Gallery on Main', 'Harbor Hotel', 'Acme Events LLC', 'Night Owl Presents', 'CLUB AURORA', 'Café Luna', 'KX.RADIO.CLUB', 'Agave Azul Tequila']) {
      expect(looksLikeOrganization(name, false), name).toBe(true);
      expect(looksLikeOrganization(name, true), name).toBe(true);
    }
    expect(looksLikeOrganization('Clubber Lang', false)).toBe(false);
    expect(looksLikeOrganization('Inca Rivera', false)).toBe(false);
  });

  it('weaker words and emoji-only names count only for Partiful/Instagram-only records', () => {
    for (const name of ['Pier Beach', 'Night Shift Squad', 'Bloom Music Group', 'Sunday Wine', '🌿🍃']) {
      expect(looksLikeOrganization(name, false), name).toBe(true);
      expect(looksLikeOrganization(name, true), name).toBe(false);
    }
  });

  it('people stay people: plain names, handles, first names that are words, phone numbers', () => {
    for (const name of ['Avery Quinn', 'j4ke', '@sam__k', 'Bar Levi', 'Honey', 'zoë', '⋆ Dana ⋆', '+1 202 555 0101', '(202) •••-••01']) {
      expect(looksLikeOrganization(name, false), name).toBe(false);
    }
  });
});

describe('organizationPeople', () => {
  it('a weak word is enough only when nothing came from Contacts, Messages or WhatsApp', () => {
    const db = memDb();
    const promoter = seedPerson(db, { display_name: 'Pier Beach', first_name: 'Pier', last_name: 'Beach' });
    seedIdentity(db, promoter, 'partiful_user', 'pf-1', { source: 'partiful' });
    seedIdentity(db, promoter, 'instagram_username', 'pierbeach', { source: 'partiful' });
    const friend = seedPerson(db, { display_name: 'Sandy Beach', first_name: 'Sandy', last_name: 'Beach' });
    seedIdentity(db, friend, 'partiful_user', 'pf-2', { source: 'partiful' });
    seedIdentity(db, friend, 'phone', '+12025550102', { source: 'addressbook' });
    const venue = seedPerson(db, { display_name: 'Harbor Hotel', first_name: 'Harbor', last_name: 'Hotel' });
    const hidden = seedPerson(db, { display_name: 'Quiet Lounge', first_name: 'Quiet', last_name: 'Lounge', is_hidden: 1 });
    expect([...organizationPeople(db)].sort()).toEqual([promoter, venue].sort());
    expect(organizationPeople(db).has(hidden)).toBe(false); // not visible anyway
  });
});
