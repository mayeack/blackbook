import { uuidv7 } from '@yb/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { calendarTreatments } from '../../../src/pipeline/occasions/calendars';
import { clusterEvents, loadCalendarEvents, type CalEvent } from '../../../src/pipeline/occasions/build';
import { classifyOccasion } from '../../../src/pipeline/occasions/classify';
import { runOccasions } from '../../../src/pipeline/occasions/run';
import {
  attachTickets,
  hasLiveTicket,
  loadTicketEvents,
  occasionOfTicket,
  occasionTickets,
  ticketCopyCount,
  ticketMatch,
} from '../../../src/pipeline/occasions/tickets';
import { memDb, seedIdentity, seedPerson } from '../../helpers';
import { occasionOfTicketRef, ticketEvent, ticketParty, updateTicket } from './ticketFixtures';
import { attendeesOf, buildWorld, CAL, calEvent, DAY, evening, HOUR, NOW, occasionOf, TZ, type World } from './world';

let w: World;
const run = (now = NOW) => runOccasions(w.db, { now, timeZone: TZ });
type Occ = Record<string, unknown> & { id: string };
const occById = (id: string | undefined) => {
  expect(id).toBeTruthy();
  return w.db.prepare('SELECT * FROM occasions WHERE id = ?').get(id) as Occ;
};
const sourcesOf = (occasionId: string) =>
  w.db.prepare('SELECT source, source_ref, role FROM occasion_sources WHERE occasion_id = ? ORDER BY source, source_ref').all(occasionId) as {
    source: string;
    source_ref: string;
    role: string;
  }[];
const snapshot = () => ({
  runs: w.db.prepare('SELECT count(*) FROM runs').pluck().get(),
  batches: w.db.prepare('SELECT count(*) FROM change_batches').pluck().get(),
  occasions: JSON.stringify(w.db.prepare('SELECT * FROM occasions ORDER BY id').all()),
  sources: JSON.stringify(w.db.prepare('SELECT * FROM occasion_sources ORDER BY 1, 2, 3').all()),
  cands: JSON.stringify(w.db.prepare('SELECT * FROM occasion_candidates ORDER BY 1, 2').all()),
  attendees: JSON.stringify(w.db.prepare('SELECT * FROM event_attendees ORDER BY id').all()),
  edges: JSON.stringify(w.db.prepare('SELECT * FROM edge_evidence ORDER BY id').all()),
  inter: JSON.stringify(w.db.prepare('SELECT * FROM interactions ORDER BY id').all()),
});
/** A Gmail-made calendar copy (Google's eventType 'fromGmail'). */
const fromGmail = (summary: string, start: number, location: string | null = null) =>
  calEvent(w.db, { summary, location, start, eventType: 'fromGmail', creator: null });
/** A Partiful event as the Partiful adapter ingests it (events.id). */
const partifulEvent = (sourceId: string, title: string, start: number, location: string) => {
  const id = uuidv7();
  w.db
    .prepare(
      `INSERT INTO events (id, source, source_event_id, title, starts_at, ends_at, location_text, my_rsvp, created_at, updated_at)
       VALUES (?, 'partiful', ?, ?, ?, ?, ?, 'going', ?, ?)`,
    )
    .run(id, sourceId, title, start, start + 4 * HOUR, location, NOW, NOW);
  return id;
};
/** The occasions linked to a Partiful event (occasions.event_id) and the ones holding its 'partiful' source row. */
const linkedTo = (eventId: string) => ({
  linked: w.db.prepare('SELECT id FROM occasions WHERE event_id = ? ORDER BY id').pluck().all(eventId),
  held: w.db.prepare(`SELECT occasion_id FROM occasion_sources WHERE source = 'partiful' AND source_ref = ?`).pluck().all(eventId),
});
/** The owner declined the invite; Ines accepted it. */
const DECLINED = [
  { email: CAL.personal, self: true, responseStatus: 'declined' },
  { email: 'ines.farrow@example.com', responseStatus: 'accepted' },
];

beforeEach(() => {
  w = buildWorld();
});

describe('loading ticket copies', () => {
  it('only live rows the owner holds, over the same [from, to] window as calendar events; released rows load apart', () => {
    const inside = ticketEvent(w.db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: evening(-18, 21) });
    const old = ticketEvent(w.db, { title: 'Long Ago Band', venue: 'Marigold Ballroom', start: NOW - 500 * DAY });
    const far = ticketEvent(w.db, { title: 'Far Future Band', venue: 'Marigold Ballroom', start: NOW + 120 * DAY });
    const sold = ticketEvent(w.db, { title: 'Velvet Static', venue: 'Copperline Hall', start: evening(-30, 20), sold: 2, status: 'sold' });
    ticketEvent(w.db, { title: 'Maybe Show', venue: 'Copperline Hall', start: evening(-31, 20), bought: 0, status: 'unconfirmed' });
    const merged = ticketEvent(w.db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: evening(-18, 21), mergedInto: inside });
    const t = loadTicketEvents(w.db, NOW - 400 * DAY, NOW + 90 * DAY);
    expect(t.live.map((e) => e.id)).toEqual([inside]);
    expect(t.released.map((e) => e.id)).toEqual([sold]);
    expect(t.live[0]).toMatchObject({
      source: 'ticket',
      treatment: 'attending',
      social: true,
      reservation: false,
      fromGmail: false,
      notes: '',
      venueKey: 'marigold ballroom',
      ticket: { id: inside, aliases: [merged], status: 'holding', category: 'concert', tz: 'UTC', count: 2 },
    });
    expect([old, far].some((id) => t.live.some((e) => e.id === id))).toBe(false);
    const s = run();
    expect(s.ticketEvents).toBe(1);
    expect(occasionOfTicketRef(w.db, old)).toBeUndefined();
    expect(occasionOfTicketRef(w.db, far)).toBeUndefined();
  });

  it('ticket_count is bought + received − sold − refunded (sent is not subtracted); unknown stays null', () => {
    const q = { qty_bought: 4, qty_received: 1, qty_sold: 1, qty_refunded: 0 };
    expect(ticketCopyCount({ ...q, held: 2 })).toBe(4);
    expect(ticketCopyCount({ ...q, held: null })).toBeNull();
    expect(ticketCopyCount({ qty_bought: 0, qty_received: 0, qty_sold: 0, qty_refunded: 0, held: 0 })).toBeNull();
  });
});

