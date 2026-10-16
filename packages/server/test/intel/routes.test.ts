import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { uuidv7, EventBrief, TripsResponse } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { at, intelWorld, NOW, occasion, setSetting, type IntelWorld } from './world';

let w: IntelWorld;
let app: ReturnType<typeof createApp>;
let ana: string, bo: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  w = intelWorld();
  ana = w.person('Ana', 'Arbor', { tie: 70, historical: 70, state: 'strong' });
  bo = w.person('Bo', 'Birch', { tie: 40, historical: 50, state: 'steady' });
  app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
});
afterEach(() => vi.useRealTimers());

describe('GET /events/:id/brief', () => {
  it('answers the brief for a social occasion, 404 for sensitive / non-social / unknown ids, 400 for a bad id', async () => {
    const dinner = occasion(w.db, { title: 'Dinner w/ Ana & Bo', start: at(0, 19) });
    w.attendee(dinner, ana);
    w.attendee(dinner, bo);
    const res = await request(app).get(`/api/v1/events/${dinner}/brief`);
    expect(res.status).toBe(200);
    const b = EventBrief.parse(res.body);
    expect(b.attendees.map((a) => a.person.id)).toEqual([ana, bo]);
    expect(res.headers['cache-control']).toContain('no-store');

    const doctor = occasion(w.db, { title: 'Checkup', start: at(0, 9), kind: 'appointment', sensitive: true });
    expect((await request(app).get(`/api/v1/events/${doctor}/brief`)).status).toBe(404);
    const chores = occasion(w.db, { title: 'Maid service', start: at(0, 10), kind: 'logistics' });
    expect((await request(app).get(`/api/v1/events/${chores}/brief`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/events/${uuidv7()}/brief`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/events/not-an-id/brief`)).status).toBe(400);
  });
});

describe('GET /trips', () => {
  it('upcoming trips with the people there and the home city', async () => {
    setSetting(w.db, 'travel.home_city', 'Denver');
    w.fact(ana, 'location_current', 'Lisbon, Portugal');
    w.cal({ summary: 'Lisbon trip', start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 9, 25), allDay: true });
    const { runOccasions } = await import('../../src/pipeline/occasions/run');
    runOccasions(w.db, { now: NOW, timeZone: 'UTC' });
    const res = await request(app).get('/api/v1/trips');
    expect(res.status).toBe(200);
    const t = TripsResponse.parse(res.body);
    expect(t.home).toBe('Denver');
    expect(t.trips).toHaveLength(1);
    expect(t.trips[0]).toMatchObject({ label: 'Lisbon', startsOn: '2026-10-20', endsOn: '2026-10-24', people: [{ person: { id: ana }, reason: 'location_current' }] });
    expect((await request(app).get('/api/v1/trips?when=past')).body.trips).toEqual([]);
    expect((await request(app).get('/api/v1/trips?when=sometime')).status).toBe(400);
  });
});
