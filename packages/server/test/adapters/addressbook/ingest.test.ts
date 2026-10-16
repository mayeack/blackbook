/**
 * Address-book ingest on synthetic Contacts dumps (555-01xx numbers, example.com addresses, invented names), always
 * through the @yb/shared zod contract the collector client applies.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { ContactsResponse } from '@yb/shared/collector/v1';
import { cardBirthday, parseCard } from '../../../src/adapters/addressbook/cards';
import { applyContacts } from '../../../src/adapters/addressbook/ingest';
import { canonicalId } from '../../../src/db/canon';
import { linkIdentityToPerson } from '../../../src/identity/external';
import { sourceRun } from '../../../src/adapters/common/context';
import { undoBatch } from '../../../src/journal/undo';
import { memDb, seedIdentity, seedPerson, T0 } from '../../helpers';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const count = (db: DB, table: string, where = '1') => db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get() as number;
const person = (db: DB, id: string) =>
  db.prepare('SELECT display_name, first_name, last_name, nickname, company, job_title, birthday, status, kind FROM people WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
const identity = (db: DB, kind: string, key: string) =>
  db.prepare('SELECT id, person_id, status, shared, source FROM identities WHERE kind = ? AND key = ?').get(kind, key) as
    | { id: string; person_id: string; status: string; shared: number; source: string }
    | undefined;
const ownerOf = (db: DB, kind: string, key: string) => canonicalId(db, identity(db, kind, key)!.person_id);

type CardInput = Record<string, unknown> & { id: string };
const card = (id: string, o: Record<string, unknown> = {}): CardInput => ({ id, ...o });
/** A collector response, parsed by the v1 contract; the hash covers the items like the collector's does. */
const dump = (items: CardInput[], at = T0) =>
  ContactsResponse.parse({
    api: 'v1',
    generated_at: at,
    hash: crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    items,
  });
const tel = (value: string, label: string | null = 'mobile') => ({ label, value });

describe('cards', () => {
  it('reads social profiles by service (not label), instagram URLs, birthdays and display-name fallbacks', () => {
    const c = parseCard(
      ContactsResponse.parse({
        hash: 'h',
        items: [
          card('c1', {
            given: ' Robin ',
            family: 'Example',
            phones: [tel('(212) 555-0101'), tel('212-555-0101', 'home'), tel('24273', 'alerts')],
            emails: [tel('Robin@Example.com', 'work')],
            social: [
              { service: 'Instagram', username: '@Robin.Example', url: null },
              { service: 'Twitter', username: 'robin_tw' },
              { service: null, url: 'https://www.instagram.com/robin.alt/' },
            ],
            urls: ['https://instagram.com/robin.third?hl=en', { label: 'home', value: 'https://example.com' }],
            birthday: { y: 1604, m: 2, d: 29 },
          }),
        ],
      }).items[0]!,
    );
    expect(c.fields).toMatchObject({ displayName: 'Robin Example', given: 'Robin', family: 'Example', birthday: '--02-29' });
    expect(c.name).toEqual({ first: 'robin', last: 'example' });
    expect(c.keys.map((k) => `${k.norm.kind}:${k.norm.key}`)).toEqual([
      'phone:+12125550101',
      'email:robin@example.com',
      'instagram_username:robin.example',
      'instagram_username:robin.alt',
      'instagram_username:robin.third',
    ]);
    expect(cardBirthday({ y: 1990, m: 7, d: 4 })).toBe('1990-07-04');
    expect(cardBirthday({ y: null, m: 2, d: 30 })).toBeNull();
    const org = parseCard(ContactsResponse.parse({ hash: 'h', items: [card('c2', { org: 'Harbor Dental' })] }).items[0]!);
    expect(org.fields.displayName).toBe('Harbor Dental');
    expect(org.name).toBeNull();
    // The hash ignores fields yeackbot doesn't use.
    const a = parseCard(ContactsResponse.parse({ hash: 'h', items: [card('c3', { given: 'Ada' })] }).items[0]!);
    const b = parseCard(ContactsResponse.parse({ hash: 'h', items: [card('c3', { given: 'Ada', postal: [{ city: 'Springfield' }] })] }).items[0]!);
    expect(a.hash).toBe(b.hash);
  });
});