describe('a ticket copy joins calendar copies', () => {
  it('merges with a Gmail-made copy at the same venue: the ticket is primary and classifies the occasion', () => {
    const cal = fromGmail('Lantern Choir', evening(-22, 20), 'Copperline Hall, 1 Example St, Springfield');
    const t = ticketEvent(w.db, { title: 'Lantern Choir: Autumn Tour', performers: ['Lantern Choir'], venue: 'Copperline Hall', city: 'Springfield', start: evening(-22, 20), bought: 3 });
    run();
    const id = occasionOf(w.db, cal)!;
    expect(occasionOfTicketRef(w.db, t)).toBe(id);
    expect(sourcesOf(id)).toEqual([
      { source: 'calendar', source_ref: cal, role: 'reservation' },
      { source: 'ticket', source_ref: t, role: 'primary' },
    ]);
    expect(occById(id)).toMatchObject({
      title: 'Lantern Choir: Autumn Tour',
      kind: 'social',
      is_social: 1,
      classification_rule: 'ticket',
      classification_confidence: 0.9,
      classified_by: 'rule',
      ticket_count: 3,
      status: 'active',
      corroborated: 1,
      venue_key: 'copperline hall',
    });
  });

  it("merges with the owner's own event, which stays primary and keeps the occasion id; calendar text's count wins", () => {
    run();
    const before = occasionOf(w.db, w.ev.concert!)!;
    const t = ticketEvent(w.db, { title: 'Fernhollow', performers: ['Fernhollow'], venue: 'Copperline Hall', start: evening(-8, 20), bought: 4, sent: 2 });
    run(NOW + 1);
    expect(occasionOf(w.db, w.ev.concert!)).toBe(before);
    expect(occasionOfTicketRef(w.db, t)).toBe(before);
    expect(sourcesOf(before)).toEqual([
      { source: 'calendar', source_ref: w.ev.concert, role: 'primary' },
      { source: 'ticket', source_ref: t, role: 'duplicate' },
    ]);
    // "2 tickets" in the notes beats the ledger's 4
    expect(occById(before)).toMatchObject({ title: 'Fernhollow concert', ticket_count: 2, classification_rule: 'ticket', status: 'active' });
    expect(occasionTickets(w.db, before)).toEqual([{ id: t, status: 'holding' }]);
    expect(hasLiveTicket(w.db, before)).toBe(true);
    expect(occasionOfTicket(w.db, t)).toBe(before);
    // Tavi still holds the ticket the notes name
    expect(attendeesOf(w.db, before).find((a) => a.person_id === w.tavi.id)).toMatchObject({ status: 'attended', role: 'ticket_holder' });
  });

  it('a guessed zone joins on title or performer on the local date, never by venue ±3 h', () => {
    // the hour is wrong (zone guessed), the title is the same show
    const t1 = ticketEvent(w.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 23), tz: null });
    run();
    expect(occasionOfTicketRef(w.db, t1)).toBe(occasionOf(w.db, w.ev.concert!));
    // another show at the same venue an hour later, guessed zone, unrelated title: stands alone
    const w2 = buildWorld();
    w = w2;
    const t2 = ticketEvent(w.db, { title: 'Ninefold Echo', venue: 'Copperline Hall', start: evening(-8, 21), tz: null });
    run();
    expect(occasionOfTicketRef(w.db, t2)).not.toBe(occasionOf(w.db, w.ev.concert!));
    expect(sourcesOf(occasionOfTicketRef(w.db, t2)!)).toEqual([{ source: 'ticket', source_ref: t2, role: 'primary' }]);
    // the same with a known zone joins by venue
    const t3 = ticketEvent(w.db, { title: 'Ninefold Echo', venue: 'Copperline Hall', start: evening(-8, 21, 30) });
    run(NOW + 1);
    expect(occasionOfTicketRef(w.db, t3)).toBe(occasionOf(w.db, w.ev.concert!));
  });

  it('a performer named in the calendar title joins on the same local day', () => {
    const own = calEvent(w.db, { summary: 'Seeing Glass Harbor w/ Romy', start: evening(-24, 19) });
    const t = ticketEvent(w.db, { title: 'An Evening Under the Pines', performers: ['Glass Harbor'], venue: 'Pinecrest Amphitheater', start: evening(-24, 20) });
    run();
    expect(occasionOfTicketRef(w.db, t)).toBe(occasionOf(w.db, own));
    // the vendor title never yields "people in the title"
    expect(attendeesOf(w.db, occasionOf(w.db, own)!).map((a) => a.person_id)).toEqual([w.romy.id]);
  });

  it('a ticket copy matching two calendar clusters attaches to only the best one; two tickets never join', () => {
    const atVenue = calEvent(w.db, { summary: 'Night out w/ Romy', location: 'Copperline Hall', start: evening(-25, 20) });
    const byTitle = calEvent(w.db, { summary: 'Glass Harbor', start: evening(-25, 18, 30) });
    const t = ticketEvent(w.db, { title: 'Glass Harbor', performers: ['Glass Harbor'], venue: 'Copperline Hall', start: evening(-25, 20) });
    // a second ledger row for the same night (not merged by the ledger) loses the cluster and stands alone
    const t2 = ticketEvent(w.db, { title: 'Glass Harbor', venue: 'Copperline Hall', start: evening(-25, 21) });
    run();
    const best = occasionOf(w.db, atVenue)!;
    expect(occasionOfTicketRef(w.db, t)).toBe(best);
    expect(occasionOf(w.db, byTitle)).not.toBe(best);
    expect(sourcesOf(occasionOf(w.db, byTitle)!)).toEqual([{ source: 'calendar', source_ref: byTitle, role: 'primary' }]);
    expect(w.db.prepare(`SELECT count(*) FROM occasion_sources WHERE source = 'ticket' AND source_ref = ?`).pluck().get(t)).toBe(1);
    const alone = occasionOfTicketRef(w.db, t2)!;
    expect([best, occasionOf(w.db, byTitle)]).not.toContain(alone);
    expect(sourcesOf(alone)).toEqual([{ source: 'ticket', source_ref: t2, role: 'primary' }]);
  });

  it('a Gmail-made table reservation, flight or other venue is not the show', () => {
    const table = fromGmail('Reservation at Sable Bistro', evening(-26, 18), 'Sable Bistro');
    const dinner = fromGmail('Dinner at Lupine Room', evening(-26, 18, 30));
    const flight = fromGmail('Flight to Example City (UA 123)', evening(-26, 22));
    const t = ticketEvent(w.db, { title: 'Ninefold Echo', venue: 'Copperline Hall', start: evening(-26, 20) });
    run();
    const own = occasionOfTicketRef(w.db, t)!;
    for (const c of [table, dinner, flight]) expect(occasionOf(w.db, c)).not.toBe(own);
    expect(sourcesOf(own)).toEqual([{ source: 'ticket', source_ref: t, role: 'primary' }]);
  });

  it('a shared Partiful id links the ticket-only occasion to the Partiful event', () => {
    const t = ticketEvent(w.db, { title: 'Picnic in the park', category: 'party', venue: 'Juniper Park', start: evening(5, 13), partifulIds: ['PtyEvt0002'] });
    run();
    const id = occasionOfTicketRef(w.db, t)!;
    expect(occById(id)).toMatchObject({ event_id: w.partifulOnly, kind: 'social' });
    expect(sourcesOf(id)).toEqual([
      { source: 'partiful', source_ref: w.partifulOnly, role: 'duplicate' },
      { source: 'ticket', source_ref: t, role: 'primary' },
    ]);
    // Romy is GOING on Partiful
    expect(attendeesOf(w.db, id).find((a) => a.person_id === w.romy.id)).toMatchObject({ status: 'going', source: 'partiful' });
  });

  it('a shared Partiful id joins the calendar copy whatever its kind or length: one occasion holds the Partiful event', () => {
    // a 2-day all-day copy (travel, multi_day_all_day) and a "trip" title (travel) both carry the Partiful link
    const camp = partifulEvent('PtyEvt0077', 'Camp weekend', evening(-30, 18), 'Pinecone Camp');
    const weekend = calEvent(w.db, { summary: 'Camp weekend', description: 'https://partiful.com/e/PtyEvt0077', start: Date.UTC(2026, 9, 14 - 30), end: Date.UTC(2026, 9, 14 - 28), allDay: true });
    const t1 = ticketEvent(w.db, { title: 'Camp weekend', category: 'party', venue: 'Pinecone Camp', start: evening(-30, 18), partifulIds: ['PtyEvt0077'] });
    const lake = partifulEvent('PtyEvt0078', 'Lake trip', evening(-34, 10), 'Larkspur Lake');
    const trip = calEvent(w.db, { summary: 'Lake trip', description: 'https://partiful.com/e/PtyEvt0078', start: evening(-34, 10) });
    const t2 = ticketEvent(w.db, { title: 'Larkspur Lake Day Pass', category: 'party', venue: 'Larkspur Lake', start: evening(-34, 11), partifulIds: ['PtyEvt0078'] });
    run();
    for (const [cal, t, ev] of [
      [weekend, t1, camp],
      [trip, t2, lake],
    ] as const) {
      const id = occasionOf(w.db, cal)!;
      expect(occasionOfTicketRef(w.db, t)).toBe(id);
      expect(occById(id)).toMatchObject({ event_id: ev, kind: 'social', classification_rule: 'ticket', status: 'active' });
      expect(linkedTo(ev)).toEqual({ linked: [id], held: [id] });
    }
    const before = snapshot();
    expect(run(NOW + HOUR)).toMatchObject({ occasionsCreated: 0, occasionsUpdated: 0, occasionsRetired: 0 });
    expect(snapshot()).toEqual(before);
  });

  it("a ticket that can't join the copy carrying its Partiful id doesn't claim the Partiful event too: one holder, no tug of war", () => {
    // the cluster already took a better ticket
    const roof = partifulEvent('PtyEvt0079', 'Rooftop social', evening(-27, 20), 'Juniper Terrace');
    const roofCal = calEvent(w.db, { summary: 'Rooftop social', location: 'Juniper Terrace', description: 'https://partiful.com/e/PtyEvt0079', start: evening(-27, 20) });
    const first = ticketEvent(w.db, { title: 'Rooftop social', category: 'party', venue: 'Juniper Terrace', start: evening(-27, 20), partifulIds: ['PtyEvt0079'] });
    const late = ticketEvent(w.db, { title: 'Rooftop social: late entry', category: 'party', venue: 'Juniper Terrace', start: evening(-27, 22), partifulIds: ['PtyEvt0079'] });
    // the calendar copy is more than 36 h from the ticket's date
    const gala = partifulEvent('PtyEvt0080', 'Lantern gala', evening(-33, 20), 'Marigold Ballroom');
    const galaCal = calEvent(w.db, { summary: 'Lantern gala', description: 'https://partiful.com/e/PtyEvt0080', start: evening(-33, 20) });
    const moved = ticketEvent(w.db, { title: 'Lantern Gala', category: 'party', venue: 'Marigold Ballroom', start: evening(-31, 20), partifulIds: ['PtyEvt0080'] });
    // two ledger rows for one Partiful event and no calendar copy: the earlier one links it
    const picnic = partifulEvent('PtyEvt0081', 'Orchard picnic', evening(-29, 13), 'Quince Orchard');
    const early = ticketEvent(w.db, { title: 'Orchard picnic', category: 'party', venue: 'Quince Orchard', start: evening(-29, 13), partifulIds: ['PtyEvt0081'] });
    const plusOne = ticketEvent(w.db, { title: 'Orchard picnic (plus one)', category: 'party', venue: 'Quince Orchard', start: evening(-29, 14), partifulIds: ['PtyEvt0081'] });
    run();
    const of = (t: string) => occasionOfTicketRef(w.db, t)!;
    expect(of(first)).toBe(occasionOf(w.db, roofCal));
    for (const [ev, holder, other] of [
      [roof, occasionOf(w.db, roofCal)!, of(late)],
      [gala, occasionOf(w.db, galaCal)!, of(moved)],
      [picnic, of(early), of(plusOne)],
    ] as const) {
      expect(other).not.toBe(holder);
      expect(linkedTo(ev)).toEqual({ linked: [holder], held: [holder] });
      expect(occById(other)).toMatchObject({ event_id: null, kind: 'social', status: 'active' });
      expect(sourcesOf(other).map((s) => s.source)).toEqual(['ticket']);
    }
    const before = snapshot();
    expect(run(NOW + HOUR)).toMatchObject({ occasionsCreated: 0, occasionsUpdated: 0, occasionsRetired: 0 });
    expect(snapshot()).toEqual(before);
  });

  it('a calendar invite the owner declined takes no ticket: it stays excluded and the show is its own occasion', () => {
    const dinner = calEvent(w.db, { summary: 'Team dinner', location: 'Copperline Hall', start: evening(-28, 18), end: evening(-28, 20), attendees: DECLINED });
    const show = ticketEvent(w.db, { title: 'Velvet Static', performers: ['Velvet Static'], venue: 'Copperline Hall', start: evening(-28, 20) });
    // a shared calendar's copy of the invite (a candidate copy, never declined itself) doesn't take one either
    const supper = calEvent(w.db, { summary: 'Guild supper', location: 'Marigold Ballroom', start: evening(-32, 18), attendees: DECLINED });
    calEvent(w.db, { calendar: CAL.community, summary: 'Guild supper', location: 'Marigold Ballroom', start: evening(-32, 18), creator: 'organizer@example.com' });
    const show2 = ticketEvent(w.db, { title: 'Quiet Comets', performers: ['Quiet Comets'], venue: 'Marigold Ballroom', start: evening(-32, 20) });
    run();
    for (const [cal, t, title] of [
      [dinner, show, 'Velvet Static'],
      [supper, show2, 'Quiet Comets'],
    ] as const) {
      const id = occasionOf(w.db, cal)!;
      expect(occById(id)).toMatchObject({ status: 'excluded' });
      expect(sourcesOf(id).map((s) => s.source)).not.toContain('ticket');
      expect(attendeesOf(w.db, id)).toEqual([]);
      const own = occasionOfTicketRef(w.db, t)!;
      expect(own).not.toBe(id);
      expect(occById(own)).toMatchObject({ title, kind: 'social', classification_rule: 'ticket', status: 'active' });
      expect(sourcesOf(own)).toEqual([{ source: 'ticket', source_ref: t, role: 'primary' }]);
    }
  });
});

