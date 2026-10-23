/**
 * addressbook_cards.created_at (docs/design/tickets-met-at.md, review amendment [col]): every ingest pass fills it
 * from the collector's AddressBook creation date with one batched coalesce UPDATE, on both fast paths (unchanged
 * dump hash; unchanged card content_hash), outside content_hash, never overwriting a known value. Synthetic dumps
 * only (555-01xx numbers, example.com addresses, invented names), parsed through the @yb/shared v1 contract.
 */
import { describe, expect, it } from 'vitest';
import { ContactsResponse } from '@yb/shared/collector/v1';
import { cardCreatedAt, parseCard } from '../../../src/adapters/addressbook/cards';
import { applyContacts, fillCreatedAt } from '../../../src/adapters/addressbook/ingest';
import { memDb, T0 } from '../../helpers';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const DAY = 86_400_000;
const MARCH = Date.parse('2026-03-03T18:04:05.250Z');
const OCTOBER = Date.parse('2026-10-12T21:30:00.000Z');

type CardInput = Record<string, unknown> & { id: string };
const robin = (o: Record<string, unknown> = {}): CardInput => ({
  id: 'card-1',
  given: 'Robin',
  family: 'Example',
  phones: [{ label: 'mobile', value: '+1 212 555 0101' }],
  ...o,
});
const avery = (o: Record<string, unknown> = {}): CardInput => ({
  id: 'card-2',
  given: 'Avery',
  family: 'Sample',
  emails: [{ label: 'home', value: 'avery@example.com' }],
  ...o,
});
const dump = (items: CardInput[], hash: string) => ContactsResponse.parse({ api: 'v1', generated_at: T0, hash, items });

const createdAt = (db: DB) =>
  Object.fromEntries(
    (db.prepare('SELECT card_id, created_at FROM addressbook_cards ORDER BY card_id').all() as { card_id: string; created_at: number | null }[]).map(
      (r) => [r.card_id, r.created_at],
    ),
  );
const contentHashes = (db: DB) => db.prepare('SELECT content_hash FROM addressbook_cards ORDER BY card_id').pluck().all();
const batches = (db: DB) => db.prepare('SELECT count(*) FROM change_batches').pluck().get() as number;

