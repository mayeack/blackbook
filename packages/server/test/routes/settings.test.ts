import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/http/app';
import type { PeoplePage } from '../../src/routes/people';
import type { HiddenPage } from '../../src/routes/settings';
import { seedPerson } from '../helpers';
import { buildWorld, type World } from './world';

let w: World;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  w = buildWorld();
  app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
});

const post = (url: string, body: object = {}) => request(app).post(url).set('X-YB', '1').set('Content-Type', 'application/json').send(body);

describe('Settings → Hidden', () => {
  it('lists hidden people (and only them) by last name; nowhere else does', async () => {
    const other = seedPerson(w.db, { first_name: 'Ada', last_name: 'Zeller', display_name: 'Ada Zeller', is_hidden: 1 });
    seedPerson(w.db, { first_name: 'Gone', last_name: 'Merged', display_name: 'Gone Merged', is_hidden: 1, status: 'merged', merged_into_id: w.alice });
    const res = await request(app).get('/api/v1/settings/hidden');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as HiddenPage).items.map((p) => p.id)).toEqual([w.hidden, other]);
    expect((res.body as HiddenPage).items[0]).toEqual({ id: w.hidden, displayName: w.hiddenName, company: null });
  });

  it('unhide is journaled and undoable, and never names the person in the feed', async () => {
    expect((await post(`/api/v1/settings/hidden/${w.hidden}/unhide`).set('X-YB', '')).status).toBe(403); // CSRF
    const res = await post(`/api/v1/settings/hidden/${w.hidden}/unhide`);
    expect(res.status).toBe(200);
    const people = (await request(app).get('/api/v1/people?limit=500')).body as PeoplePage;
    expect(people.items.map((p) => p.id)).toContain(w.hidden);
    expect(((await request(app).get('/api/v1/settings/hidden')).body as HiddenPage).items).toEqual([]);

    const feed = JSON.stringify((await request(app).get('/api/v1/activity')).body);
    expect(feed).toContain('Unhid a person');
    expect(feed).not.toContain('Halvard');

    const undo = await post(`/api/v1/activity/${res.body.batchId}/undo`);
    expect(undo.status).toBe(200);
    expect(((await request(app).get('/api/v1/settings/hidden')).body as HiddenPage).items.map((p) => p.id)).toEqual([w.hidden]);
    expect(JSON.stringify((await request(app).get('/api/v1/people?limit=500')).body)).not.toContain(w.hidden);
  });

  it('404s anyone not currently hidden; 400s malformed ids', async () => {
    expect((await post(`/api/v1/settings/hidden/${w.alice}/unhide`)).status).toBe(404);
    expect((await post(`/api/v1/settings/hidden/${w.aliceDup}/unhide`)).status).toBe(404);
    expect((await post('/api/v1/settings/hidden/nope/unhide')).status).toBe(400);
  });
});