describe('ticket-only occasions', () => {
  const quietComets = () => ticketEvent(w.db, { title: 'Quiet Comets', performers: ['Quiet Comets'], venue: 'Marigold Ballroom', city: 'Springfield', start: evening(-18, 21), bought: 2, sent: 1 });
  const romyTexts = () => {
    w.romy.dm.say(evening(-19, 12), w.romy.phone, 'are you going to quiet comets at marigold tmrw?');
    w.romy.dm.say(evening(-18, 21, 30), w.romy.phone, 'where are you? near the stage');
    w.romy.dm.say(evening(-17, 11), w.romy.phone, 'fun night! the encore was wild');
  };

  it('a ticket alone is a social occasion; resolved ticket parties are named ticket holders; the count caps message-only companions', () => {
    const t = quietComets();
    ticketParty(w.db, t, { direction: 'sent_to', personId: w.ines.id });
    // a hidden person the ledger resolved is never surfaced
    ticketParty(w.db, t, { direction: 'received_from', personId: w.hallie.id });
    romyTexts();
    run();
    const id = occasionOfTicketRef(w.db, t)!;
    expect(occById(id)).toMatchObject({
      title: 'Quiet Comets',
      venue_text: 'Marigold Ballroom, Springfield',
      venue_key: 'marigold ballroom',
      kind: 'social',
      classification_rule: 'ticket',
      ticket_count: 2,
      status: 'active',
      corroborated: 1,
      calendar_treatment: 'attending',
    });
    const rows = attendeesOf(w.db, id);
    expect(rows.find((a) => a.person_id === w.ines.id)).toMatchObject({ status: 'attended', role: 'ticket_holder', source: 'calendar_text' });
    expect(JSON.parse(rows.find((a) => a.person_id === w.ines.id)!.evidence)).toEqual([{ t: 'ticket_holder', w: 0.85, ref: `ticket:${t}` }]);
    // 2 tickets = me + Ines: Romy's texts make her possible, not counted
    expect(rows.find((a) => a.person_id === w.romy.id)).toMatchObject({ status: 'possible', source: 'inferred', confidence: 0.74 });
    expect(rows.some((a) => a.person_id === w.hallie.id)).toBe(false);
    expect(w.db.prepare('SELECT count(*) FROM occasion_candidates WHERE occasion_id = ? AND person_id = ?').pluck().get(id, w.hallie.id)).toBe(0);
  });

  it('attendee inference from messages still runs (no calendar notes): one unnamed companion fits two tickets', () => {
    const t = quietComets();
    romyTexts();
    run();
    const rows = attendeesOf(w.db, occasionOfTicketRef(w.db, t)!);
    expect(rows.map((r) => [r.person_id, r.status, r.source])).toEqual([[w.romy.id, 'attended', 'inferred']]);
    expect(rows[0]!.evidence).not.toMatch(/quiet|comets|encore/i);
  });

  it('a ticket that is sold, given away or cancelled retires its ticket-only occasion; holding again revives the same id', () => {
    const t = quietComets();
    ticketParty(w.db, t, { direction: 'sent_to', personId: w.ines.id });
    run();
    const id = occasionOfTicketRef(w.db, t)!;
    expect(attendeesOf(w.db, id).map((a) => a.status)).toEqual(['attended']);
    for (const status of ['sold', 'gave_away', 'cancelled'] as const) {
      updateTicket(w.db, t, { status, held: 0 });
      const s = run(NOW + 10);
      expect(occById(id).status).toBe('cancelled');
      expect(attendeesOf(w.db, id).map((a) => a.status)).toEqual(['withdrawn']);
      expect(w.db.prepare(`SELECT count(*) FROM interactions WHERE occasion_id = ? AND retracted_at IS NULL`).pluck().get(id)).toBe(0);
      if (status === 'sold') expect(s.occasionsRetired).toBe(1);
      updateTicket(w.db, t, { status: 'holding', held: 1 });
      run(NOW + 20);
      expect(occasionOfTicketRef(w.db, t)).toBe(id);
      expect(occById(id).status).toBe('active');
    }
    expect(w.db.prepare(`SELECT count(*) FROM occasions WHERE title = 'Quiet Comets'`).pluck().get()).toBe(1);
  });

  it('an occasion still backed by a calendar copy stays when its ticket is sold (the ticket source goes)', () => {
    const t = ticketEvent(w.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 20) });
    run();
    const id = occasionOf(w.db, w.ev.concert!)!;
    expect(occasionOfTicketRef(w.db, t)).toBe(id);
    updateTicket(w.db, t, { status: 'sold', held: 0, qty_sold: 2 });
    run(NOW + 5);
    expect(occasionOf(w.db, w.ev.concert!)).toBe(id);
    expect(occById(id)).toMatchObject({ status: 'active', ticket_count: 2 });
    expect(sourcesOf(id)).toEqual([{ source: 'calendar', source_ref: w.ev.concert, role: 'primary' }]);
    expect(hasLiveTicket(w.db, id)).toBe(false);
  });

  it('a ledger merge keeps the occasion: the stale ref is rewritten to the surviving ticket', () => {
    const a = quietComets();
    run();
    const id = occasionOfTicketRef(w.db, a)!;
    const b = ticketEvent(w.db, { title: 'Quiet Comets (late show)', venue: 'Marigold Ballroom', start: evening(-18, 21), bought: 2 });
    updateTicket(w.db, a, { merged_into_id: b });
    run(NOW + 5);
    expect(occasionOfTicketRef(w.db, a)).toBeUndefined();
    expect(occasionOfTicketRef(w.db, b)).toBe(id);
    expect(occById(id)).toMatchObject({ status: 'active', title: 'Quiet Comets (late show)' });
    expect(occasionOfTicket(w.db, a)).toBe(id);
    // a chain: the survivor is merged again; every ref resolves to the last survivor and the occasion stays
    const c = ticketEvent(w.db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: evening(-18, 21), bought: 2 });
    updateTicket(w.db, b, { merged_into_id: c });
    run(NOW + 10);
    expect(sourcesOf(id)).toEqual([{ source: 'ticket', source_ref: c, role: 'primary' }]);
    expect(loadTicketEvents(w.db, NOW - 400 * DAY, NOW + 90 * DAY).live.find((e) => e.id === c)!.ticket!.aliases).toEqual([a, b].sort());
    expect(occasionOfTicket(w.db, a)).toBe(id);
    expect(occasionTickets(w.db, id)).toEqual([{ id: c, status: 'holding' }]);
    expect(w.db.prepare(`SELECT count(*) FROM occasions WHERE merged_into_id IS NULL AND title LIKE 'Quiet Comets%'`).pluck().get()).toBe(1);
  });

  it('a ticket deleted from the ledger (Gmail disconnect) cancels its ticket-only occasion, not excluded; a calendar-backed one only loses the source', () => {
    const t = quietComets();
    const t2 = ticketEvent(w.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 20) });
    run();
    const alone = occasionOfTicketRef(w.db, t)!;
    const concert = occasionOf(w.db, w.ev.concert!)!;
    expect(occasionOfTicketRef(w.db, t2)).toBe(concert);
    w.db.prepare('DELETE FROM ticket_events WHERE id IN (?, ?)').run(t, t2);
    const s = run(NOW + 5);
    expect(s.occasionsRetired).toBe(1);
    expect(occById(alone).status).toBe('cancelled');
    expect(occasionTickets(w.db, alone)).toEqual([]);
    expect(hasLiveTicket(w.db, alone)).toBe(false);
    expect(occById(concert).status).toBe('active');
    expect(occById(concert).classification_rule).not.toBe('ticket');
    expect(sourcesOf(concert)).toEqual([{ source: 'calendar', source_ref: w.ev.concert, role: 'primary' }]);
  });
});

