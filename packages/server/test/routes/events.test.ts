import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/http/app';
import { runOccasions } from '../../src/pipeline/occasions/run';
import { hiddenNameRedactor, type EventDetail, type EventsPage } from '../../src/routes/events';
import { normalizeOccasionDetail } from '../../../web/src/lib/events';
import { buildWorld, CAL, calEvent, evening, NOW, occasionOf, TZ, updateCalEvent, type World } from '../pipeline/occasions/world';

let w: World;
let app: ReturnType<typeof createApp>;
let merged: { survivor: string; absorbed: string };

beforeAll(() => {
  w = buildWorld();
  // two occasions that a later pass finds are one evening (pointer merge)
  const own = calEvent(w.db, { summary: 'Dinner w/ Romy', location: 'Sable Bistro', start: evening(-30) });
  const res = calEvent(w.db, { summary: 'Reservation at Sable Bistro', location: 'Sable Bistro', start: evening(-30, 21, 30), eventType: 'fromGmail', creator: null });
  runOccasions(w.db, { now: NOW, timeZone: TZ });
  const absorbed = occasionOf(w.db, res)!;
  updateCalEvent(w.db, res, { starts_at: evening(-30, 19, 15) });
  runOccasions(w.db, { now: NOW, timeZone: TZ });
  merged = { survivor: occasionOf(w.db, own)!, absorbed };
  app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

const get = async <T>(url: string, status = 200): Promise<T> => {
  const res = await request(app).get(url);
  expect(res.status, `${url} → ${res.text}`).toBe(status);
  return res.body as T;
};
const occ = (key: string) => occasionOf(w.db, w.ev[key]!)!;

/** Nothing about the hidden person: id, name, phone, nor any message text. */
const expectClean = (body: unknown) => {
  const s = JSON.stringify(body);
  expect(s).not.toContain(w.hallie.id);
  expect(s.toLowerCase()).not.toContain('hallie');
  expect(s).not.toMatch(/555555\d{4}/);
  expect(s).not.toMatch(/omw|grabbed a table|catching up|copper kettle tonight/i);
};

describe('GET /api/v1/events', () => {
  it('past: social occasions newest first; logistics, medical, uncorroborated and excluded never listed', async () => {
    const page = await get<EventsPage>('/api/v1/events?when=past&limit=100');
    const titles = page.items.map((i) => i.title);
    expect(titles).toEqual([
      'Trivia night',
      "Sol's housewarming",
      'Dinner w/ Romy & Tavi',
      'Fernhollow concert',
      'Drinks w/ Quill',
      'Board games',
      'Lunch w/ …',
      'Dinner w/ the Climbing Crew',
      'Dinner w/ Romy',
    ]);
    for (const t of ['Maid service', 'HOA meeting', 'Dentist cleaning', 'Community potluck', 'Columbus Day', 'Reservation at Lupine Room']) expect(titles).not.toContain(t);
    expect(page.nextCursor).toBeNull();
    expectClean(page);
  });

  it('items carry counted attendees (names through person_visible), possible counts and sources', async () => {
    const page = await get<EventsPage>('/api/v1/events?when=past&limit=100');
    const dinner = page.items.find((i) => i.id === occ('dinner'))!;
    expect(dinner).toMatchObject({ type: 'occasion', kind: 'social', venue: 'Lupine Room, 2 Example Ave, Springfield', sources: ['calendar'], attendeeCount: 2, possibleCount: 0 });
    expect(dinner.attendees.map((a) => a.displayName)).toEqual(['Romy Castell', 'Tavi Dunmore']);
    const party = page.items.find((i) => i.id === occ('party'))!;
    expect(party).toMatchObject({ sources: ['calendar', 'partiful'], attendeeCount: 1, possibleCount: 1 });
    expect(party.attendees).toEqual([{ personId: w.sol.id, displayName: 'Sol Hart' }]);
  });

  it('pages with a cursor without gaps or repeats', async () => {
    const all = (await get<EventsPage>('/api/v1/events?when=past&limit=100')).items.map((i) => i.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: EventsPage = await get<EventsPage>(`/api/v1/events?when=past&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
    await get('/api/v1/events?when=past&cursor=nope', 400);
  });

  it('upcoming: soonest first, including a Partiful event with no calendar copy; trips on their own filter', async () => {
    const page = await get<EventsPage>('/api/v1/events?when=upcoming');
    expect(page.items.map((i) => [i.type, i.title])).toEqual([
      ['occasion', 'Brunch w/ Romy'],
      ['event', 'Picnic in the park'],
    ]);
    expect(page.items[1]).toMatchObject({ id: w.partifulOnly, sources: ['partiful'], attendeeCount: 1 });
    const trips = await get<EventsPage>('/api/v1/events?when=upcoming&kind=trips');
    expect(trips.items.map((i) => [i.kind, i.title])).toEqual([['lodging', 'Stay at Example Inn']]);
    await get('/api/v1/events?when=someday', 400);
  });
});

describe('GET /api/v1/events/:id', () => {
  it('an occasion with its sources, attendees, confidence, source and evidence ids (no text)', async () => {
    const d = await get<EventDetail>(`/api/v1/events/${occ('dinner')}`);
    expect(d).toMatchObject({ type: 'occasion', title: 'Dinner w/ Romy & Tavi', kind: 'social', isSocial: true, status: 'active', corroborated: true });
    expect(d.sources).toEqual([
      { source: 'calendar', role: 'primary', title: 'Dinner w/ Romy & Tavi', calendarTreatment: 'attending' },
      { source: 'calendar', role: 'reservation', title: 'Reservation at Lupine Room', calendarTreatment: 'attending' },
    ]);
    const tavi = d.attendees.find((a) => a.personId === w.tavi.id)!;
    expect(tavi).toMatchObject({ status: 'attended', source: 'calendar_text', role: 'companion', counted: true });
    const logistics = tavi.evidence.find((e) => e.type === 'logistics_dm')!;
    expect(logistics.messageIds).toEqual([expect.any(Number)]);
    expect(Object.keys(logistics).sort()).toEqual(['messageIds', 'ref', 'type', 'weight']);
    expectClean(d);
  });

  it('a Partiful-linked occasion: counted host, possible MAYBE, no hidden guest', async () => {
    const d = await get<EventDetail>(`/api/v1/events/${occ('party')}`);
    expect(d.partifulEvent).toMatchObject({ id: w.partifulEvent, title: 'Housewarming at the loft' });
    expect(d.attendees.map((a) => [a.displayName, a.counted, a.source])).toEqual([
      ['Sol Hart', true, 'partiful'],
      ['Pim Iver', false, 'partiful'],
    ]);
    expectClean(d);
  });

  it("names the occasion's calendars and the owner's RSVP; the web client reads them (contract)", async () => {
    const cal = w.db.prepare(
      `INSERT INTO gcal_calendars (calendar_id, summary, is_primary, kind, default_treatment, first_seen_at, last_listed_at, updated_at)
       VALUES (?, ?, ?, ?, 'attending', ?, ?, ?)`,
    );
    cal.run(CAL.personal, CAL.personal, 1, 'primary', NOW, NOW, NOW); // Google names the primary calendar by its address
    cal.run(CAL.feed, "Hallie's Partiful feed", 0, 'partiful_feed', NOW, NOW, NOW);
    try {
      const d = await get<EventDetail>(`/api/v1/events/${occ('party')}`);
      expect(d.calendars).toEqual(['Primary', "…'s Partiful feed"]);
      expect(d.myRsvp).toBe('going'); // the linked Partiful event's
      const view = normalizeOccasionDetail(d)!;
      expect(view).toMatchObject({
        id: d.id,
        calendars: d.calendars,
        myRsvp: 'going',
        url: 'https://partiful.com/e/PtyEvt0001',
        sources: ['calendar', 'partiful'],
        attendeeCount: 1,
        possibleCount: 1,
      });
      expect(view.attendees.map((a) => [a.personId, a.tier, a.source])).toEqual([
        [w.sol.id, 'confirmed', 'partiful'],
        [w.pim.id, 'possible', 'partiful'],
      ]);
      expectClean(d);

      const dinner = normalizeOccasionDetail(await get<EventDetail>(`/api/v1/events/${occ('dinner')}`))!;
      expect(dinner).toMatchObject({ calendars: ['Primary'], myRsvp: null, url: null });
      const picnic = normalizeOccasionDetail(await get<EventDetail>(`/api/v1/events/${w.partifulOnly}`))!;
      expect(picnic).toMatchObject({ calendars: [], myRsvp: 'going', sources: ['partiful'] });
    } finally {
      w.db.prepare('DELETE FROM gcal_calendars').run();
    }
  });

  it('a Partiful event no occasion covers', async () => {
    const d = await get<EventDetail>(`/api/v1/events/${w.partifulOnly}`);
    expect(d).toMatchObject({ type: 'event', title: 'Picnic in the park', venue: 'Juniper Park' });
    expect(d.attendees.map((a) => [a.personId, a.counted])).toEqual([[w.romy.id, true]]);
  });

  it('a merged-away occasion answers with its survivor', async () => {
    const d = await get<EventDetail>(`/api/v1/events/${merged.absorbed}`);
    expect(d.id).toBe(merged.survivor);
    expect(d.sources.map((s) => s.role).sort()).toEqual(['primary', 'reservation']);
  });

  it('hidden names are blanked in titles; sensitive occasions are not served; bad ids are rejected', async () => {
    const lunch = await get<EventDetail>(`/api/v1/events/${occ('lunchHidden')}`);
    expect(lunch.title).toBe('Lunch w/ …');
    expectClean(lunch);
    const redact = hiddenNameRedactor(w.db);
    expect(redact("Hallie's birthday drinks w/ Romy")).toBe("…'s birthday drinks w/ Romy");
    expect(redact('Coffee w/ Hallie Grove at Grove Park')).toBe('Coffee w/ … … at Grove Park');
    await get(`/api/v1/events/${occ('dentist')}`, 404);
    await get('/api/v1/events/01a00000-0000-7000-8000-000000000000', 404);
    await get('/api/v1/events/not-an-id', 400);
  });
});
