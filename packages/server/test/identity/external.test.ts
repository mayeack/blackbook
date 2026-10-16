import { describe, expect, it } from 'vitest';
import { sourceRun } from '../../src/adapters/common/context';
import { episodeWriter } from '../../src/adapters/common/episodes';
import { canonicalId } from '../../src/db/canon';
import {
  attachExternalIdentity,
  linkIdentityToPerson,
  normalizeExternalKey,
  personOfIdentity,
  refreshDisplayName,
} from '../../src/identity/external';
import { LINK_ALERT_SOURCE } from '../../src/identity/linkHolds';
import { coPresentSets } from '../../src/identity/matcherGuards';
import { runMatcher } from '../../src/identity/matcher';
import { undoBatch } from '../../src/journal/undo';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const count = (db: DB, table: string, where = '1') => db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get() as number;
const person = (db: DB, id: string) =>
  db.prepare('SELECT display_name, status, kind, merged_into_id FROM people WHERE id = ?').get(id) as {
    display_name: string;
    status: string;
    kind: string;
    merged_into_id: string | null;
  };
const identityOf = (db: DB, id: string) =>
  db.prepare('SELECT kind, key, status, person_id, source FROM identities WHERE id = ?').get(id) as Record<string, unknown>;

const ctxFor = (db: DB, source: string, now = T0) => sourceRun(db, source, { now }).ctx;
let attSeq = 0;
/** An attendee row on an occasion or a Partiful event (seed state, outside the journal). */
const attend = (db: DB, where: { occasion?: string; event?: string }, personId: string, status: string, source: string) =>
  db
    .prepare(
      `INSERT INTO event_attendees (id, event_id, occasion_id, person_id, status, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0.9, ?, ?)`,
    )
    .run(`att-${++attSeq}`, where.event ?? null, where.occasion ?? null, personId, status, source, T0, T0);
const occasion = (db: DB, eventId: string | null = null) => {
  const id = `occ-${++attSeq}`;
  db.prepare(`INSERT INTO occasions (id, kind, title, starts_at, event_id, is_social, created_at, updated_at) VALUES (?, 'social', 'Dinner', ?, ?, 1, ?, ?)`).run(id, T0 - 86_400_000, eventId, T0, T0);
  return id;
};
const partifulEvent = (db: DB) => {
  const id = `ev-${++attSeq}`;
  db.prepare(`INSERT INTO events (id, source, source_event_id, title, starts_at, created_at, updated_at) VALUES (?, 'partiful', ?, 'Party', ?, ?, ?)`).run(id, id, T0 - 86_400_000, T0, T0);
  return id;
};
const linkAlert = (db: DB) => db.prepare('SELECT message FROM alerts WHERE source = ? AND resolved_at IS NULL').pluck().get(LINK_ALERT_SOURCE) as string | undefined;
/** "<user>@<server>" built at runtime (the PII lint would read a literal JID as an email address). */
const jid = (user: string, server = 's.whatsapp.net') => [user, server].join('@');

