import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CollectionDetail, CollectionList, CollectionWriteResult, NetworkGraph } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { undoBatch } from '../../src/journal/undo';
import { runCircles } from '../../src/pipeline/circles/run';
import { runGraph } from '../../src/pipeline/graph/run';
import { DAY, NOW, socialWorld, type SocialWorld } from '../pipeline/socialWorld';

let w: SocialWorld;
let app: ReturnType<typeof createApp>;
let ann: string, ben: string, cy: string, dee: string, hid: string;

function link(a: string, b: string, type: string, wRaw: number, at: number, ref = `event:${type}`) {
  const [x, y] = a < b ? [a, b] : [b, a];
  w.db
    .prepare(`INSERT INTO edge_evidence (a_id, b_id, type, directed, ref, at, w_raw, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`)
    .run(x, y, type, ref, at, wRaw, NOW);
}

beforeEach(() => {
  w = socialWorld();
  ann = w.person('Ann', 'Arbor');
  ben = w.person('Ben', 'Birch');
  cy = w.person('Cy', 'Cedar');
  dee = w.person('Dee', 'Dune');
  hid = w.person('Hal', 'Hidden', { is_hidden: 1 });
  link(ann, ben, 'co_attend', 2, NOW - 10 * DAY);
  link(ann, cy, 'co_attend', 2, NOW - 400 * DAY);
  link(ben, cy, 'co_attend', 2, NOW - 5 * DAY);
  link(cy, dee, 'invited_by', 0.3, NOW - 5 * DAY, 'm:1');
  link(ann, hid, 'co_attend', 2, NOW);
  w.db.prepare(`INSERT INTO person_stats (person_id, tie_strength, state, computed_at) VALUES (?, 80, 'strong', ?), (?, 30, 'steady', ?)`).run(ann, NOW, ben, NOW);
  runGraph(w.db, { now: NOW });
  app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
});

/** Ann, Ben and Cy were at a second gathering together: repeated co-attendance makes them an auto circle. */
function againTogether() {
  for (const [a, b, at] of [
    [ann, ben, NOW - 10 * DAY],
    [ann, cy, NOW - 400 * DAY],
    [ben, cy, NOW - 5 * DAY],
  ] as const)
    link(a, b, 'co_attend', 2, at, 'event:again');
}

const send = (method: 'post' | 'patch' | 'delete', url: string, body: object = {}) =>
  request(app)[method](url).set('X-YB', '1').set('Content-Type', 'application/json').send(body);

describe('GET /network', () => {
  it('visible people and their edges; the owner and hidden people never show by default', async () => {
    const res = await request(app).get('/api/v1/network?window=all');
    expect(res.status).toBe(200);
    const g = NetworkGraph.parse(res.body);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([ann, ben, cy].sort());
    expect(ids).not.toContain(hid);
    expect(ids).not.toContain(w.me);
    expect(g.edges).toHaveLength(3);
    expect(g.edgeTypes).toEqual(['co_attend', 'invited_by']);
    expect(g.nodes.find((n) => n.id === ann)).toMatchObject({ tieStrength: 80, state: 'strong', degree: 2, isMe: false });
    expect(g.truncated).toBe(false);
    expect(JSON.stringify(g)).not.toContain('Hidden');
  });

  it('filters by window, type and strength; includeMe links the owner by tie strength', async () => {
    const year = NetworkGraph.parse((await request(app).get('/api/v1/network')).body);
    expect(year.edges.map((e) => [e.a, e.b].sort().join()).sort()).toEqual([[ann, ben].sort().join(), [ben, cy].sort().join()].sort());

    const mentions = NetworkGraph.parse((await request(app).get('/api/v1/network?types=invited_by&minStrength=0.1&window=all')).body);
    expect(mentions.edges).toHaveLength(1);
    expect(mentions.edges[0]).toMatchObject({ types: ['invited_by'], dominantType: 'invited_by', tier: 'faint' });
    expect(mentions.nodes.map((n) => n.id).sort()).toEqual([cy, dee].sort());

    const strong = NetworkGraph.parse((await request(app).get('/api/v1/network?minStrength=0.9&window=all')).body);
    expect(strong.edges).toEqual([]);

    const me = NetworkGraph.parse((await request(app).get('/api/v1/network?includeMe=1&window=all')).body);
    const meNode = me.nodes.find((n) => n.isMe)!;
    expect(meNode.id).toBe(w.me);
    expect(me.edges.filter((e) => e.a === w.me).map((e) => [e.b, e.strength])).toEqual(
      expect.arrayContaining([
        [ann, 0.8],
        [ben, 0.3],
      ]),
    );
    expect(me.edgeTypes).toContain('tie');

    const limited = NetworkGraph.parse((await request(app).get('/api/v1/network?window=all&limit=10')).body);
    expect(limited.truncated).toBe(false);
    expect((await request(app).get('/api/v1/network?minStrength=2')).status).toBe(400);
  });

  it('circle filter and node colors', async () => {
    againTogether();
    await runCircles(w.db, { now: NOW });
    const list = CollectionList.parse((await request(app).get('/api/v1/circles?kind=auto')).body);
    expect(list.items).toHaveLength(1);
    const circle = list.items[0]!;
    const g = NetworkGraph.parse((await request(app).get(`/api/v1/network?circle=${circle.id}&window=all`)).body);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([ann, ben, cy].sort());
    expect(g.nodes.every((n) => n.primaryCircleId === circle.id && n.circleIds.includes(circle.id))).toBe(true);
    expect(g.circles).toEqual([{ id: circle.id, name: circle.name, kind: 'auto', color: circle.color, icon: null, size: 3 }]);
    expect((await request(app).get('/api/v1/network?circle=nope')).status).toBe(404);
  });
});