describe('copies are keyed by (source, id)', () => {
  /** Gives a ticket row the same id as a calendar event (ids of different sources may collide). */
  const sameId = (ticketId: string, as: string) => w.db.prepare('UPDATE ticket_events SET id = ? WHERE id = ?').run(as, ticketId);

  it('a ticket and a calendar event with the same id in one cluster keep both rows and their own roles', () => {
    const cal = calEvent(w.db, { summary: 'Quiet Comets w/ Romy', location: 'Marigold Ballroom', start: evening(-18, 21) });
    sameId(ticketEvent(w.db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: evening(-18, 21) }), cal);
    run();
    const id = occasionOf(w.db, cal)!;
    expect(sourcesOf(id)).toEqual([
      { source: 'calendar', source_ref: cal, role: 'primary' },
      { source: 'ticket', source_ref: cal, role: 'duplicate' },
    ]);
    const before = snapshot();
    run(NOW + 60_000);
    expect(snapshot()).toEqual(before);
    // sold: only the ticket's row goes
    updateTicket(w.db, cal, { status: 'sold', held: 0, qty_sold: 2 });
    run(NOW + 120_000);
    expect(occasionOf(w.db, cal)).toBe(id);
    expect(sourcesOf(id)).toEqual([{ source: 'calendar', source_ref: cal, role: 'primary' }]);
    expect(occById(id).status).toBe('active');
  });

  it('a ticket-only occasion never claims, or is claimed by, the calendar event that shares its id', () => {
    sameId(ticketEvent(w.db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: evening(-18, 21) }), w.ev.drinks!);
    run();
    const drinks = occasionOf(w.db, w.ev.drinks!)!;
    const show = occasionOfTicketRef(w.db, w.ev.drinks!)!;
    expect(show).not.toBe(drinks);
    expect(sourcesOf(drinks)).toEqual([{ source: 'calendar', source_ref: w.ev.drinks, role: 'primary' }]);
    expect(sourcesOf(show)).toEqual([{ source: 'ticket', source_ref: w.ev.drinks, role: 'primary' }]);
    const before = snapshot();
    run(NOW + 60_000);
    expect(snapshot()).toEqual(before);
    // the ticket goes: its occasion is cancelled, the drinks stay
    updateTicket(w.db, w.ev.drinks!, { status: 'sold', held: 0 });
    run(NOW + 120_000);
    expect(occById(show).status).toBe('cancelled');
    expect(occById(drinks)).toMatchObject({ status: 'active', title: 'Drinks w/ Quill' });
    expect(sourcesOf(drinks)).toEqual([{ source: 'calendar', source_ref: w.ev.drinks, role: 'primary' }]);
  });
});