describe('normalizeExternalKey', () => {
  it('normalizes per kind', () => {
    expect(normalizeExternalKey('instagram_username', '@Robin.Example')).toEqual({ kind: 'instagram_username', key: 'robin.example', confidence: 1 });
    expect(normalizeExternalKey('instagram_username', 'https://www.instagram.com/robin_ex/?hl=en')?.key).toBe('robin_ex');
    expect(normalizeExternalKey('instagram_username', 'not a handle!')).toBeNull();
    expect(normalizeExternalKey('instagram_id', ' 1234567890 ')).toEqual({ kind: 'instagram_id', key: '1234567890', confidence: 1 });
    expect(normalizeExternalKey('instagram_id', 'abc')).toBeNull();
    // A WhatsApp phone JID is the phone itself (same identity as iMessage); device suffixes are dropped.
    expect(normalizeExternalKey('whatsapp_jid', jid('12125550101'))).toEqual({ kind: 'phone', key: '+12125550101', confidence: 1 });
    expect(normalizeExternalKey('whatsapp_jid', jid('12125550101:7'))?.key).toBe('+12125550101');
    expect(normalizeExternalKey('whatsapp_jid', jid('12125550101', 'c.us'))?.key).toBe('+12125550101');
    expect(normalizeExternalKey('whatsapp_jid', jid('120363000000000000', 'g.us'))).toBeNull();
    expect(normalizeExternalKey('whatsapp_jid', 'status@broadcast')).toBeNull();
    expect(normalizeExternalKey('whatsapp_jid', jid('99999'))).toEqual({ kind: 'whatsapp_jid', key: jid('99999'), confidence: 0.5 });
    // LIDs stay their own kind, with or without the server part.
    expect(normalizeExternalKey('whatsapp_lid', jid('201234567890123', 'lid'))).toEqual({ kind: 'whatsapp_lid', key: jid('201234567890123', 'lid'), confidence: 1 });
    expect(normalizeExternalKey('whatsapp_lid', '201234567890123:3')?.key).toBe(jid('201234567890123', 'lid'));
    expect(normalizeExternalKey('whatsapp_jid', jid('201234567890123', 'lid'))?.kind).toBe('whatsapp_lid');
    expect(normalizeExternalKey('partiful_user', '  uXyZ123  ')).toEqual({ kind: 'partiful_user', key: 'uXyZ123', confidence: 1 });
    expect(normalizeExternalKey('addressbook_id', 'ABCD-1234:ABPerson')?.key).toBe('ABCD-1234:ABPerson');
    expect(normalizeExternalKey('beeper_user', '')).toBeNull();
    expect(normalizeExternalKey('instagram_name', 'ig_dyi:t1:Robin   Example')).toEqual({ kind: 'instagram_name', key: 'ig_dyi:t1:Robin Example', confidence: 0.5 });
    expect(normalizeExternalKey('email', 'Robin@Example.com')).toEqual({ kind: 'email', key: 'robin@example.com', confidence: 1 });
    expect(normalizeExternalKey('phone', '(212) 555-0102')).toEqual({ kind: 'phone', key: '+12125550102', confidence: 1 });
    expect(normalizeExternalKey('phone', 'robin@example.com')).toBeNull();
  });
});

