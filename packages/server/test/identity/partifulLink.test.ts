/**
 * Partiful guest records ↔ contacts ("two records for one person"): a Partiful-only guest from one of the owner's
 * events and the one contact with the same full name become one person, journaled and undoable; ambiguous names,
 * strangers, two names on one guest list, dismissed pairs and the nightly cap keep them apart. Invented people only.
 */
import { describe, expect, it } from 'vitest';
import { sourceRun } from '../../src/adapters/common/context';
import { canonicalId } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { runMatcher } from '../../src/identity/matcher';
import { fullNameKey, linkPartifulGuests, PARTIFUL_LINK_RULE } from '../../src/identity/partifulLink';
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
  /** A real contact: active, with a Contacts card. */
  const contact = (first: string, last: string, o: { card?: boolean; status?: string } = {}) => {
    const id = seedPerson(db, { display_name: `${first} ${last}`, first_name: first, last_name: last, status: o.status ?? 'active', origin: 'addressbook' });
    if (o.card ?? true) seedIdentity(db, id, 'addressbook_id', `card-${++seq}`, { source: 'addressbook', match_method: 'addressbook' });
    return id;
  };
  const link = (budget = 25) => {
    const run = sourceRun(db, 'identity-match', { now: T0, kind: 'nightly' });
    const s = linkPartifulGuests(run.ctx, { budget });
    run.finish('ok');
    return s;
  };
  return { db, event, attend, guest, contact, link };
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
    expect(runMatcher(w.db, { now: T0 }).partiful_linked).toBe(1);
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
