/**
 * Settings → Privacy (do-not-merge pairs, My identities) and Data (JSON export), synthetic data only
 * (555-01xx phones, example.com emails). Also: the settings environment reports LLM spend without a key.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { DoNotMergeList, MyIdentities, SettingsResponse } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { undoBatch } from '../../src/journal/undo';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';

function world() {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Me', first_name: 'Owner', last_name: 'Example' });
  seedIdentity(db, me, 'phone', '+12025550123');
  seedIdentity(db, me, 'email', 'owner@example.com');
  const ava = seedPerson(db, { display_name: 'Ava Quillfeather', first_name: 'Ava', last_name: 'Quillfeather' });
  const ava2 = seedPerson(db, { display_name: 'Ava Q', first_name: 'Ava', last_name: 'Q' });
  const hid = seedPerson(db, { display_name: 'Hal Hidden', first_name: 'Hal', last_name: 'Hidden', is_hidden: 1 });
  seedIdentity(db, ava, 'phone', '+12125550142');
  const pair = (x: string, y: string, source: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    db.prepare(`INSERT INTO do_not_merge (a_id, b_id, reason, source, created_at) VALUES (?, ?, 'x', ?, ?)`).run(a, b, source, T0);
  };
  pair(ava, ava2, 'undo');
  pair(ava, hid, 'user');
  const app = createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
  return { db, app, me, ava, ava2, hid };
}

describe('Settings → Privacy and Data', () => {
  it('lists do-not-merge pairs (hidden people unnamed) and allows merging again (journaled, undoable)', async () => {
    const { db, app, ava, ava2, hid } = world();
    const list = DoNotMergeList.parse((await request(app).get('/api/v1/settings/do-not-merge')).body);
    expect(list.pairs).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain('Hal');
    expect(list.pairs.find((p) => p.a.id === hid || p.b.id === hid)!).toMatchObject({ source: 'user' });
    const del = await request(app).delete(`/api/v1/settings/do-not-merge/${ava2}/${ava}`).set('X-YB', '1').set('Content-Type', 'application/json').send({});
    expect(del.status).toBe(200);
    expect(del.body.batchId).toBeTruthy();
    expect(db.prepare('SELECT count(*) FROM do_not_merge').pluck().get()).toBe(1);
    undoBatch(db, del.body.batchId as string, { actor: 'user' });
    expect(db.prepare('SELECT count(*) FROM do_not_merge').pluck().get()).toBe(2);
    expect((await request(app).delete(`/api/v1/settings/do-not-merge/${ava}/${ava}`).set('X-YB', '1').set('Content-Type', 'application/json').send({})).status).toBe(404);
  });

  it('My identities: the owner’s own accounts, phones in full, emails masked', async () => {
    const { app, me } = world();
    const r = MyIdentities.parse((await request(app).get('/api/v1/settings/my-identities')).body);
    expect(r.personId).toBe(me);
    expect(r.identities.map((i) => i.kind)).toEqual(['phone', 'email']);
    expect(JSON.stringify(r)).not.toMatch(/owner@example\.com/);
    expect(r.identities.map((i) => [i.value, i.masked])).toEqual([['(202) 555-0123', false], ['o•••@example.com', true]]);
  });

  it('the JSON export is an attachment with people, accounts, facts and notes; merged-away people fold in', async () => {
    const { db, app, ava } = world();
    db.prepare(
      `INSERT INTO notes (id, person_id, content, origin, created_at, updated_at) VALUES ('00000000-0000-7000-8000-0000000000a1', ?, 'Likes early starts', 'user', ?, ?)`,
    ).run(ava, T0, T0);
    const res = await request(app).get('/api/v1/settings/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="yeackbot-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({ format: 'yeackbot-export', version: 1 });
    const a = (res.body.people as { id: string; notes: { content: string }[]; identities: unknown[] }[]).find((p) => p.id === ava)!;
    expect(a.notes.map((n) => n.content)).toEqual(['Likes early starts']);
    expect(a.identities).toHaveLength(1);
  });

  it('GET /settings reports LLM spend and the cache hit rate even without a key', async () => {
    const { app } = world();
    const s = SettingsResponse.parse((await request(app).get('/api/v1/settings')).body);
    expect(s.environment.llmConfigured).toBe(false);
    expect(s.environment.llmSpend).toMatchObject({ todayUsd: 0, monthUsd: 0, requestsToday: 0, cacheHitRate: null });
  });
});