describe('attachExternalIdentity', () => {
  it('a WhatsApp phone JID lands on the existing iMessage phone identity', () => {
    const db = memDb();
    const robin = seedPerson(db, { display_name: 'Robin Example' });
    const phone = seedIdentity(db, robin, 'phone', '+12125550101', { source: 'imessage' });
    const id = attachExternalIdentity(ctxFor(db, 'whatsapp'), { kind: 'whatsapp_jid', key: jid('12125550101'), at: T0 + MIN });
    expect(id).toBe(phone);
    expect(count(db, 'people')).toBe(1);
    expect(count(db, 'change_batches')).toBe(0);
    expect(db.prepare('SELECT last_seen_at FROM identities WHERE id = ?').pluck().get(phone)).toBe(T0 + MIN);
  });

  it('creates roster_only / provisional / service / active people per §1.3–1.4, journaled', () => {
    const db = memDb();
    const ctx = ctxFor(db, 'beeper');
    const quiet = attachExternalIdentity(ctx, { kind: 'instagram_username', key: '@quiet.one' })!;
    const chatty = attachExternalIdentity(ctx, { kind: 'instagram_username', key: 'chatty.one', signals: { theirs: 2 } })!;
    const mine = attachExternalIdentity(ctx, { kind: 'instagram_username', key: 'texted.one', signals: { fromMe: 1 } })!;
    const rsvp = attachExternalIdentity(ctxFor(db, 'partiful'), { kind: 'partiful_user', key: 'p-1', signals: { qualifies: true } })!;
    const bot = attachExternalIdentity(ctx, { kind: 'beeper_user', key: 'b-bot', signals: { service: 'chatbot' } })!;
    const card = attachExternalIdentity(ctxFor(db, 'addressbook'), { kind: 'addressbook_id', key: 'card-1', displayName: 'Card Person' })!;
    const statusOf = (identityId: string) => person(db, personOfIdentity(db, identityId)!);
    expect(statusOf(quiet)).toMatchObject({ status: 'roster_only', display_name: '@quiet.one', kind: 'person' });
    expect(statusOf(chatty).status).toBe('provisional');
    expect(statusOf(mine).status).toBe('provisional');
    expect(statusOf(rsvp)).toMatchObject({ status: 'provisional', display_name: 'Partiful guest' });
    expect(statusOf(bot)).toMatchObject({ status: 'service', kind: 'bot' });
    expect(identityOf(db, bot).status).toBe('service');
    expect(statusOf(card)).toMatchObject({ status: 'active', display_name: 'Card Person' });
    expect(count(db, 'change_batches', `kind = 'create_person'`)).toBe(6);
    expect(count(db, 'person_canon')).toBe(6);
    // Idempotent: the same key again is the same identity, with nothing new journaled.
    expect(attachExternalIdentity(ctx, { kind: 'instagram_username', key: 'Quiet.One' })).toBe(quiet);
    expect(count(db, 'change_batches')).toBe(6);
    // Keys that don't normalize write nothing.
    expect(attachExternalIdentity(ctx, { kind: 'whatsapp_jid', key: jid('120363000000000000', 'g.us') })).toBeNull();
    expect(count(db, 'identities')).toBe(6);
  });

  it('promotes a roster_only person once stored messages qualify it (§1.4)', () => {
    const db = memDb();
    const ctx = ctxFor(db, 'beeper');
    const ig = attachExternalIdentity(ctx, { kind: 'instagram_id', key: '1111' })!;
    const p = personOfIdentity(db, ig)!;
    expect(person(db, p).status).toBe('roster_only');
    const w = episodeWriter(db, { now: T0 });
    const conv = w.upsertConversation({ source: 'beeper', sourceConvId: 'dm', kind: 'direct' }).id;
    w.upsertMember(conv, ig, { source: 'roster', at: T0 });
    w.upsertMessage({
      source: 'beeper',
      sourceMsgId: 'm1',
      conversationId: conv,
      senderIdentityId: null,
      isFromMe: true,
      sentAt: T0,
      kind: 'text',
      text: 'synthetic',
    });
    attachExternalIdentity(ctx, { kind: 'instagram_id', key: '1111' });
    expect(person(db, p).status).toBe('provisional');
    expect(db.prepare(`SELECT kind FROM change_batches ORDER BY seq`).pluck().all()).toEqual(['create_person', 'person_update']);
  });

  it('display names follow the precedence and never replace legacy, user or locked names', () => {
    const db = memDb();
    const ig = attachExternalIdentity(ctxFor(db, 'partiful'), { kind: 'instagram_username', key: 'robin.ex', displayName: 'Rob E' })!;
    const p = personOfIdentity(db, ig)!;
    expect(person(db, p).display_name).toBe('Rob E');
    // Beeper fullName outranks a Partiful name; a later Partiful name doesn't win it back.
    attachExternalIdentity(ctxFor(db, 'beeper', T0 + MIN), { kind: 'instagram_username', key: 'robin.ex', displayName: 'Robin Example', at: T0 + MIN });
    expect(person(db, p).display_name).toBe('Robin Example');
    attachExternalIdentity(ctxFor(db, 'partiful', T0 + 2 * MIN), { kind: 'instagram_username', key: 'robin.ex', displayName: 'R.E.', at: T0 + 2 * MIN });
    expect(person(db, p).display_name).toBe('Robin Example');
    expect(db.prepare('SELECT source, name_raw FROM alias_obs ORDER BY id').all()).toEqual([
      { source: 'partiful', name_raw: 'Rob E' },
      { source: 'beeper', name_raw: 'Robin Example' },
      { source: 'partiful', name_raw: 'R.E.' },
    ]);
    // A re-read of the same sighting doesn't bump seen_count; a later one does.
    attachExternalIdentity(ctxFor(db, 'beeper', T0 + MIN), { kind: 'instagram_username', key: 'robin.ex', displayName: 'Robin Example', at: T0 + MIN });
    attachExternalIdentity(ctxFor(db, 'beeper', T0 + 3 * MIN), { kind: 'instagram_username', key: 'robin.ex', displayName: 'Robin Example', at: T0 + 3 * MIN });
    expect(db.prepare(`SELECT seen_count FROM alias_obs WHERE source = 'beeper'`).pluck().get()).toBe(2);

    // A legacy name is not derived from observations, so it stays.
    const legacy = seedPerson(db, { display_name: 'Sam Quill', origin: 'legacy' });
    const lphone = seedIdentity(db, legacy, 'phone', '+12125550103');
    attachExternalIdentity(ctxFor(db, 'whatsapp'), { kind: 'whatsapp_jid', key: jid('12125550103'), displayName: 'Sammy' });
    expect(person(db, legacy).display_name).toBe('Sam Quill');
    expect(db.prepare('SELECT name_raw FROM alias_obs WHERE identity_id = ?').pluck().all(lphone)).toEqual(['Sammy']);
    // A masked placeholder is replaced, unless the user locked the name.
    const masked = seedPerson(db, { display_name: '(212) •••-••04', status: 'provisional' });
    seedIdentity(db, masked, 'phone', '+12125550104');
    attachExternalIdentity(ctxFor(db, 'whatsapp'), { kind: 'phone', key: '+12125550104', displayName: 'Drew Sample' });
    expect(person(db, masked).display_name).toBe('Drew Sample');
    const locked = seedPerson(db, { display_name: '(212) •••-••05', status: 'provisional', locked_fields: '["display_name"]' });
    seedIdentity(db, locked, 'phone', '+12125550105');
    attachExternalIdentity(ctxFor(db, 'addressbook'), { kind: 'phone', key: '+12125550105', displayName: 'Emery Vale' });
    expect(person(db, locked).display_name).toBe('(212) •••-••05');
    expect(refreshDisplayName(ctxFor(db, 'addressbook'), locked)).toBe(false);
  });

  it('personId attaches a new key to a known person (undoable), and links an existing one', () => {
    const db = memDb();
    const ctx = ctxFor(db, 'beeper');
    const ig = attachExternalIdentity(ctx, { kind: 'instagram_id', key: '2222', displayName: 'Robin Example' })!;
    const p = personOfIdentity(db, ig)!;
    const user = attachExternalIdentity(ctx, { kind: 'instagram_username', key: 'robin.ex', personId: p })!;
    expect(personOfIdentity(db, user)).toBe(p);
    const attach = db.prepare(`SELECT id FROM change_batches WHERE kind = 'attach_identity'`).pluck().get() as string;
    expect(attach).toBeTruthy();
    undoBatch(db, attach, { now: T0 + MIN });
    expect(personOfIdentity(db, user)).not.toBe(p);
    expect(count(db, 'identity_blocks', `kind = 'instagram_username'`)).toBe(1);

    // An existing key on another person is linked (merged) instead.
    const other = attachExternalIdentity(ctx, { kind: 'partiful_user', key: 'p-9' })!;
    attachExternalIdentity(ctx, { kind: 'partiful_user', key: 'p-9', personId: p });
    expect(canonicalId(db, personOfIdentity(db, other)!)).toBe(canonicalId(db, p));
  });
});