describe('circles / tags / locations', () => {
  it('create, list, detail, edit members, rename, delete — journaled and undoable', async () => {
    const created = await send('post', '/api/v1/circles', { name: 'Supper club', memberIds: [ben, ann], color: '#123abc' });
    expect(created.status).toBe(200);
    const { collection, batchId } = CollectionWriteResult.parse(created.body);
    expect(collection).toMatchObject({ type: 'circle', kind: 'user', name: 'Supper club', memberCount: 2, color: '#123abc', locked: false });
    expect(batchId).toBeTruthy();

    const detail = CollectionDetail.parse((await request(app).get(`/api/v1/circles/${collection.id}`)).body);
    expect(detail.members.map((m) => m.person.id)).toEqual([ann, ben]); // last name A–Z
    expect(detail.members[0]).toMatchObject({ origin: 'user', person: { displayName: 'Ann Arbor', firstName: 'Ann', state: 'strong' } });

    expect((await send('post', `/api/v1/circles/${collection.id}/members`, { add: [hid] })).status).toBe(400); // hidden people can't be added
    const edit = await send('post', `/api/v1/circles/${collection.id}/members`, { add: [cy], remove: [ann] });
    expect(edit.status).toBe(200);
    let d = CollectionDetail.parse((await request(app).get(`/api/v1/circles/${collection.id}`)).body);
    expect(d.members.map((m) => m.person.id)).toEqual([ben, cy]);
    undoBatch(w.db, edit.body.batchId, { now: NOW });
    d = CollectionDetail.parse((await request(app).get(`/api/v1/circles/${collection.id}`)).body);
    expect(d.members.map((m) => m.person.id)).toEqual([ann, ben]);

    expect((await send('patch', `/api/v1/circles/${collection.id}`, { name: 'Dinner club', description: 'Monthly' })).body.batchId).toBeTruthy();
    expect((await send('patch', `/api/v1/circles/${collection.id}`, { name: 'Dinner club' })).body).toEqual({ batchId: null });
    const list = CollectionList.parse((await request(app).get('/api/v1/circles?kind=user')).body);
    expect(list.items.map((c) => [c.name, c.description])).toEqual([['Dinner club', 'Monthly']]);

    const del = await send('delete', `/api/v1/circles/${collection.id}`);
    expect(del.status).toBe(200);
    expect((await request(app).get(`/api/v1/circles/${collection.id}`)).status).toBe(404);
    expect(CollectionList.parse((await request(app).get('/api/v1/circles')).body).items).toEqual([]);
    undoBatch(w.db, del.body.batchId, { now: NOW });
    expect((await request(app).get(`/api/v1/circles/${collection.id}`)).status).toBe(200);

    const feed = w.db.prepare(`SELECT title, actor FROM change_batches WHERE kind = 'circle' ORDER BY seq`).all() as { title: string; actor: string }[];
    expect(feed.every((b) => b.actor === 'user' && !/Ann|Ben|Cy|Supper|Dinner/.test(b.title))).toBe(true);
  });

  it('auto circles: owner removals are sticky across weekly runs; deleting archives', async () => {
    againTogether();
    await runCircles(w.db, { now: NOW });
    const auto = CollectionList.parse((await request(app).get('/api/v1/circles?kind=auto')).body).items[0]!;
    await send('post', `/api/v1/circles/${auto.id}/members`, { remove: [cy] });
    await runCircles(w.db, { now: NOW + 7 * DAY });
    const d = CollectionDetail.parse((await request(app).get(`/api/v1/circles/${auto.id}`)).body);
    expect(d.members.map((m) => m.person.id)).toEqual([ann, ben]);
    expect(d.members.every((m) => m.origin === 'auto' && m.score !== null)).toBe(true);
    expect(d.suggestedAdditions.map((s) => s.person.id)).not.toContain(cy);

    expect((await send('delete', `/api/v1/circles/${auto.id}`)).status).toBe(200);
    expect(w.db.prepare('SELECT status FROM circles WHERE id = ?').pluck().get(auto.id)).toBe('archived');
    const r = await runCircles(w.db, { now: NOW + 14 * DAY });
    expect(r.stats).toMatchObject({ created: 0, leftAlone: 1 });
  });

  it('tags: unique names (409), member counts, facets', async () => {
    const t = CollectionWriteResult.parse((await send('post', '/api/v1/tags', { name: 'Climbing', memberIds: [ann, ben] })).body);
    expect(t.collection).toMatchObject({ type: 'tag', kind: null, memberCount: 2 });
    expect((await send('post', '/api/v1/tags', { name: 'climbing' })).status).toBe(409);
    const c = CollectionWriteResult.parse((await send('post', '/api/v1/circles', { name: 'Gym', memberIds: [ann] })).body);
    const d = CollectionDetail.parse((await request(app).get(`/api/v1/tags/${t.collection.id}`)).body);
    expect(d.facets.circles).toEqual([{ id: c.collection.id, name: 'Gym', count: 1 }]);
    expect(d.facets.tags).toEqual([]);
    await send('post', `/api/v1/tags/${t.collection.id}/members`, { remove: [ben] });
    expect(CollectionList.parse((await request(app).get('/api/v1/tags')).body).items[0]!.memberCount).toBe(1);
    expect((await send('delete', `/api/v1/tags/${t.collection.id}`)).status).toBe(200);
    // a deleted tag's name can be reused (the row is revived)
    const again = CollectionWriteResult.parse((await send('post', '/api/v1/tags', { name: 'Climbing' })).body);
    expect(again.collection.id).toBe(t.collection.id);
  });

  it('locations: people whose location fact matches but who are not members', async () => {
    const loc = CollectionWriteResult.parse((await send('post', '/api/v1/locations', { name: 'Austin', memberIds: [ann] })).body);
    const fact = w.db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, 'location_current', 'Austin, TX', 'austin, tx', 0.9, 'confirmed', ?, 'llm', ?, ?)`,
    );
    fact.run('019a0000-0000-7000-8000-00000000f001', ben, NOW, NOW, NOW);
    fact.run('019a0000-0000-7000-8000-00000000f002', hid, NOW, NOW, NOW);
    fact.run('019a0000-0000-7000-8000-00000000f003', ann, NOW, NOW, NOW);
    const d = CollectionDetail.parse((await request(app).get(`/api/v1/locations/${loc.collection.id}`)).body);
    expect(d.fromFacts.map((p) => p.id)).toEqual([ben]);
    expect(d.collection.kind).toBeNull();
  });

  it('validates input', async () => {
    expect((await send('post', '/api/v1/circles', {})).status).toBe(400);
    expect((await send('post', '/api/v1/circles', { name: 'x', memberIds: ['not-a-uuid'] })).status).toBe(400);
    expect((await request(app).get('/api/v1/circles/not-a-uuid')).status).toBe(400);
    expect((await request(app).get('/api/v1/circles?kind=bogus')).status).toBe(400);
    expect((await send('post', '/api/v1/circles', { name: 'x' }).set('X-YB', '')).status).toBe(403);
  });
});
