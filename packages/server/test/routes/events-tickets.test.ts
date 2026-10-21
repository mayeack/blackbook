import { beforeAll, describe, expect, it } from 'vitest';
import { runOccasions } from '../../src/pipeline/occasions/run';
import { eventDetail, listEvents } from '../../src/routes/events';
import { occasionOfTicketRef, ticketEvent } from '../pipeline/occasions/ticketFixtures';
import { buildWorld, evening, NOW, occasionOf, TZ, type World } from '../pipeline/occasions/world';

let w: World;
let ticketOnly: string;
let withConcert: string;

beforeAll(() => {
  w = buildWorld();
  withConcert = ticketEvent(w.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 20) });
  ticketOnly = ticketEvent(w.db, { title: 'Quiet Comets', performers: ['Quiet Comets'], venue: 'Marigold Ballroom', city: 'Springfield', start: evening(-18, 21) });
  ticketEvent(w.db, { title: 'Ninefold Echo', venue: 'Pinecrest Amphitheater', start: evening(6, 20) });
  runOccasions(w.db, { now: NOW, timeZone: TZ });
});

describe('events with ticket sources', () => {
  it("list items carry their sources from occasion_sources, 'ticket' included", () => {
    const past = listEvents(w.db, { when: 'past', kind: 'social', limit: 100, now: NOW });
    const concert = past.items.find((i) => i.id === occasionOf(w.db, w.ev.concert!))!;
    expect(concert.sources).toEqual(['calendar', 'ticket']);
    const alone = past.items.find((i) => i.id === occasionOfTicketRef(w.db, ticketOnly))!;
    expect(alone).toMatchObject({ type: 'occasion', title: 'Quiet Comets', kind: 'social', venue: 'Marigold Ballroom, Springfield', sources: ['ticket'] });
    // the calendar-only and Partiful-linked items read as before
    expect(past.items.find((i) => i.id === occasionOf(w.db, w.ev.dinner!))!.sources).toEqual(['calendar']);
    expect(past.items.find((i) => i.id === occasionOf(w.db, w.ev.party!))!.sources).toEqual(['calendar', 'partiful']);
    const upcoming = listEvents(w.db, { when: 'upcoming', kind: 'social', limit: 100, now: NOW });
    expect(upcoming.items.map((i) => [i.title, i.sources])).toContainEqual(['Ninefold Echo', ['ticket']]);
  });

  it('detail lists the ticket source with the vendor title', () => {
    const d = eventDetail(w.db, occasionOf(w.db, w.ev.concert!)!);
    expect(d.sources).toEqual([
      { source: 'calendar', role: 'primary', title: 'Fernhollow concert', calendarTreatment: 'attending' },
      { source: 'ticket', role: 'duplicate', title: 'Fernhollow', calendarTreatment: null },
    ]);
    expect(occasionOfTicketRef(w.db, withConcert)).toBe(d.id);
    const alone = eventDetail(w.db, occasionOfTicketRef(w.db, ticketOnly)!);
    expect(alone).toMatchObject({ type: 'occasion', isSocial: true, status: 'active', ticketCount: 2, calendars: [], myRsvp: null });
    expect(alone.sources).toEqual([{ source: 'ticket', role: 'primary', title: 'Quiet Comets', calendarTreatment: null }]);
  });

  it('a ticket he sold: its ticket-only event leaves the list, and a calendar-backed one loses the ticket source', () => {
    const v = buildWorld();
    const solo = ticketEvent(v.db, { title: 'Quiet Comets', venue: 'Marigold Ballroom', start: evening(-18, 21) });
    const withCal = ticketEvent(v.db, { title: 'Fernhollow', venue: 'Copperline Hall', start: evening(-8, 20) });
    runOccasions(v.db, { now: NOW, timeZone: TZ });
    const soloId = occasionOfTicketRef(v.db, solo)!;
    const set = v.db.prepare(`UPDATE ticket_events SET status = 'sold', qty_sold = 2, held = 0 WHERE id = ?`);
    set.run(solo);
    set.run(withCal);
    runOccasions(v.db, { now: NOW + 5, timeZone: TZ });
    const past = listEvents(v.db, { when: 'past', kind: 'social', limit: 100, now: NOW });
    expect(past.items.some((i) => i.id === soloId)).toBe(false);
    expect(past.items.find((i) => i.id === occasionOf(v.db, v.ev.concert!))!.sources).toEqual(['calendar']);
    // the detail of a retired one still answers (journaled rows may point at it), its source row kept
    expect(eventDetail(v.db, soloId)).toMatchObject({ status: 'cancelled', sources: [{ source: 'ticket', role: 'primary', title: 'Quiet Comets', calendarTreatment: null }] });
  });
});