describe('released tickets and Gmail-made copies', () => {
  it('a sold ticket matching a fromGmail-only cluster makes it excluded; own events and table reservations stay', () => {
    const gm = fromGmail('Velvet Static', evening(-30, 20), 'Copperline Hall');
    ticketEvent(w.db, { title: 'Velvet Static', venue: 'Copperline Hall', start: evening(-30, 20), sold: 2, status: 'sold' });
    const own = calEvent(w.db, { summary: 'Ninefold Echo w/ Romy', location: 'Pinecrest Amphitheater', start: evening(-32, 20) });
    ticketEvent(w.db, { title: 'Ninefold Echo', venue: 'Pinecrest Amphitheater', start: evening(-32, 20), sent: 2, status: 'gave_away' });
    const table = fromGmail('Reservation at Sable Bistro', evening(-34, 18), 'Sable Bistro');
    ticketEvent(w.db, { title: 'Glass Harbor', venue: 'Copperline Hall', start: evening(-34, 20), sold: 2, status: 'sold' });
    // a Gmail-made copy that also carries a Partiful link: someone invited him, so it is not just the ticket's copy
    const invited = calEvent(w.db, {
      summary: 'Marrow Lights',
      description: 'https://partiful.com/e/PtyEvt0007',
      location: 'Pinecrest Amphitheater',
      start: evening(-38, 20),
      eventType: 'fromGmail',
      creator: null,
    });
    ticketEvent(w.db, { title: 'Marrow Lights', venue: 'Pinecrest Amphitheater', start: evening(-38, 20), sold: 2, status: 'refunded' });
    run();
    expect(occById(occasionOf(w.db, gm))).toMatchObject({ status: 'excluded' });
    expect(attendeesOf(w.db, occasionOf(w.db, gm)!)).toEqual([]);
    expect(sourcesOf(occasionOf(w.db, gm)!)).toEqual([{ source: 'calendar', source_ref: gm, role: 'primary' }]);
    expect(occById(occasionOf(w.db, own))).toMatchObject({ status: 'active' });
    expect(occById(occasionOf(w.db, table))).toMatchObject({ status: 'active' });
    expect(occById(occasionOf(w.db, invited))).toMatchObject({ status: 'active' });
    // released tickets are never sources
    expect(w.db.prepare(`SELECT count(*) FROM occasion_sources WHERE source = 'ticket'`).pluck().get()).toBe(0);
  });

  it('holding → sold on a Gmail-made copy: same occasion, now excluded, its attendee rows withdrawn', () => {
    const gm = fromGmail('Velvet Static', evening(-30, 20), 'Copperline Hall');
    const t = ticketEvent(w.db, { title: 'Velvet Static', venue: 'Copperline Hall', start: evening(-30, 20) });
    ticketParty(w.db, t, { direction: 'sent_to', personId: w.ines.id });
    run();
    const id = occasionOf(w.db, gm)!;
    expect(occasionOfTicketRef(w.db, t)).toBe(id);
    expect(attendeesOf(w.db, id).map((a) => [a.person_id, a.status])).toEqual([[w.ines.id, 'attended']]);
    updateTicket(w.db, t, { status: 'sold', held: 0, qty_sold: 2 });
    run(NOW + 5);
    expect(occasionOf(w.db, gm)).toBe(id);
    expect(occById(id).status).toBe('excluded');
    expect(occasionOfTicketRef(w.db, t)).toBeUndefined();
    expect(attendeesOf(w.db, id).map((a) => a.status)).toEqual(['withdrawn']);
    expect(occasionOfTicket(w.db, t)).toBeNull();
  });
});