describe('card created_at', () => {
  it('parses the collector ISO timestamp to ms, outside the content hash, and drops implausible values', () => {
    const [withDate, without] = ContactsResponse.parse({
      hash: 'h',
      items: [robin({ created_at: '2026-03-03T18:04:05.250Z' }), robin({ created_at: null })],
    }).items;
    const a = parseCard(withDate!, T0);
    const b = parseCard(without!, T0);
    expect(a.createdAt).toBe(MARCH);
    expect(b.createdAt).toBeNull();
    expect(a.hash).toBe(b.hash);
    // An older collector omits the field entirely.
    expect(ContactsResponse.parse({ hash: 'h', items: [robin()] }).items[0]!.created_at).toBeNull();

    expect(cardCreatedAt(MARCH + 0.4, T0)).toBe(MARCH);
    expect(cardCreatedAt(Date.UTC(2001, 0, 1), T0)).toBeNull();
    expect(cardCreatedAt(Date.UTC(1999, 5, 1), T0)).toBeNull();
    expect(cardCreatedAt(T0 + DAY, T0)).toBe(T0 + DAY);
    expect(cardCreatedAt(T0 + DAY + 1, T0)).toBeNull();
    expect(cardCreatedAt(Number.NaN, T0)).toBeNull();
    expect(cardCreatedAt(null, T0)).toBeNull();
  });

  it('a new card gets its creation date on the full pass', () => {
    const db = memDb();
    const s = applyContacts(db, dump([robin({ created_at: MARCH }), avery()], 'h1'), { now: T0 });
    expect(s).toMatchObject({ cards_new: 2, created_at_filled: 1 });
    expect(createdAt(db)).toEqual({ 'card-1': MARCH, 'card-2': null });
  });

  it('fast path 1: an unchanged dump hash still fills created_at, in one pass, without re-applying any card', () => {
    const db = memDb();
    // The first dump came from a collector that could not read creation dates.
    applyContacts(db, dump([robin(), avery()], 'same'), { now: T0 });
    expect(createdAt(db)).toEqual({ 'card-1': null, 'card-2': null });
    const hashes = contentHashes(db);
    const before = batches(db);
    const runs = db.prepare('SELECT count(*) FROM runs').pluck().get();

    // The updated collector keeps the dump hash (created_at is outside it) and now carries the dates.
    const s = applyContacts(db, dump([robin({ created_at: MARCH }), avery({ created_at: '2026-10-12T21:30:00.000Z' })], 'same'), {
      now: T0 + MIN,
    });
    expect(s).toMatchObject({ dump_unchanged: 1, created_at_filled: 2, cards_changed: 0 });
    expect(createdAt(db)).toEqual({ 'card-1': MARCH, 'card-2': OCTOBER });
    expect(contentHashes(db)).toEqual(hashes);
    expect(batches(db)).toBe(before);
    expect(db.prepare('SELECT count(*) FROM runs').pluck().get()).toBe(runs);
  });

  it('fast path 2: a new dump hash whose cards are unchanged fills created_at without re-applying them', () => {
    const db = memDb();
    applyContacts(db, dump([robin(), avery()], 'h1'), { now: T0 });
    const hashes = contentHashes(db);
    const before = batches(db);

    const s = applyContacts(db, dump([robin({ created_at: MARCH }), avery()], 'h2'), { now: T0 + MIN });
    expect(s).toMatchObject({ dump_unchanged: 0, cards_unchanged: 2, cards_changed: 0, cards_new: 0, created_at_filled: 1 });
    expect(createdAt(db)).toEqual({ 'card-1': MARCH, 'card-2': null });
    expect(contentHashes(db)).toEqual(hashes);
    expect(batches(db)).toBe(before);
  });

  it('a forced pass after the collector update fills it too, re-applying nothing unchanged', () => {
    const db = memDb();
    applyContacts(db, dump([robin(), avery()], 'same'), { now: T0 });
    const hashes = contentHashes(db);
    const before = batches(db);

    const s = applyContacts(db, dump([robin({ created_at: MARCH }), avery({ created_at: OCTOBER })], 'same'), { now: T0 + MIN, force: true });
    expect(s).toMatchObject({ dump_unchanged: 0, cards_unchanged: 2, cards_changed: 0, created_at_filled: 2 });
    expect(createdAt(db)).toEqual({ 'card-1': MARCH, 'card-2': OCTOBER });
    expect(contentHashes(db)).toEqual(hashes);
    expect(batches(db)).toBe(before);
  });

  it('a known value is never overwritten, not by a later date, an earlier one, or a missing one', () => {
    const db = memDb();
    let hash = 'h1';
    applyContacts(db, dump([robin({ created_at: MARCH })], hash), { now: T0 });
    for (const [i, value] of [OCTOBER, MARCH - 30 * DAY, null].entries()) {
      // The current hash (fast path 1) and a fresh hash with a content change (full pass) both keep it.
      const same = applyContacts(db, dump([robin({ created_at: value })], hash), { now: T0 + (2 * i + 1) * MIN });
      expect(same).toMatchObject({ dump_unchanged: 1, created_at_filled: 0 });
      hash = `h-${i}`;
      const changed = applyContacts(db, dump([robin({ created_at: value, job: `Role ${i}` })], hash), { now: T0 + (2 * i + 2) * MIN });
      expect(changed).toMatchObject({ cards_changed: 1, created_at_filled: 0 });
      expect(createdAt(db)).toEqual({ 'card-1': MARCH });
    }
  });

  it('cards without a stored row and implausible dates are left alone; the helper is one statement', () => {
    const db = memDb();
    applyContacts(db, dump([robin(), avery()], 'h1'), { now: T0 });
    const future = T0 + 3 * DAY;
    const s = applyContacts(db, dump([robin({ created_at: future }), avery({ created_at: '1999-12-31T00:00:00.000Z' })], 'h1'), { now: T0 + MIN });
    expect(s.created_at_filled).toBe(0);
    expect(createdAt(db)).toEqual({ 'card-1': null, 'card-2': null });

    const parsed = ContactsResponse.parse({ hash: 'h', items: [robin({ created_at: MARCH }), { id: 'card-unknown', given: 'Nobody', created_at: MARCH }] });
    expect(fillCreatedAt(db, parsed.items.map((c) => parseCard(c, T0)))).toBe(1);
    expect(fillCreatedAt(db, [])).toBe(0);
    expect(createdAt(db)).toEqual({ 'card-1': MARCH, 'card-2': null });
  });
});
