/**
 * GET /tickets over a synthetic ledger (invented titles, venues and names; 555-01xx phones only): upcoming soonest
 * first and past most recent first, keyset paging, every status listed but never a merged-away row, the live
 * get-together each ticket feeds, and the "Met here" chips (visible canonical people only, last name A–Z).
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { TicketList, uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { createApp } from '../../src/http/app';
import { eventDetail } from '../../src/routes/events';
import { listTickets, MET_HERE_MAX, metHerePeople, ticketOccasion } from '../../src/routes/tickets';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';
import { DAY } from './world';

const HOUR = 3_600_000;
const devApp = (db: DB) => createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });

interface TicketSeed {
  title?: string;
  startsAt: number;
  endsAt?: number | null;
  status?: string;
  held?: number | null;
  mergedInto?: string | null;
  partifulIds?: string[];
  performers?: string[];
  venue?: string | null;
}

function ticket(db: DB, id: string, o: TicketSeed): string {
  db.prepare(
    `INSERT INTO ticket_events (id, title, title_key, performers, genres, category, venue, venue_key, city, starts_at, ends_at, tz, local_date,
       vendors, vendor_event_ids, partiful_ids, qty_bought, qty_received, qty_sent, qty_sold, qty_refunded, held, status, emails,
       first_email_at, last_email_at, merged_into_id, created_at, updated_at)
     VALUES (@id, @title, lower(@title), @performers, '["house"]', 'club', @venue, 'venue-key', 'Springfield', @starts, @ends, NULL, '2026-10-20',
       '["dice"]', '[]', @partiful, 4, 0, 2, 0, 0, @held, @status, 3, @starts, @starts, @merged, @starts, @starts)`,
  ).run({
    id,
    title: o.title ?? `Show ${id}`,
    performers: JSON.stringify(o.performers ?? ['DJ Sample']),
    venue: o.venue === undefined ? 'The Hall' : o.venue,
    starts: o.startsAt,
    ends: o.endsAt === undefined ? o.startsAt + 4 * HOUR : o.endsAt,
    partiful: JSON.stringify(o.partifulIds ?? []),
    held: o.held === undefined ? 2 : o.held,
    status: o.status ?? 'holding',
    merged: o.mergedInto ?? null,
  });
  return id;
}

function occasion(db: DB, o: { startsAt: number; status?: string; sensitive?: number; mergedInto?: string; eventId?: string | null } = { startsAt: T0 }): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO occasions (id, kind, title, starts_at, status, sensitive, merged_into_id, event_id, created_at, updated_at)
     VALUES (?, 'social', 'Night out', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, o.startsAt, o.status ?? 'active', o.sensitive ?? 0, o.mergedInto ?? null, o.eventId ?? null, T0, T0);
  return id;
}

const ticketSource = (db: DB, occasionId: string, ticketId: string) =>
  db.prepare(`INSERT INTO occasion_sources (occasion_id, source, source_ref, role, created_at) VALUES (?, 'ticket', ?, 'primary', ?)`).run(occasionId, ticketId, T0);

function metAt(db: DB, personId: string, target: { occasion?: string; event?: string }, status = 'active'): string {
  const id = uuidv7();
  const key = target.occasion ? `o:${target.occasion}` : `e:${target.event}`;
  db.prepare(
    `INSERT INTO person_met_at (id, person_id, occasion_id, event_id, target_key, signal, signal_at, confidence, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'instagram_follow', ?, 0.8, ?, 'inferred', ?, ?)`,
  ).run(id, personId, target.occasion ?? null, target.event ?? null, key, T0, status, T0, T0);
  return id;
}

const person = (db: DB, first: string, last: string, extra: Record<string, unknown> = {}) =>
  seedPerson(db, { first_name: first, last_name: last, display_name: `${first} ${last}`, ...extra });

describe('GET /api/v1/tickets', () => {
  it('upcoming soonest first (an event still on counts), past most recent first; merged rows never listed', async () => {
    const db = memDb();
    const now = Date.now();
    ticket(db, 'tk-later', { startsAt: now + 10 * DAY });
    ticket(db, 'tk-soon', { startsAt: now + 2 * DAY, status: 'unconfirmed', held: null });
    ticket(db, 'tk-now', { startsAt: now - HOUR, endsAt: now + 2 * HOUR, status: 'gave_away', held: 0 });
    ticket(db, 'tk-dup', { startsAt: now + 3 * DAY, mergedInto: 'tk-later' });
    ticket(db, 'tk-old', { startsAt: now - 40 * DAY, status: 'sold', held: 0 });
    ticket(db, 'tk-recent', { startsAt: now - 3 * DAY, endsAt: null });

    const up = await request(devApp(db)).get('/api/v1/tickets');
    expect(up.status).toBe(200);
    expect(up.headers['cache-control']).toBe('no-store');
    const upList = TicketList.parse(up.body);
    expect(upList.items.map((t) => t.id)).toEqual(['tk-now', 'tk-soon', 'tk-later']);
    expect(upList.items.map((t) => t.status)).toEqual(['gave_away', 'unconfirmed', 'holding']);
    expect(upList.items[1]!.held).toBeNull();
    expect(upList.nextCursor).toBeNull();

    const past = TicketList.parse((await request(devApp(db)).get('/api/v1/tickets?when=past')).body);
    expect(past.items.map((t) => t.id)).toEqual(['tk-recent', 'tk-old']);

    expect((await request(devApp(db)).get('/api/v1/tickets?when=soon')).status).toBe(400);
    expect((await request(devApp(db)).get('/api/v1/tickets?limit=0')).status).toBe(400);
  });

  it('pages on (starts_at, id) without repeats or gaps; a forged cursor is a 400', async () => {
    const db = memDb();
    const now = Date.now();
    // Two at the same start: the id breaks the tie.
    for (const [id, d] of [
      ['tk-a', 1],
      ['tk-b', 2],
      ['tk-c', 2],
      ['tk-d', 3],
      ['tk-e', 4],
    ] as const)
      ticket(db, id, { startsAt: now + d * DAY });
    const app = devApp(db);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get(`/api/v1/tickets?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const page = TicketList.parse(res.body);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['tk-a', 'tk-b', 'tk-c', 'tk-d', 'tk-e']);

    const pastIds: string[] = [];
    for (const [id, d] of [
      ['tp-a', 1],
      ['tp-b', 2],
      ['tp-c', 3],
    ] as const)
      ticket(db, id, { startsAt: now - d * DAY - 10 * HOUR });
    const p1 = listTickets(db, { when: 'past', limit: 2 }, now);
    const p2 = listTickets(db, { when: 'past', limit: 2, cursor: p1.nextCursor! }, now);
    pastIds.push(...p1.items.map((t) => t.id), ...p2.items.map((t) => t.id));
    expect(pastIds).toEqual(['tp-a', 'tp-b', 'tp-c']);
    expect(p2.nextCursor).toBeNull();

    const bad = await request(app).get(`/api/v1/tickets?cursor=${encodeURIComponent("1:x' OR 1=1")}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
  });

  it('items carry the parsed event, the quantity flows and the live get-together (through ticket and occasion merges)', () => {
    const db = memDb();
    const now = Date.now();
    ticket(db, 'tk-main', { startsAt: now + DAY, title: 'Neon Nights call 212-555-0142', performers: ['DJ Sample', 'MC Example'] });
    ticket(db, 'tk-merged', { startsAt: now + DAY, mergedInto: 'tk-main' });
    const survivor = occasion(db, { startsAt: now + DAY });
    const old = occasion(db, { startsAt: now + DAY, mergedInto: survivor });
    // The occasions build named the merged-away ticket row and the merged-away occasion: both resolve.
    ticketSource(db, old, 'tk-merged');
    expect(ticketOccasion(db, 'tk-main')).toEqual({ id: survivor, eventId: null });

    const [item] = listTickets(db, { when: 'upcoming', limit: 10 }, now).items;
    expect(item).toMatchObject({
      id: 'tk-main',
      performers: ['DJ Sample', 'MC Example'],
      category: 'club',
      genres: ['house'],
      venue: 'The Hall',
      city: 'Springfield',
      localDate: '2026-10-20',
      status: 'holding',
      held: 2,
      quantities: { bought: 4, received: 0, sent: 2, sold: 0, refunded: 0 },
      vendors: ['dice'],
      occasionId: survivor,
      metHere: [],
      metHereCount: 0,
    });
    // Phones in a parsed title are masked like every other title.
    expect(item!.title).not.toContain('555-0142');

    // A retired (cancelled) or sensitive get-together is never linked.
    db.prepare(`UPDATE occasions SET status = 'cancelled' WHERE id = ?`).run(survivor);
    expect(listTickets(db, { when: 'upcoming', limit: 10 }, now).items[0]!.occasionId).toBeNull();
    db.prepare(`UPDATE occasions SET status = 'active', sensitive = 1 WHERE id = ?`).run(survivor);
    expect(ticketOccasion(db, 'tk-main')).toBeNull();
  });

  it('a ticket feeding a sensitive get-together is never served; paging still moves past it', () => {
    const db = memDb();
    const now = Date.now();
    ticket(db, 'tk-1', { startsAt: now + DAY });
    ticket(db, 'tk-clinic', { startsAt: now + 2 * DAY, title: 'Clinic intake session' });
    ticket(db, 'tk-3', { startsAt: now + 3 * DAY });
    const occ = occasion(db, { startsAt: now + 2 * DAY, sensitive: 1, status: 'cancelled' });
    ticketSource(db, occ, 'tk-clinic');

    const all = listTickets(db, { when: 'upcoming', limit: 10 }, now);
    expect(all.items.map((t) => t.id)).toEqual(['tk-1', 'tk-3']);
    expect(JSON.stringify(all)).not.toContain('Clinic');

    const p1 = listTickets(db, { when: 'upcoming', limit: 1 }, now);
    const p2 = listTickets(db, { when: 'upcoming', limit: 1, cursor: p1.nextCursor! }, now);
    const p3 = listTickets(db, { when: 'upcoming', limit: 1, cursor: p2.nextCursor! }, now);
    expect([p1, p2, p3].map((p) => p.items.map((t) => t.id))).toEqual([['tk-1'], [], ['tk-3']]);
    expect(p2.nextCursor).not.toBeNull();
    expect(p3.nextCursor).toBeNull();
  });

  it('"Met here": active links on the occasion chain or a linked Partiful event; visible canonical people, last name A–Z', async () => {
    const db = memDb();
    const now = Date.now();
    ticket(db, 'tk-1', { startsAt: now - 2 * DAY, partifulIds: ['pf-evt-1'] });
    const occ = occasion(db, { startsAt: now - 2 * DAY });
    const oldOcc = occasion(db, { startsAt: now - 2 * DAY, mergedInto: occ });
    ticketSource(db, occ, 'tk-1');
    const pfEvent = uuidv7();
    db.prepare(`INSERT INTO events (id, source, source_event_id, title, starts_at, created_at, updated_at) VALUES (?, 'partiful', 'pf-evt-1', 'Afterparty', ?, ?, ?)`).run(
      pfEvent,
      now - 2 * DAY,
      T0,
      T0,
    );

    const zed = person(db, 'Ana', 'Zed');
    const abel = person(db, 'Bo', 'Abel');
    const mono = seedPerson(db, { first_name: null, last_name: null, display_name: 'Moonlight' });
    const hidden = person(db, 'Hal', 'Hidden', { is_hidden: 1 });
    const withdrawn = person(db, 'Wes', 'Withdrawn');
    const roster = person(db, 'Rae', 'Roster', { status: 'roster_only' });
    const canon = person(db, 'Cy', 'Canon');
    const dup = person(db, 'Cy', 'Canon-Dup');
    db.prepare(`UPDATE people SET status = 'merged', merged_into_id = ? WHERE id = ?`).run(canon, dup);
    // A visible record that holds one of the owner's own handles is the owner, never a chip.
    seedPerson(db, { kind: 'me', display_name: 'Me', first_name: null, last_name: null, origin: 'system' });
    db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('self_handles', ?, 0, 0)`).run(JSON.stringify(['owner@example.com']));
    const stray = person(db, 'Owen', 'Selfsame');
    seedIdentity(db, stray, 'email', 'owner@example.com');
    rebuildPersonCanon(db);

    metAt(db, zed, { occasion: occ });
    metAt(db, abel, { occasion: oldOcc }); // on a merged-away occasion of the chain
    metAt(db, mono, { event: pfEvent }); // through the ticket mail's Partiful link
    metAt(db, hidden, { occasion: occ });
    metAt(db, withdrawn, { occasion: occ }, 'withdrawn');
    metAt(db, roster, { occasion: occ });
    metAt(db, dup, { occasion: occ }); // merged into Cy Canon
    metAt(db, canon, { occasion: occ }); // the same person twice: one chip
    metAt(db, stray, { occasion: occ });

    const res = await request(devApp(db)).get('/api/v1/tickets?when=past');
    const [item] = TicketList.parse(res.body).items;
    expect(item!.metHere.map((p) => p.displayName)).toEqual(['Bo Abel', 'Cy Canon', 'Ana Zed', 'Moonlight']);
    expect(item!.metHere.find((p) => p.displayName === 'Cy Canon')!.id).toBe(canon);
    expect(item!.metHereCount).toBe(4);
    expect(res.text).not.toContain('Hidden');
    expect(res.text).not.toContain('Withdrawn');
    expect(res.text).not.toContain('Roster');
    expect(res.text).not.toContain('Canon-Dup');
    expect(res.text).not.toContain('Selfsame');
  });

  it('blanks a hidden person’s name in titles and performers, exactly as the get-together’s page does', () => {
    const db = memDb();
    const now = Date.now();
    person(db, 'Zelda', 'Quux', { is_hidden: 1 });
    person(db, 'Ivo', 'Plume');
    ticket(db, 'tk-bday', { startsAt: now + DAY, title: 'Zelda’s 30th Birthday', performers: ['Zelda Quux', 'Ivo Plume', 'DJ Sample'] });
    const occ = occasion(db, { startsAt: now + DAY });
    ticketSource(db, occ, 'tk-bday');

    const list = listTickets(db, { when: 'upcoming', limit: 10 }, now);
    const [item] = list.items;
    expect(item!.title).toBe('…’s 30th Birthday');
    // A visible person's name (and a stage name) stays.
    expect(item!.performers).toEqual(['… …', 'Ivo Plume', 'DJ Sample']);
    expect(JSON.stringify(list)).not.toMatch(/Zelda|Quux/);
    // The same vendor title on /e/:id (its ticket source) reads the same.
    expect(eventDetail(db, occ).sources.find((s) => s.source === 'ticket')!.title).toBe(item!.title);
  });

  it(`shows at most ${MET_HERE_MAX} chips but counts everyone`, () => {
    const db = memDb();
    const occ = occasion(db, { startsAt: T0 });
    const ids = Array.from({ length: MET_HERE_MAX + 3 }, (_, i) => person(db, 'P', `Last${String(i).padStart(2, '0')}`));
    for (const id of ids) metAt(db, id, { occasion: occ });
    ticket(db, 'tk-many', { startsAt: T0 });
    ticketSource(db, occ, 'tk-many');
    const [item] = listTickets(db, { when: 'past', limit: 5 }, T0 + DAY).items;
    expect(item!.metHere).toHaveLength(MET_HERE_MAX);
    expect(item!.metHereCount).toBe(MET_HERE_MAX + 3);
    expect(item!.metHere[0]!.displayName).toBe('P Last00');
    expect(metHerePeople(db, [])).toEqual([]);
  });

  it('an empty ledger answers an empty list', async () => {
    const res = await request(devApp(memDb())).get('/api/v1/tickets?when=past');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });
});