describe('classification', () => {
  it('a live ticket source overrides an LLM classification (never the user’s)', () => {
    run();
    const id = occasionOf(w.db, w.ev.concert!)!;
    w.db.prepare(`UPDATE occasions SET kind = 'work', is_social = 0, classified_by = 'llm', classification_confidence = 0.8 WHERE id = ?`).run(id);
    run(NOW + 1);
    expect(occById(id)).toMatchObject({ kind: 'work', is_social: 0, classified_by: 'llm' });
    ticketEvent(w.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 20) });
    run(NOW + 2);
    expect(occById(id)).toMatchObject({ kind: 'social', is_social: 1, classified_by: 'rule', classification_rule: 'ticket', status: 'active' });
    // the owner's own word stands
    w.db.prepare(`UPDATE occasions SET kind = 'work', is_social = 0, classified_by = 'user' WHERE id = ?`).run(id);
    run(NOW + 3);
    expect(occById(id)).toMatchObject({ kind: 'work', is_social: 0, classified_by: 'user' });
  });

  it('the ticket rule runs before medical for shows, after it for anything else', () => {
    const base = { notes: [], location: null, allDay: false, startsAt: NOW, endsAt: NOW + 2 * HOUR, hasPartiful: false, hasReservation: false, mentions: [], explicitAttendees: 0 };
    expect(classifyOccasion({ ...base, titles: ['Doctor Velvet'], ticketCategory: 'concert' })).toMatchObject({ kind: 'social', rule: 'ticket', sensitive: false, confidence: 0.9 });
    expect(classifyOccasion({ ...base, titles: ['Dental care talk'], ticketCategory: 'talk' })).toMatchObject({ kind: 'appointment', sensitive: true });
    expect(classifyOccasion({ ...base, titles: ['Pottery workshop'], ticketCategory: 'other' })).toMatchObject({ kind: 'social', rule: 'ticket' });
    expect(classifyOccasion({ ...base, titles: ['Pottery workshop'] })).toMatchObject({ kind: 'work' });
    const t = ticketEvent(w.db, { title: 'Doctor Velvet', venue: 'Copperline Hall', start: evening(-40, 20) });
    run();
    expect(occById(occasionOfTicketRef(w.db, t))).toMatchObject({ kind: 'social', sensitive: 0, classification_rule: 'ticket' });
  });
});

describe('re-runs', () => {
  it('a second pass over unchanged calendars and tickets writes nothing and opens no run', () => {
    const t = ticketEvent(w.db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: evening(-18, 21) });
    ticketParty(w.db, t, { direction: 'sent_to', personId: w.ines.id });
    ticketEvent(w.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 20) });
    fromGmail('Velvet Static', evening(-30, 20), 'Copperline Hall');
    ticketEvent(w.db, { title: 'Velvet Static', venue: 'Copperline Hall', start: evening(-30, 20), sold: 2, status: 'sold' });
    run();
    const before = snapshot();
    const s = run(NOW + 60_000);
    expect(s).toMatchObject({ occasionsCreated: 0, occasionsUpdated: 0, occasionsRetired: 0, attendeesInserted: 0, attendeesUpdated: 0, attendeesWithdrawn: 0, interactionsUpserted: 0, edgesUpserted: 0 });
    expect(snapshot()).toEqual(before);
  });

  it('with no live ticket rows a pass is exactly the calendar-only pass (unconfirmed and out-of-window rows change nothing)', () => {
    run();
    const before = snapshot();
    ticketEvent(w.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 20), bought: 0, status: 'unconfirmed' });
    ticketEvent(w.db, { title: 'Long Ago Band', venue: 'Copperline Hall', start: NOW - 500 * DAY });
    const s = run(NOW + 60_000);
    expect(s.ticketEvents).toBe(0);
    expect(s).toMatchObject({ occasionsCreated: 0, occasionsUpdated: 0, attendeesInserted: 0, attendeesUpdated: 0 });
    expect(snapshot()).toEqual(before);
  });
});

