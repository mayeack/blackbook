/**
 * Single-platform records ↔ contacts ("two records for one person"): a Partiful-only guest from one of the owner's
 * events, or an Instagram-only person he DMs, and the one contact with the same full name become one person,
 * journaled and undoable; ambiguous names, strangers, a thread he never wrote in, a record with a phone, a contact
 * with another account, two names on one guest list, dismissed pairs and the nightly cap keep them apart. Invented
 * people only.
 */
import { describe, expect, it } from 'vitest';
import { sourceRun } from '../../src/adapters/common/context';
import { canonicalId } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { runMatcher } from '../../src/identity/matcher';
import { fullNameKey, INSTAGRAM_LINK_RULE, linkUniqueNames, PARTIFUL_LINK_RULE } from '../../src/identity/uniqueNameLink';
import { undoBatch } from '../../src/journal/undo';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';

let seq = 0;

function world() {
  const db = memDb();
  const event = (o: { role?: string | null; rsvp?: string | null } = {}) => {
    const id = `ev-${++seq}`;
    db.prepare(
      `INSERT INTO events (id, source, source_event_id, kind, title, starts_at, my_role, my_rsvp, created_at, updated_at)
       VALUES (?, 'partiful', ?, 'social', 'Rooftop party', ?, ?, ?, ?, ?)`,
    ).run(id, `pf-${id}`, T0 - 86_400_000, o.role ?? null, o.rsvp ?? 'going', T0, T0);
    return id;
  };
  const attend = (eventId: string, personId: string, status = 'going') =>
    db.prepare(
      `INSERT INTO event_attendees (id, event_id, person_id, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'partiful', ?, ?)`,
    ).run(`att-${++seq}`, eventId, personId, status, T0, T0);
  /** A guest record only Partiful knows (roster-only, one partiful_user identity), on `eventId`'s list. */
  const guest = (name: string, eventId: string, extra: Record<string, unknown> = {}) => {
    const id = seedPerson(db, { display_name: name, first_name: null, last_name: null, status: 'roster_only', origin: 'partiful', ...extra });
    seedIdentity(db, id, 'partiful_user', `pfu-${++seq}`, { source: 'partiful', match_method: 'deterministic' });
    attend(eventId, id);
    return id;
  };
  /** Someone only Instagram knows (provisional, IG id + username) and their DM thread; `mine` = messages I sent in it. */
  const igPerson = (name: string, o: { mine?: number } = {}) => {
    const id = seedPerson(db, { display_name: name, first_name: null, last_name: null, status: 'provisional', origin: 'instagram' });
    const ident = seedIdentity(db, id, 'instagram_id', `igid-${++seq}`, { source: 'instagram', match_method: 'deterministic' });
    seedIdentity(db, id, 'instagram_username', `handle${seq}`, { source: 'instagram', match_method: 'deterministic' });
    const conv = `ig-conv-${++seq}`;
    db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'instagram', ?, 'direct', ?, ?)`).run(
      conv,
      conv,
      T0,
      T0,
    );
    db.prepare(
      `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'sender', ?, ?)`,
    ).run(conv, ident, T0, T0);
    const msg = db.prepare(
      `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
       VALUES ('instagram', ?, ?, ?, ?, ?, 'text', 'hey', ?, ?)`,
    );
    msg.run(`m-${++seq}`, conv, ident, 0, T0, T0, T0);
    for (let i = 0; i < (o.mine ?? 1); i++) msg.run(`m-${++seq}`, conv, null, 1, T0, T0, T0);
    return id;
  };
  /** A real contact: active, with a Contacts card. */
  const contact = (first: string, last: string, o: { card?: boolean; status?: string } = {}) => {
    const id = seedPerson(db, { display_name: `${first} ${last}`, first_name: first, last_name: last, status: o.status ?? 'active', origin: 'addressbook' });
    if (o.card ?? true) seedIdentity(db, id, 'addressbook_id', `card-${++seq}`, { source: 'addressbook', match_method: 'addressbook' });
    return id;
  };
  const link = (budget = 25) => {
    const run = sourceRun(db, 'identity-match', { now: T0, kind: 'nightly' });
    const s = linkUniqueNames(run.ctx, { budget });
    run.finish('ok');
    return s;
  };
  return { db, event, attend, guest, igPerson, contact, link };
}

const same = (db: DB, a: string, b: string) => canonicalId(db, a) === canonicalId(db, b);

describe('Partiful guest ↔ contact linkage', () => {
  it('links a guest from my event to the one contact with the full name: journaled, contact survives, undo splits + do_not_merge', () => {
    const w = world();
    const party = w.event({ role: 'host', rsvp: null });
    const g = w.guest('Rowan Testperson', party);
    const c = w.contact('Rowan', 'Testperson');
    expect(w.link()).toMatchObject({ considered: 1, linked: 1 });
    expect(same(w.db, g, c)).toBe(true);
    expect(canonicalId(w.db, g)).toBe(c);
    const m = w.db.prepare(`SELECT method, evidence, batch_id FROM merges WHERE survivor_id = ? AND merged_id = ?`).get(c, g) as {
      method: string;
      evidence: string;
      batch_id: string;
    };
    expect(m.method).toBe('probabilistic');
    expect(JSON.parse(m.evidence)).toMatchObject({ rule: PARTIFUL_LINK_RULE, counts: { partiful_events: 1 } });

    undoBatch(w.db, m.batch_id, { actor: 'user', now: T0 + 1000 });
    expect(same(w.db, g, c)).toBe(false);
    expect(w.link()).toMatchObject({ linked: 0, blocked: 1 }); // G3 do_not_merge from the undo
  });

  it('the matcher runs it nightly and reports it', () => {
    const w = world();
    const g = w.guest('Avery Example', w.event());
    const c = w.contact('Avery', 'Example');
    expect(runMatcher(w.db, { now: T0 }).name_linked).toBe(1);
    expect(same(w.db, g, c)).toBe(true);
  });

  it('ambiguous names stay apart: two contacts, a second Partiful record, or another person with the name', () => {
    const w = world();
    const ev = w.event();
    const g1 = w.guest('Sam Rivera', ev);
    w.contact('Sam', 'Rivera');
    w.contact('Sam', 'Rivera');
    const g2 = w.guest('Jordan Lee', ev);
    const g3 = w.guest('Jordan Lee', w.event());
    w.contact('Jordan', 'Lee');
    const g4 = w.guest('Blake Example', ev);
    w.contact('Blake', 'Example');
    seedPerson(w.db, { display_name: 'Blake Example', first_name: 'Blake', last_name: 'Example', status: 'roster_only', origin: 'imessage' });
    const s = w.link();
    expect(s).toMatchObject({ linked: 0, ambiguous: 4 });
    for (const g of [g1, g2, g3, g4]) expect(canonicalId(w.db, g)).toBe(g);
  });

  it('needs both sides in my life: a contact with no card or 1:1 history, an event I declined, a first name alone', () => {
    const w = world();
    const g1 = w.guest('Casey Example', w.event());
    w.contact('Casey', 'Example', { card: false }); // nothing ties them to me
    const g2 = w.guest('Drew Example', w.event({ rsvp: 'declined' }));
    w.contact('Drew', 'Example');
    const g3 = w.guest('Emery', w.event());
    w.contact('Emery', 'Example');
    expect(w.link()).toMatchObject({ linked: 0, not_acquainted: 1 });
    for (const g of [g1, g2, g3]) expect(canonicalId(w.db, g)).toBe(g);
  });

  it('two names on one guest list are two people (G2); a dismissed pair is never linked', () => {
    const w = world();
    const ev = w.event();
    const g = w.guest('Finley Example', ev);
    const c = w.contact('Finley', 'Example');
    w.attend(ev, c);
    const ev2 = w.event();
    const g2 = w.guest('Harper Example', ev2);
    const c2 = w.contact('Harper', 'Example');
    const [a, b] = g2 < c2 ? [g2, c2] : [c2, g2];
    w.db.prepare(
      `INSERT INTO match_candidates (a_id, b_id, score_bits, p, families, guards_failed, status, features, scored_at, created_at, updated_at)
       VALUES (?, ?, 0, 0.5, '["name"]', '[]', 'dismissed', '{}', ?, ?, ?)`,
    ).run(a, b, T0, T0, T0);
    expect(w.link()).toMatchObject({ linked: 0, blocked: 2 });
    expect(same(w.db, g, c)).toBe(false);
    expect(same(w.db, g2, c2)).toBe(false);
  });

  it('respects the nightly merge cap (the rest wait for a later night)', () => {
    const w = world();
    const ev = w.event();
    for (const n of ['Ari', 'Bo', 'Cy']) {
      w.guest(`${n} Example`, ev);
      w.contact(n, 'Example');
    }
    expect(w.link(2)).toMatchObject({ linked: 2, held: 1 });
    expect(w.link(5)).toMatchObject({ linked: 1 });
  });

  it('full names: two words or more, no initials, accents folded', () => {
    expect(fullNameKey({ display_name: 'José  Núñez', first_name: null, last_name: null })).toBe('jose nunez');
    expect(fullNameKey({ display_name: 'x', first_name: 'Mary Ann', last_name: 'van Example' })).toBe('mary example');
    expect(fullNameKey({ display_name: 'Sam R.', first_name: null, last_name: null })).toBeNull();
    expect(fullNameKey({ display_name: 'Sam', first_name: null, last_name: null })).toBeNull();
    expect(fullNameKey({ display_name: 'J Example', first_name: null, last_name: null })).toBeNull();
  });
});

describe('Instagram DM record ↔ contact linkage', () => {
  it('links someone I DM on Instagram to the one contact with the full name: journaled, contact survives, undo splits', () => {
    const w = world();
    const ig = w.igPerson('Quinn Testperson', { mine: 3 });
    const c = w.contact('Quinn', 'Testperson');
    expect(w.link()).toMatchObject({ considered: 1, linked: 1 });
    expect(canonicalId(w.db, ig)).toBe(c);
    const m = w.db
      .prepare(`SELECT m.evidence, m.batch_id, b.title FROM merges m JOIN change_batches b ON b.id = m.batch_id WHERE m.survivor_id = ? AND m.merged_id = ?`)
      .get(c, ig) as { evidence: string; batch_id: string; title: string };
    expect(JSON.parse(m.evidence)).toMatchObject({ rule: INSTAGRAM_LINK_RULE, families: ['name', 'instagram'], counts: { instagram_threads: 1 } });
    expect(m.title).toContain('in your Instagram DMs');

    undoBatch(w.db, m.batch_id, { actor: 'user', now: T0 + 1000 });
    expect(same(w.db, ig, c)).toBe(false);
    expect(w.link()).toMatchObject({ linked: 0, blocked: 1 });
  });

  it('the nightly matcher links them, though the name alone scores far below its band', () => {
    const w = world();
    const ig = w.igPerson('Sasha Example');
    const c = w.contact('Sasha', 'Example');
    const s = runMatcher(w.db, { now: T0 });
    expect(s).toMatchObject({ name_linked: 1, merged: 0 });
    expect(same(w.db, ig, c)).toBe(true);
  });

  it('a thread I never wrote in, a record with an email, or a contact on another Instagram account stays apart', () => {
    const w = world();
    const r1 = w.igPerson('Tatum Example', { mine: 0 }); // a message request I never answered
    w.contact('Tatum', 'Example');
    const r2 = w.igPerson('Uma Example');
    seedIdentity(w.db, r2, 'email', 'uma@example.com', { source: 'imessage' });
    w.contact('Uma', 'Example');
    const r3 = w.igPerson('Vale Example');
    const c3 = w.contact('Vale', 'Example');
    seedIdentity(w.db, c3, 'instagram_id', `igid-other-${++seq}`, { source: 'instagram', match_method: 'deterministic' });
    const r4 = w.igPerson('Wren Example');
    const c4 = w.contact('Wren', 'Example');
    seedIdentity(w.db, c4, 'instagram_username', 'oldhandle', { source: 'addressbook', match_method: 'addressbook' }); // a stale card handle
    expect(w.link()).toMatchObject({ considered: 2, linked: 1, other_account: 1 });
    for (const r of [r1, r2, r3]) expect(canonicalId(w.db, r)).toBe(r);
    expect(canonicalId(w.db, r4)).toBe(c4);
  });

  it('a Partiful guest that also carries an Instagram handle from its profile links like a Partiful-only one', () => {
    const w = world();
    const g = w.guest('Yael Example', w.event());
    seedIdentity(w.db, g, 'instagram_username', 'yaelexample', { source: 'partiful', match_method: 'deterministic' });
    const c = w.contact('Yael', 'Example');
    expect(w.link()).toMatchObject({ linked: 1 });
    const ev = w.db.prepare(`SELECT evidence FROM merges WHERE survivor_id = ? AND merged_id = ?`).pluck().get(c, g) as string;
    expect(JSON.parse(ev)).toMatchObject({ rule: PARTIFUL_LINK_RULE });
  });

  it('two such records with one name are ambiguous, not linked to each other or the contact', () => {
    const w = world();
    const ig = w.igPerson('Zion Example');
    const g = w.guest('Zion Example', w.event());
    w.contact('Zion', 'Example');
    expect(w.link()).toMatchObject({ linked: 0, ambiguous: 2 });
    expect(canonicalId(w.db, ig)).toBe(ig);
    expect(canonicalId(w.db, g)).toBe(g);
  });
});