describe('linkIdentityToPerson', () => {
  it('is a journaled merge; undo restores separation and writes do_not_merge', () => {
    const db = memDb();
    const robin = seedPerson(db, { display_name: 'Robin Example' });
    seedIdentity(db, robin, 'phone', '+12125550101');
    const ctx = ctxFor(db, 'beeper');
    const ig = attachExternalIdentity(ctx, { kind: 'instagram_id', key: '3333', displayName: 'Robin Example', signals: { theirs: 2 } })!;
    const prov = personOfIdentity(db, ig)!;
    const r = linkIdentityToPerson(ctx, ig, robin, { evidence: { shared_key: 'partiful_socials' } });
    expect(r).toMatchObject({ outcome: 'linked', via: 'merge', survivorId: robin, mergedId: prov });
    expect(canonicalId(db, prov)).toBe(robin);
    expect(person(db, prov)).toMatchObject({ status: 'merged', merged_into_id: robin });
    expect(db.prepare('SELECT method FROM merges').pluck().get()).toBe('deterministic');
    expect(linkIdentityToPerson(ctx, ig, robin)).toEqual({ outcome: 'unchanged' });

    if (r.outcome !== 'linked') throw new Error('unreachable');
    undoBatch(db, r.batchId, { now: T0 + MIN });
    expect(canonicalId(db, prov)).toBe(prov);
    expect(person(db, prov)).toMatchObject({ status: 'provisional', merged_into_id: null });
    const [a, b] = [robin, prov].sort();
    expect(db.prepare('SELECT a_id, b_id, source FROM do_not_merge').all()).toEqual([{ a_id: a, b_id: b, source: 'undo' }]);
    // Re-ingest can't redo it.
    expect(linkIdentityToPerson(ctxFor(db, 'beeper', T0 + 2 * MIN), ig, robin)).toEqual({ outcome: 'held', reason: 'do_not_merge' });
  });

  it('holds on shared identities, identity blocks, distinct Contacts cards and co-presence (unless the user decides)', () => {
    const db = memDb();
    const ctx = ctxFor(db, 'whatsapp');
    const target = seedPerson(db, { display_name: 'Robin Example' });
    const household = seedPerson(db, { display_name: 'Household', status: 'provisional' });
    const shared = seedIdentity(db, household, 'phone', '+12125550102', { shared: 1 });
    expect(linkIdentityToPerson(ctx, shared, target)).toEqual({ outcome: 'held', reason: 'shared' });

    const blockedPerson = seedPerson(db, { display_name: 'Someone', status: 'provisional' });
    const blocked = seedIdentity(db, blockedPerson, 'whatsapp_lid', jid('201234567890123', 'lid'));
    db.prepare(`INSERT INTO identity_blocks (kind, key, person_id, created_at) VALUES ('whatsapp_lid', ?, ?, ?)`).run(jid('201234567890123', 'lid'), target, T0);
    expect(linkIdentityToPerson(ctx, blocked, target)).toEqual({ outcome: 'held', reason: 'blocked' });

    // G4: both sides are backed by different Contacts cards.
    const cardA = seedPerson(db, { display_name: 'Card A' });
    seedIdentity(db, cardA, 'addressbook_id', 'card-a');
    const cardB = seedPerson(db, { display_name: 'Card B' });
    seedIdentity(db, cardB, 'addressbook_id', 'card-b');
    const bPhone = seedIdentity(db, cardB, 'phone', '+12125550103');
    expect(linkIdentityToPerson(ctx, bPhone, cardA)).toEqual({ outcome: 'held', reason: 'distinct_cards' });
    expect(linkIdentityToPerson(ctx, bPhone, cardA, { method: 'user' })).toMatchObject({ outcome: 'linked' });

    // G2: two different IG ids, one per side, both active in one group.
    const x = seedPerson(db, { display_name: 'Pat One', status: 'provisional' });
    const xIg = seedIdentity(db, x, 'instagram_id', '4444');
    const y = seedPerson(db, { display_name: 'Pat Two' });
    const yIg = seedIdentity(db, y, 'instagram_id', '5555');
    const w = episodeWriter(db, { now: T0 });
    const g = w.upsertConversation({ source: 'beeper', sourceConvId: 'grp', kind: 'group' }).id;
    w.upsertMember(g, xIg, { source: 'roster', at: T0 });
    w.upsertMember(g, yIg, { source: 'roster', at: T0 });
    expect(linkIdentityToPerson(ctx, xIg, y)).toEqual({ outcome: 'held', reason: 'co_presence' });
    expect(count(db, 'merges')).toBe(1);
  });

  it("event co-presence is the matcher's G2: the agent's inferred or withdrawn occasion rows never hold a link", () => {
    const db = memDb();
    const ctx = ctxFor(db, 'partiful');
    // The owner's iMessage person was inferred onto the occasion ("Dinner w/ Robin"); the same human's Partiful guest
    // (still a separate provisional person) came onto it from the linked guest list, and an older inference was withdrawn.
    const robin = seedPerson(db, { display_name: 'Robin Example' });
    const guest = seedPerson(db, { display_name: 'Robin Example', status: 'provisional' });
    const guestId = seedIdentity(db, guest, 'partiful_user', 'p-robin');
    const ev = partifulEvent(db);
    const occ = occasion(db, ev);
    attend(db, { occasion: occ }, robin, 'attended', 'calendar_text');
    attend(db, { occasion: occ }, guest, 'attended', 'partiful');
    attend(db, { event: ev }, guest, 'going', 'partiful');
    const other = occasion(db);
    attend(db, { occasion: other }, robin, 'attended', 'inferred');
    attend(db, { occasion: other }, guest, 'withdrawn', 'inferred');
    expect(coPresentSets(db, [guest], [robin])).toBe(false);
    expect(linkIdentityToPerson(ctx, guestId, robin)).toMatchObject({ outcome: 'linked', survivorId: robin });
    expect(linkAlert(db)).toBeUndefined();

    // Two people on one explicit guest list are two people.
    const sam = seedPerson(db, { display_name: 'Sam Sample' });
    const samGuest = seedPerson(db, { display_name: 'Sam Sample', status: 'provisional' });
    const samId = seedIdentity(db, samGuest, 'partiful_user', 'p-sam');
    attend(db, { event: ev }, sam, 'going', 'user');
    attend(db, { event: ev }, samGuest, 'going', 'partiful');
    expect(linkIdentityToPerson(ctx, samId, sam)).toEqual({ outcome: 'held', reason: 'co_presence' });

    // A row the agent withdrew is on no list any more, even one copied from a guest list.
    const kim = seedPerson(db, { display_name: 'Kim Sample' });
    const kimGuest = seedPerson(db, { display_name: 'Kim Sample', status: 'provisional' });
    const listed = occasion(db);
    attend(db, { occasion: listed }, kim, 'attended', 'partiful');
    attend(db, { occasion: listed }, kimGuest, 'withdrawn', 'partiful');
    expect(coPresentSets(db, [kimGuest], [kim])).toBe(false);
    db.prepare(`UPDATE event_attendees SET status = 'attended' WHERE person_id = ?`).run(kimGuest);
    expect(coPresentSets(db, [kimGuest], [kim])).toBe(true);
  });

  it('a guard hold is kept as a held match candidate and raises one deduped alert (counts only) until resolved', () => {
    const db = memDb();
    const ctx = ctxFor(db, 'whatsapp');
    const cardA = seedPerson(db, { display_name: 'Card A' });
    seedIdentity(db, cardA, 'addressbook_id', 'card-a');
    const cardB = seedPerson(db, { display_name: 'Card B' });
    seedIdentity(db, cardB, 'addressbook_id', 'card-b');
    const bPhone = seedIdentity(db, cardB, 'phone', '+12125550103');
    expect(linkIdentityToPerson(ctx, bPhone, cardA)).toEqual({ outcome: 'held', reason: 'distinct_cards' });
    expect(linkIdentityToPerson(ctx, bPhone, cardA)).toEqual({ outcome: 'held', reason: 'distinct_cards' }); // the next pass
    const row = db.prepare('SELECT a_id, b_id, status, guards_failed, features FROM match_candidates').all() as { a_id: string; status: string; guards_failed: string; features: string }[];
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ a_id: [cardA, cardB].sort()[0], status: 'held', guards_failed: '["G4"]' });
    expect(JSON.parse(row[0]!.features)).toEqual({ link: { kind: 'phone', reason: 'distinct_cards', source: 'whatsapp' } });
    expect(linkAlert(db)).toMatch(/^1 link from your sources held/);
    expect(linkAlert(db)).not.toMatch(/555|Card/);
    expect(db.prepare('SELECT count(*) FROM alerts').pluck().get()).toBe(1);

    // The nightly matcher leaves it open (and the alert up) while the two are apart...
    runMatcher(db, { now: T0 + MIN });
    expect(db.prepare('SELECT status FROM match_candidates').pluck().get()).toBe('held');
    expect(linkAlert(db)).toBeDefined();
    // ...and closes both once the owner merged them.
    expect(linkIdentityToPerson(ctx, bPhone, cardA, { method: 'user' })).toMatchObject({ outcome: 'linked' });
    runMatcher(db, { now: T0 + 2 * MIN });
    expect(db.prepare('SELECT status FROM match_candidates').pluck().get()).toBe('merged');
    expect(linkAlert(db)).toBeUndefined();
  });

  it('G7: a priority person is never absorbed; it absorbs the target', () => {
    const db = memDb();
    const vip = seedPerson(db, { display_name: 'Priority Person', is_priority: 1, status: 'provisional' });
    const vipIg = seedIdentity(db, vip, 'instagram_id', '6666');
    const target = seedPerson(db, { display_name: 'Plain Person' });
    const r = linkIdentityToPerson(ctxFor(db, 'beeper'), vipIg, target);
    expect(r).toMatchObject({ outcome: 'linked', survivorId: vip, mergedId: target });
  });

  it('my own account on another source moves to me; undo moves it back and blocks it', () => {
    const db = memDb();
    const me = seedPerson(db, { kind: 'me', display_name: 'Me' });
    const ctx = ctxFor(db, 'beeper');
    const myIg = attachExternalIdentity(ctx, { kind: 'instagram_id', key: '7777' })!;
    const myUser = attachExternalIdentity(ctx, { kind: 'instagram_username', key: 'my.handle', personId: personOfIdentity(db, myIg)! })!;
    const prov = personOfIdentity(db, myIg)!;
    const r = linkIdentityToPerson(ctx, myIg, me);
    expect(r).toMatchObject({ outcome: 'linked', via: 'attach', survivorId: me });
    expect([personOfIdentity(db, myIg), personOfIdentity(db, myUser)]).toEqual([me, me]);
    expect(person(db, prov).status).toBe('suppressed');
    if (r.outcome !== 'linked') throw new Error('unreachable');
    undoBatch(db, r.batchId, { now: T0 + MIN });
    expect(personOfIdentity(db, myIg)).toBe(prov);
    expect(person(db, prov).status).toBe('roster_only');
    expect(count(db, 'identity_blocks', 'person_id = ?'.replace('?', `'${me}'`))).toBe(2);
    // A real person is never merged into me.
    const friend = seedPerson(db, { display_name: 'Friend' });
    const friendIg = seedIdentity(db, friend, 'instagram_id', '8888');
    expect(linkIdentityToPerson(ctx, friendIg, me)).toEqual({ outcome: 'held', reason: 'me_mismatch' });
  });
});