describe('applyContacts', () => {
  it('creates active people from new cards, with every key on the card, journaled; an unchanged dump is a no-op', () => {
    const db = memDb();
    const d = dump([
      card('card-1', {
        given: 'Robin',
        family: 'Example',
        nickname: 'Rob',
        org: 'Example Labs',
        job: 'Engineer',
        phones: [tel('+1 212 555 0101')],
        emails: [tel('robin@example.com')],
        social: [{ service: 'Instagram', username: 'robin.example' }],
        birthday: { m: 7, d: 4 },
      }),
    ]);
    const s = applyContacts(db, d, { now: T0 });
    expect(s).toMatchObject({ cards: 1, cards_new: 1, people_created: 1, keys_attached: 3 });
    const p = ownerOf(db, 'addressbook_id', 'card-1');
    expect(person(db, p)).toEqual({
      display_name: 'Robin Example',
      first_name: 'Robin',
      last_name: 'Example',
      nickname: 'Rob',
      company: 'Example Labs',
      job_title: 'Engineer',
      birthday: '--07-04',
      status: 'active',
      kind: 'person',
    });
    for (const [k, v] of [['phone', '+12125550101'], ['email', 'robin@example.com'], ['instagram_username', 'robin.example']] as const) {
      expect(ownerOf(db, k, v)).toBe(p);
      expect(identity(db, k, v)!.source).toBe('addressbook');
    }
    expect(db.prepare('SELECT kind FROM change_batches ORDER BY seq').pluck().all()).toEqual([
      'create_person',
      'attach_identity',
      'attach_identity',
      'attach_identity',
      'person_update',
    ]);
    expect(db.prepare(`SELECT kind, status FROM runs`).all()).toEqual([{ kind: 'ingest', status: 'ok' }]);
    expect(db.prepare(`SELECT status FROM source_health WHERE source = 'addressbook'`).pluck().get()).toBe('ok');

    const batches = count(db, 'change_batches');
    expect(applyContacts(db, d, { now: T0 + MIN })).toMatchObject({ dump_unchanged: 1 });
    // A different dump hash whose card content didn't change does nothing either.
    expect(applyContacts(db, { ...d, hash: 'other' }, { now: T0 + 2 * MIN })).toMatchObject({ cards_unchanged: 1, cards_changed: 0 });
    expect(count(db, 'change_batches')).toBe(batches);
  });

  it('links a card to the provisional person behind its phone, and unifies people across its keys', () => {
    const db = memDb();
    const prov = seedPerson(db, { display_name: '(212) •••-••01', first_name: null, last_name: null, status: 'provisional', origin: 'imessage' });
    seedIdentity(db, prov, 'phone', '+12125550101', { source: 'imessage' });
    const other = seedPerson(db, { display_name: 'r•••@example.com', first_name: null, last_name: null, status: 'provisional', origin: 'imessage' });
    seedIdentity(db, other, 'email', 'robin@example.com', { source: 'imessage' });

    const s = applyContacts(
      db,
      dump([card('card-1', { given: 'Robin', family: 'Example', phones: [tel('2125550101')], emails: [tel('robin@example.com')] })]),
      { now: T0 },
    );
    expect(s).toMatchObject({ cards_linked: 1, people_created: 0, keys_linked: 1, people_updated: 1 });
    expect(ownerOf(db, 'addressbook_id', 'card-1')).toBe(prov);
    expect(canonicalId(db, other)).toBe(prov);
    expect(person(db, prov)).toMatchObject({ display_name: 'Robin Example', status: 'active' });
    expect(db.prepare('SELECT method FROM merges').pluck().all()).toEqual(['deterministic']);
  });

  it('a legacy person keeps its card; Contacts names win unless the user locked the field', () => {
    const db = memDb();
    const legacy = seedPerson(db, {
      display_name: 'Sam Quill',
      first_name: 'Sam',
      last_name: 'Quill',
      origin: 'legacy',
      locked_fields: '["display_name"]',
    });
    seedIdentity(db, legacy, 'addressbook_id', 'card-9', { source: 'legacy' });
    applyContacts(db, dump([card('card-9', { given: 'Samuel', family: 'Quill-Ash', phones: [tel('212 555 0109')] })]), { now: T0 });
    expect(person(db, legacy)).toMatchObject({ display_name: 'Sam Quill', first_name: 'Samuel', last_name: 'Quill-Ash' });
    expect(ownerOf(db, 'phone', '+12125550109')).toBe(legacy);
  });

  it('shared landline: on two cards with incompatible names it is flagged shared and never merges them', () => {
    const db = memDb();
    const s = applyContacts(
      db,
      dump([
        card('card-a', { given: 'Ava', family: 'Stone', phones: [tel('+12125550150', 'home'), tel('+12125550151')] }),
        card('card-b', { given: 'Leo', family: 'Marsh', phones: [tel('+12125550150', 'home'), tel('+12125550152')] }),
      ]),
      { now: T0 },
    );
    expect(s).toMatchObject({ people_created: 2, shared_marked: 1 });
    const ava = ownerOf(db, 'addressbook_id', 'card-a');
    const leo = ownerOf(db, 'addressbook_id', 'card-b');
    expect(ava).not.toBe(leo);
    expect(identity(db, 'phone', '+12125550150')!.shared).toBe(1);
    expect(count(db, 'merges')).toBe(0);
    expect(ownerOf(db, 'phone', '+12125550152')).toBe(leo);
    // Never a merge key afterwards either.
    const shared = identity(db, 'phone', '+12125550150')!;
    const target = shared.person_id === ava ? leo : ava;
    expect(linkIdentityToPerson(sourceRun(db, 'whatsapp', { now: T0 }).ctx, shared.id, target)).toEqual({ outcome: 'held', reason: 'shared' });
  });

  it('two cards with compatible names and the same number are one person (deterministic, the only way cards merge)', () => {
    const db = memDb();
    applyContacts(
      db,
      dump([
        card('card-1', { given: 'Sam', family: 'Lee', phones: [tel('+12125550160')] }),
        card('card-2', { given: 'Samuel', family: 'Lee', emails: [tel('sam.lee@example.com')], phones: [tel('+12125550160')] }),
      ]),
      { now: T0 },
    );
    expect(ownerOf(db, 'addressbook_id', 'card-1')).toBe(ownerOf(db, 'addressbook_id', 'card-2'));
    expect(identity(db, 'phone', '+12125550160')!.shared).toBe(0);
  });

  it('holds a key whose established owner has a conflicting name', () => {
    const db = memDb();
    const quinn = seedPerson(db, { display_name: 'Quinn Harper', first_name: 'Quinn', last_name: 'Harper', origin: 'legacy' });
    seedIdentity(db, quinn, 'phone', '+12125550170');
    const s = applyContacts(db, dump([card('card-r', { given: 'Rowan', family: 'Ellis', phones: [tel('+12125550170')] })]), { now: T0 });
    expect(s).toMatchObject({ people_created: 1, keys_held: 1 });
    expect(ownerOf(db, 'phone', '+12125550170')).toBe(quinn);
    expect(count(db, 'merges')).toBe(0);
    expect(person(db, quinn).display_name).toBe('Quinn Harper');
    // A business card listing her number doesn't turn her into the business either.
    applyContacts(db, dump([card('card-biz', { org: 'Harbor Dental', phones: [tel('+12125550170', 'work')] })]), { now: T0 + MIN });
    expect(ownerOf(db, 'addressbook_id', 'card-biz')).not.toBe(quinn);
    expect(person(db, quinn).display_name).toBe('Quinn Harper');
  });

  it('my own card (two of my handles) attaches to me; a card with one of my numbers never takes it', () => {
    const db = memDb();
    const me = seedPerson(db, { kind: 'me', display_name: 'Me', first_name: null, last_name: null, origin: 'system' });
    seedIdentity(db, me, 'phone', '+12125550100', { match_method: 'seed' });
    seedIdentity(db, me, 'email', 'owner@example.com', { match_method: 'seed' });
    applyContacts(
      db,
      dump([
        card('card-me', { given: 'Owner', family: 'Person', phones: [tel('+12125550100')], emails: [tel('owner@example.com')] }),
        card('card-p', { given: 'Partner', family: 'Person', phones: [tel('+12125550100', 'home'), tel('+12125550180')] }),
      ]),
      { now: T0 },
    );
    expect(ownerOf(db, 'addressbook_id', 'card-me')).toBe(me);
    expect(person(db, me)).toMatchObject({ display_name: 'Me', kind: 'me' });
    const partner = ownerOf(db, 'addressbook_id', 'card-p');
    expect(partner).not.toBe(me);
    expect(ownerOf(db, 'phone', '+12125550100')).toBe(me);
    expect(ownerOf(db, 'phone', '+12125550180')).toBe(partner);
  });

  it('undoing a Contacts rename sticks until the card itself changes', () => {
    const db = memDb();
    const p = seedPerson(db, { display_name: 'Ada Lark', first_name: 'Ada', last_name: 'Lark', origin: 'legacy' });
    seedIdentity(db, p, 'addressbook_id', 'card-1');
    const v1 = dump([card('card-1', { given: 'Adaline', family: 'Lark' })]);
    applyContacts(db, v1, { now: T0 });
    expect(person(db, p).display_name).toBe('Adaline Lark');
    const rename = db.prepare(`SELECT id FROM change_batches WHERE kind = 'person_update'`).pluck().get() as string;
    undoBatch(db, rename, { now: T0 + MIN });
    expect(person(db, p).display_name).toBe('Ada Lark');
    applyContacts(db, v1, { now: T0 + 2 * MIN, force: true });
    expect(person(db, p).display_name).toBe('Ada Lark');
    applyContacts(db, dump([card('card-1', { given: 'Adaline', family: 'Lark', job: 'Pilot' })]), { now: T0 + 3 * MIN });
    expect(person(db, p)).toMatchObject({ display_name: 'Adaline Lark', job_title: 'Pilot' });
  });

  it('a removed card detaches its identity (journaled) and comes back with the card; a truncated dump removes nothing', () => {
    const db = memDb();
    const cards = Array.from({ length: 12 }, (_, i) => card(`card-${i}`, { given: `Name${'abcdefghijkl'[i]}`, family: 'Tester' }));
    applyContacts(db, dump(cards), { now: T0 });
    const s = applyContacts(db, dump(cards.slice(1)), { now: T0 + MIN });
    expect(s.cards_removed).toBe(1);
    expect(identity(db, 'addressbook_id', 'card-0')!.status).toBe('detached');
    expect(db.prepare(`SELECT title FROM change_batches ORDER BY seq DESC LIMIT 1`).pluck().get()).toBe('Contacts card removed');
    const back = applyContacts(db, dump(cards), { now: T0 + 2 * MIN });
    expect(back.cards_restored).toBe(1);
    expect(identity(db, 'addressbook_id', 'card-0')!.status).toBe('active');

    const truncated = applyContacts(db, dump([]), { now: T0 + 3 * MIN });
    expect(truncated).toMatchObject({ removals_held: 12, cards_removed: 0 });
    expect(count(db, 'identities', `kind = 'addressbook_id' AND status = 'active'`)).toBe(12);
  });

  it('an undone card person stays undone', () => {
    const db = memDb();
    applyContacts(db, dump([card('card-1', { given: 'Iris', family: 'Fenwick', phones: [tel('+12125550190')] })]), { now: T0 });
    const created = db.prepare(`SELECT id FROM change_batches WHERE kind = 'create_person'`).pluck().get() as string;
    undoBatch(db, created, { now: T0 + MIN, cascade: true });
    const p = identity(db, 'addressbook_id', 'card-1')!.person_id;
    expect(person(db, p).status).toBe('suppressed');
    const s = applyContacts(db, dump([card('card-1', { given: 'Iris', family: 'Fenwick', job: 'Sculptor', phones: [tel('+12125550190')] })]), {
      now: T0 + 2 * MIN,
    });
    expect(s.cards_skipped).toBe(1);
    expect(person(db, p).status).toBe('suppressed');
    expect(count(db, 'people', `origin = 'addressbook' AND status <> 'suppressed'`)).toBe(0);
  });
});