describe('matching (pure)', () => {
  function copies(setup: (db: ReturnType<typeof memDb>) => void): { clusters: CalEvent[][]; tickets: ReturnType<typeof loadTicketEvents> } {
    const db = memDb();
    const me = seedPerson(db, { kind: 'me', display_name: 'Me' });
    seedIdentity(db, me, 'email', CAL.personal);
    setup(db);
    return { clusters: clusterEvents(loadCalendarEvents(db, calendarTreatments(db), NOW - 400 * DAY, NOW + 90 * DAY)), tickets: loadTicketEvents(db, NOW - 400 * DAY, NOW + 90 * DAY) };
  }

  it('scores: shared Partiful id > venue ±3 h > title on the day > Gmail-made copy ±3 h; trips never match', () => {
    const { clusters, tickets } = copies((db) => {
      calEvent(db, { summary: 'Something', description: 'https://partiful.com/e/PtyEvt0009', start: evening(-3, 12) });
      calEvent(db, { summary: 'Out', location: 'Copperline Hall', start: evening(-3, 19) });
      calEvent(db, { summary: 'Lantern Choir', start: evening(-3, 9) });
      calEvent(db, { summary: 'Order confirmed', start: evening(-3, 21), eventType: 'fromGmail', creator: null });
      calEvent(db, { summary: 'Hotel stay at Example Inn', location: 'Copperline Hall', start: evening(-3, 20) });
      ticketEvent(db, { title: 'Lantern Choir', venue: 'Copperline Hall', start: evening(-3, 20), partifulIds: ['PtyEvt0009'] });
    });
    const t = tickets.live[0]!;
    const score = (summary: string) => ticketMatch(t, clusters.flat().find((e) => e.title === summary)!, 'UTC');
    expect(score('Something')).toBe(4);
    expect(score('Out')).toBeCloseTo(3 + 0.5 * (2 / 3), 3);
    expect(score('Lantern Choir')).toBe(2.5);
    expect(score('Order confirmed')).toBeCloseTo(1 + 0.5 * (2 / 3), 3);
    expect(score('Hotel stay at Example Inn')).toBe(0);
    const out = attachTickets(clusters, tickets, 'UTC');
    expect(out.clusters.find((c) => c.includes(t))!.map((e) => e.title).sort()).toEqual(['Lantern Choir', 'Something']);
  });

  it('same-day rules read the venue date: a timed copy in the venue zone, a guessed zone in the owner zone', () => {
    // 23:30 in New York is already the next day in UTC; the owner's copy at 21:00 New York time is that show
    const ny = copies((db) => {
      calEvent(db, { summary: 'Quiet Comets', start: Date.UTC(2026, 9, 2, 1, 0) });
      ticketEvent(db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: Date.UTC(2026, 9, 2, 3, 30), tz: 'America/New_York' });
    });
    expect(ny.tickets.live[0]!.ticket).toMatchObject({ tz: 'America/New_York', localDate: '2026-10-01' });
    expect(ticketMatch(ny.tickets.live[0]!, ny.clusters.flat()[0]!, 'UTC')).toBe(2.5);
    expect(attachTickets(ny.clusters, ny.tickets, 'UTC').clusters).toHaveLength(1);

    // a guessed zone: the ledger read 20:00 as the owner's (Los Angeles) time; same venue an hour apart still joins
    // only by title on the local date (never venue ±3 h, which would score 3.33), and only in the owner's zone
    const guessed = copies((db) => {
      calEvent(db, { summary: 'Quiet Comets', location: 'Marigold Ballroom', start: Date.UTC(2026, 9, 2, 2) });
      ticketEvent(db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: Date.UTC(2026, 9, 2, 3), tz: null, localDate: '2026-10-01' });
    });
    const g = guessed.tickets.live[0]!;
    expect(g.ticket!.tz).toBeNull();
    expect(ticketMatch(g, guessed.clusters.flat()[0]!, 'America/Los_Angeles')).toBe(2.5);
    expect(ticketMatch(g, guessed.clusters.flat()[0]!, 'UTC')).toBe(0);
  });

  it("an all-day copy is a date on the owner's calendar: read in the owner's zone, never the venue's", () => {
    // the owner (Los Angeles) put an all-day "Quiet Comets" on Oct 1, stored at his local midnight; the band plays
    // Tokyo on Oct 1 and Oct 2. In Tokyo's zone that all-day span touches Oct 2 too, which must not count.
    const { clusters, tickets } = copies((db) => {
      calEvent(db, { summary: 'Quiet Comets', start: Date.UTC(2026, 9, 1, 7), end: Date.UTC(2026, 9, 2, 7), allDay: true });
      ticketEvent(db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: Date.UTC(2026, 9, 1, 10), tz: 'Asia/Tokyo' });
      ticketEvent(db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: Date.UTC(2026, 9, 2, 10), tz: 'Asia/Tokyo' });
    });
    const [day1, day2] = tickets.live;
    expect([day1!.ticket!.localDate, day2!.ticket!.localDate]).toEqual(['2026-10-01', '2026-10-02']);
    const allDay = clusters.flat()[0]!;
    expect(ticketMatch(day1!, allDay, 'America/Los_Angeles')).toBe(2.5);
    expect(ticketMatch(day2!, allDay, 'America/Los_Angeles')).toBe(0);
    const out = attachTickets(clusters, tickets, 'America/Los_Angeles');
    expect(out.clusters.map((c) => c.map((e) => e.source))).toEqual([['calendar', 'ticket'], ['ticket']]);
    expect(out.clusters[0]).toContain(day1);
  });

  it('a multi-day all-day copy (a trip, a festival weekend) never takes a ticket', () => {
    const { clusters, tickets } = copies((db) => {
      calEvent(db, { summary: 'Quiet Comets', start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 4), allDay: true });
      ticketEvent(db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: Date.UTC(2026, 9, 2, 20) });
    });
    expect(ticketMatch(tickets.live[0]!, clusters.flat()[0]!, 'UTC')).toBe(0);
    expect(attachTickets(clusters, tickets, 'UTC').clusters).toHaveLength(2);
  });

  it('a shared Partiful id matches any copy (a trip, a multi-day all-day copy, one he declined); nothing else matches a declined copy', () => {
    const { clusters, tickets } = copies((db) => {
      calEvent(db, { summary: 'Camp weekend', description: 'https://partiful.com/e/PtyEvt0077', start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 3), allDay: true });
      calEvent(db, { summary: 'Lake trip', description: 'https://partiful.com/e/PtyEvt0077', start: Date.UTC(2026, 9, 1, 10) });
      calEvent(db, { summary: 'Team dinner', description: 'https://partiful.com/e/PtyEvt0077', start: Date.UTC(2026, 9, 1, 18), attendees: DECLINED });
      calEvent(db, { summary: 'Guild supper', location: 'Copperline Hall', start: Date.UTC(2026, 9, 1, 18), attendees: DECLINED });
      ticketEvent(db, { title: 'Camp weekend', category: 'party', venue: 'Copperline Hall', start: Date.UTC(2026, 9, 1, 20), partifulIds: ['PtyEvt0077'] });
      ticketEvent(db, { title: 'Velvet Static', venue: 'Copperline Hall', start: Date.UTC(2026, 9, 1, 20) });
    });
    const [camp, show] = tickets.live;
    const by = (summary: string) => clusters.flat().find((e) => e.title === summary)!;
    expect([by('Camp weekend').kind, by('Lake trip').kind]).toEqual(['travel', 'travel']);
    expect([by('Team dinner').selfDeclined, by('Guild supper').selfDeclined]).toEqual([true, true]);
    for (const summary of ['Camp weekend', 'Lake trip', 'Team dinner']) expect(ticketMatch(camp!, by(summary), 'UTC')).toBe(4);
    // the same venue ±3 h would score 3.33
    expect(ticketMatch(show!, by('Guild supper'), 'UTC')).toBe(0);
    const out = attachTickets(clusters, tickets, 'UTC');
    expect(out.clusters.find((c) => c.includes(camp!))!.map((e) => e.title)).toEqual(['Camp weekend', 'Lake trip', 'Team dinner', 'Camp weekend']);
    expect(out.clusters.find((c) => c.includes(show!))).toEqual([show]);
  });

  it('a ticket copy left outside the cluster carrying its Partiful id drops that id (one draft claims the Partiful event)', () => {
    const { clusters, tickets } = copies((db) => {
      calEvent(db, { summary: 'Rooftop social', location: 'Juniper Terrace', description: 'https://partiful.com/e/PtyEvt0079', start: Date.UTC(2026, 9, 1, 20) });
      ticketEvent(db, { title: 'Rooftop social', category: 'party', venue: 'Juniper Terrace', start: Date.UTC(2026, 9, 1, 20), partifulIds: ['PtyEvt0079'] });
      ticketEvent(db, { title: 'Rooftop social: late entry', category: 'party', venue: 'Juniper Terrace', start: Date.UTC(2026, 9, 1, 22), partifulIds: ['PtyEvt0079', 'PtyEvt0082'] });
      ticketEvent(db, { title: 'Orchard picnic', category: 'party', venue: 'Quince Orchard', start: Date.UTC(2026, 9, 5, 13), partifulIds: ['PtyEvt0081'] });
      ticketEvent(db, { title: 'Orchard picnic (plus one)', category: 'party', venue: 'Quince Orchard', start: Date.UTC(2026, 9, 5, 14), partifulIds: ['PtyEvt0081'] });
    });
    const out = attachTickets(clusters, tickets, 'UTC');
    const ids = out.clusters.map((c) => c.map((e) => `${e.source}:${e.title}:${e.partifulIds.join('+')}`));
    expect(ids).toEqual([
      ['calendar:Rooftop social:PtyEvt0079', 'ticket:Rooftop social:PtyEvt0079'],
      // an id no other cluster carries stays
      ['ticket:Rooftop social: late entry:PtyEvt0082'],
      ['ticket:Orchard picnic:PtyEvt0081'],
      ['ticket:Orchard picnic (plus one):'],
    ]);
    // the loaded copies themselves are not changed
    expect(tickets.live.map((t) => t.partifulIds)).toEqual([['PtyEvt0079'], ['PtyEvt0079', 'PtyEvt0082'], ['PtyEvt0081'], ['PtyEvt0081']]);
  });

  it('a performer named in a work or errand title is not the show; in a plain or social title it is', () => {
    const { clusters, tickets } = copies((db) => {
      calEvent(db, { summary: 'Glass Harbor team meeting', start: evening(-4, 15) });
      calEvent(db, { summary: 'Seeing Glass Harbor', start: evening(-4, 18) });
      ticketEvent(db, { title: 'An Evening Under the Pines', performers: ['Glass Harbor'], venue: 'Pinecrest Amphitheater', start: evening(-4, 20) });
    });
    const t = tickets.live[0]!;
    const by = (summary: string) => clusters.flat().find((e) => e.title === summary)!;
    expect(by('Glass Harbor team meeting').kind).toBe('work');
    expect(ticketMatch(t, by('Glass Harbor team meeting'), 'UTC')).toBe(0);
    expect(ticketMatch(t, by('Seeing Glass Harbor'), 'UTC')).toBe(2);
    expect(attachTickets(clusters, tickets, 'UTC').clusters.find((c) => c.includes(t))!.map((e) => e.title)).toEqual(['Seeing Glass Harbor', 'An Evening Under the Pines']);
  });

  it('with no tickets the clusters come back as they were', () => {
    const { clusters, tickets } = copies((db) => {
      calEvent(db, { summary: 'Drinks w/ Quill', location: 'Moss & Fern', start: evening(-3, 18) });
    });
    const out = attachTickets(clusters, tickets, 'UTC');
    expect(out.clusters).toBe(clusters);
    expect(out.released.size).toBe(0);
  });
});
