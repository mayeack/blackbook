/**
 * Person page extensions over a synthetic social world (invented names, 555-01xx phones, example.com emails):
 * ties, facts (+ Wrong → blocked), loops (+ actions), starters (copy-only), connections (+ Wrong), notes CRUD,
 * merges (+ Split → do_not_merge), collections, the pair page. Hidden people answer 404 everywhere.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  BatchRef,
  Connections,
  MergeHistory,
  NoteList,
  NoteWriteResult,
  OpenLoopList,
  PairView,
  PersonCollections,
  PersonFacts,
  Starters,
  TieStats,
  uuidv7,
} from '@yb/shared';
import { createApp } from '../../src/http/app';
import { mergePeople } from '../../src/identity/merge';
import { startRun } from '../../src/journal/runs';
import { undoBatch } from '../../src/journal/undo';
import { refreshEdgeStats, runGraph } from '../../src/pipeline/graph/run';
import { DAY, NOW, socialWorld, type SocialWorld } from '../pipeline/socialWorld';

let w: SocialWorld;
let app: ReturnType<typeof createApp>;
let ann: string, ben: string, cy: string, hid: string;
let group: string;

function link(a: string, b: string, type: string, wRaw: number, at: number, ref: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  w.db.prepare(`INSERT INTO edge_evidence (a_id, b_id, type, directed, ref, at, w_raw, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`).run(x, y, type, ref, at, wRaw, NOW);
}

function fact(personId: string, type: string, value: string, extra: Record<string, unknown> = {}): string {
  const id = uuidv7();
  const row: Record<string, unknown> = {
    id,
    person_id: personId,
    type,
    value,
    value_norm: value.toLowerCase(),
    confidence: 0.9,
    status: 'confirmed',
    recorded_at: NOW - DAY,
    source: 'llm',
    created_at: NOW - DAY,
    updated_at: NOW - DAY,
    ...extra,
  };
  const cols = Object.keys(row);
  w.db.prepare(`INSERT INTO facts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] as never));
  return id;
}

beforeEach(() => {
  w = socialWorld();
  ann = w.person('Ann', 'Arbor');
  ben = w.person('Ben', 'Birch');
  cy = w.person('Cy', 'Cedar');
  hid = w.person('Hal', 'Hidden', { is_hidden: 1 });
  group = w.group('Trail Crew', [ann, ben, cy]);
  link(ann, ben, 'co_attend', 2, NOW - 10 * DAY, 'occ:00000000-0000-7000-8000-000000000001');
  link(ann, cy, 'co_attend', 2, NOW - 20 * DAY, 'occ:00000000-0000-7000-8000-000000000002');
  link(ann, hid, 'co_attend', 2, NOW, 'occ:00000000-0000-7000-8000-000000000003');
  w.db.prepare(`INSERT INTO person_stats (person_id, tie_strength, state, expected_gap_d, silence_d, last_at, computed_at) VALUES (?, 72, 'steady', 9, 3, ?, ?)`).run(ann, NOW - 3 * DAY, NOW);
  w.db.prepare(`INSERT INTO tie_stats_snapshot (person_id, week, tie_strength, units, computed_at) VALUES (?, '2026-10-05', 70, 4, ?), (?, '2026-10-12', 72, 5, ?)`).run(ann, NOW, ann, NOW);
  runGraph(w.db, { now: NOW });
  // co_group is derived by the graph pass; seed it afterwards (as if derived) and re-aggregate
  link(ann, ben, 'co_group', 1, NOW - 3 * DAY, `conv:${group}`);
  link(ben, cy, 'co_group', 1, NOW - 3 * DAY, `conv:${group}`);
  refreshEdgeStats(w.db, NOW);
  app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
});

const get = async (url: string) => {
  const res = await request(app).get(`/api/v1${url}`);
  return res;
};
const send = (method: 'post' | 'patch' | 'delete', url: string, body: object = {}) =>
  request(app)[method](`/api/v1${url}`).set('X-YB', '1').set('Content-Type', 'application/json').send(body);

describe('person extras', () => {
  it('ties: the cadence numbers and the weekly sparkline', async () => {
    const t = TieStats.parse((await get(`/people/${ann}/ties`)).body);
    expect(t).toMatchObject({ personId: ann, state: 'steady', label: 'Steady', tieStrength: 72, expectedGapD: 9, silenceD: 3 });
    expect(t.sparkline.map((s) => s.date)).toEqual(['2026-10-05', '2026-10-12']);
  });

  it('hidden and unknown people answer 404 on every read', async () => {
    for (const path of ['ties', 'facts', 'loops', 'starters', 'connections', 'notes', 'merges', 'collections']) {
      expect((await get(`/people/${hid}/${path}`)).status, path).toBe(404);
      expect((await get(`/people/${uuidv7()}/${path}`)).status, path).toBe(404);
    }
    expect((await get(`/people/${ann}/with/${hid}`)).status).toBe(404);
    expect((await get(`/people/not-an-id/ties`)).status).toBe(400);
  });

  it('facts: current with evidence, history apart; Wrong retracts + blocks, undo restores', async () => {
    const msg = w.msg(w.dm(ann), NOW - 2 * DAY, ann, 'I got really into bouldering, call me at 212-555-0199');
    const climbing = fact(ann, 'interest', 'Bouldering');
    w.db.prepare(`INSERT INTO evidence (subject_type, subject_id, message_id, quote) VALUES ('fact', ?, ?, ?)`).run(climbing, msg, 'got really into bouldering, 212-555-0199');
    fact(ann, 'location_current', 'Lisbon', { status: 'invalidated', valid_to: NOW - DAY });
    fact(ann, 'other', 'something private', { sensitive: 1 });
    fact(ann, 'pet', 'a cat', { status: 'candidate' });
    const f = PersonFacts.parse((await get(`/people/${ann}/facts`)).body);
    expect(f.active.map((x) => x.value).sort()).toEqual(['Bouldering', 'something private']);
    expect(f.history.map((x) => x.value)).toEqual(['Lisbon']);
    const b = f.active.find((x) => x.value === 'Bouldering')!;
    expect(b.evidence[0]).toMatchObject({ kind: 'message', ref: `m:${msg}`, href: `/p/${ann}?m=${msg}` });
    expect(b.evidence[0]!.quote).not.toContain('555-0199');
    expect(f.active.find((x) => x.sensitive)!.evidence.every((e) => e.quote === null)).toBe(true);

    const res = await send('post', `/people/${ann}/facts/${climbing}/wrong`, { note: 'not a thing' });
    const { batchId } = BatchRef.parse(res.body);
    expect(batchId).not.toBeNull();
    expect(w.db.prepare('SELECT status FROM facts WHERE id = ?').pluck().get(climbing)).toBe('rejected');
    expect(w.db.prepare(`SELECT count(*) FROM fact_blocks WHERE person_id = ? AND type = 'interest' AND value_norm = 'bouldering'`).pluck().get(ann)).toBe(1);
    expect(BatchRef.parse((await send('post', `/people/${ann}/facts/${climbing}/wrong`)).body).batchId).toBeNull();
    expect((await send('post', `/people/${ben}/facts/${climbing}/wrong`)).status).toBe(404);
    undoBatch(w.db, batchId!, { actor: 'user' });
    expect(w.db.prepare('SELECT status FROM facts WHERE id = ?').pluck().get(climbing)).toBe('confirmed');
    expect(w.db.prepare('SELECT count(*) FROM fact_blocks').pluck().get()).toBe(0);
  });

  it('loops: a person’s open loops and everyone’s; an action is journaled', async () => {
    const dm = w.dm(ann);
    const m = w.msg(dm, NOW - 30 * 3_600_000, ann, 'free saturday?');
    const debt = uuidv7();
    w.db
      .prepare(
        `INSERT INTO reply_debts (id, conversation_id, person_id, last_inbound_msg, asked_at, reason, urgency, classifier, confidence, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'question', 'normal', 'llm', 0.9, 'open', ?, ?)`,
      )
      .run(debt, dm, ann, m, NOW - 30 * 3_600_000, NOW, NOW);
    const mine = OpenLoopList.parse((await get(`/people/${ann}/loops`)).body);
    expect(mine.replyDebts).toHaveLength(1);
    expect(mine.replyDebts[0]).toMatchObject({ id: debt, title: 'Asked you something', person: { id: ann } });
    const all = OpenLoopList.parse((await get('/loops?limit=10')).body);
    expect(all.replyDebts.map((d) => d.id)).toEqual([debt]);
    expect((await get('/loops?cursor=bad')).status).toBe(400);
    const done = BatchRef.parse((await send('post', `/loops/reply_debt/${debt}`, { action: 'done' })).body);
    expect(done.batchId).not.toBeNull();
    expect(w.db.prepare('SELECT status FROM reply_debts WHERE id = ?').pluck().get(debt)).toBe('replied');
    expect((await send('post', `/loops/reply_debt/${debt}`, { action: 'snooze', until: NOW + DAY })).status).toBe(409);
    expect((await send('post', `/loops/nope/${debt}`, { action: 'done' })).status).toBe(400);
    expect((await send('post', `/loops/commitment/${uuidv7()}`, { action: 'done' })).status).toBe(404);
  });

  it('starters: copy-only drafts from the composer, then templates grounded in facts; never sensitive', async () => {
    fact(ann, 'interest', 'Bouldering');
    fact(ann, 'other', 'something private', { sensitive: 1 });
    w.db
      .prepare(
        `INSERT INTO suggestions (id, kind, person_id, dedupe_key, score, signals, openers, status, created_at, updated_at)
         VALUES (?, 'fading', ?, ?, 1, '{}', ?, 'selected', ?, ?)`,
      )
      .run(uuidv7(), ann, `fading:${ann}`, JSON.stringify(['Ann! Still bouldering on Sundays?']), Date.now(), Date.now());
    const s = Starters.parse((await get(`/people/${ann}/starters`)).body);
    expect(s.neverSent).toBe(true);
    expect(s.starters[0]).toMatchObject({ text: 'Ann! Still bouldering on Sundays?', source: 'llm' });
    expect(s.starters.some((x) => x.source === 'template' && /bouldering/.test(x.text) && x.basis[0]?.kind === 'fact')).toBe(true);
    expect(JSON.stringify(s)).not.toContain('private');
    expect(s.starters.every((x) => x.text.length <= 160)).toBe(true);
  });

  it('connections: edges with evidence chips and the ego graph; Wrong blocks one type (sticky, undoable)', async () => {
    const c = Connections.parse((await get(`/people/${ann}/connections`)).body);
    expect(c.edges.map((e) => e.person.id).sort()).toEqual([ben, cy].sort());
    expect(JSON.stringify(c)).not.toContain(hid);
    const withBen = c.edges.find((e) => e.person.id === ben)!;
    expect(withBen.chips.map((x) => x.type).sort()).toEqual(['co_attend', 'co_group']);
    expect(withBen.chips.find((x) => x.type === 'co_group')!.text).toBe('1 shared group chat · latest “Trail Crew”');
    expect(c.among).toEqual([expect.objectContaining({ strength: expect.any(Number) })]);
    const res = BatchRef.parse((await send('post', `/people/${ann}/connections/${ben}/wrong`, { type: 'co_group' })).body);
    expect(res.batchId).not.toBeNull();
    const after = Connections.parse((await get(`/people/${ann}/connections`)).body).edges.find((e) => e.person.id === ben)!;
    expect(after.chips.map((x) => x.type)).toEqual(['co_attend']);
    expect((await send('post', `/people/${ann}/connections/${ann}/wrong`, {})).status).toBe(400);
    expect((await send('post', `/people/${ann}/connections/${hid}/wrong`, {})).status).toBe(404);
    // "they don't know each other" removes the edge entirely
    BatchRef.parse((await send('post', `/people/${ann}/connections/${cy}/wrong`, {})).body);
    expect(Connections.parse((await get(`/people/${ann}/connections`)).body).edges.map((e) => e.person.id)).toEqual([ben]);
  });

  it('notes: create, edit, delete (tombstone), all journaled', async () => {
    const created = NoteWriteResult.parse((await send('post', `/people/${ann}/notes`, { content: 'Likes early starts' })).body);
    expect(created.note).toMatchObject({ personId: ann, content: 'Likes early starts', origin: 'user' });
    expect(created.batchId).not.toBeNull();
    expect((await send('post', `/people/${ann}/notes`, { content: '   ' })).status).toBe(400);
    const edited = NoteWriteResult.parse((await send('patch', `/notes/${created.note.id}`, { content: 'Likes very early starts' })).body);
    expect(edited.note.content).toBe('Likes very early starts');
    expect(NoteList.parse((await get(`/people/${ann}/notes`)).body).notes).toHaveLength(1);
    expect(BatchRef.parse((await send('delete', `/notes/${created.note.id}`)).body).batchId).not.toBeNull();
    expect(NoteList.parse((await get(`/people/${ann}/notes`)).body).notes).toEqual([]);
    expect((await send('patch', `/notes/${created.note.id}`, { content: 'x' })).status).toBe(404);
  });

  it('merges: history with reasons; Split undoes the merge and remembers do-not-merge', async () => {
    const dup = w.person('Ann', null);
    const runId = startRun(w.db, 'nightly');
    mergePeople(w.db, { survivorId: ann, mergedId: dup, method: 'probabilistic', runId, actor: 'agent', score: 0.99, evidence: { p: 0.99, families: ['name', 'handle'] } });
    const h = MergeHistory.parse((await get(`/people/${ann}/merges`)).body);
    expect(h.merges).toHaveLength(1);
    expect(h.merges[0]).toMatchObject({ merged: { id: dup, displayName: 'Ann' }, method: 'probabilistic', reasons: ['name', 'IG handle'], canSplit: true, undoneAt: null });
    // the merged-away id resolves to the survivor
    expect(TieStats.parse((await get(`/people/${dup}/ties`)).body).personId).toBe(ann);
    const split = BatchRef.parse((await send('post', `/people/${ann}/merges/${h.merges[0]!.id}/split`)).body);
    expect(split.batchId).not.toBeNull();
    const [a, b] = ann < dup ? [ann, dup] : [dup, ann];
    expect(w.db.prepare('SELECT count(*) FROM do_not_merge WHERE a_id = ? AND b_id = ?').pluck().get(a, b)).toBe(1);
    const again = MergeHistory.parse((await get(`/people/${ann}/merges`)).body).merges[0]!;
    expect(again.canSplit).toBe(false);
    expect(again.undoneAt).not.toBeNull();
    expect((await send('post', `/people/${ann}/merges/${again.id}/split`)).status).toBe(409);
  });

  it('collections: add by name (find or create), remove; journaled; listed with origins', async () => {
    const r = BatchRef.parse(
      (
        await send('post', `/people/${ann}/collections`, {
          add: [
            { type: 'tag', name: 'Climbing' },
            { type: 'location', name: 'Springfield' },
            { type: 'circle', name: 'Trail friends' },
          ],
        })
      ).body,
    );
    expect(r.batchId).not.toBeNull();
    let c = PersonCollections.parse((await get(`/people/${ann}/collections`)).body);
    expect(c.tags.map((t) => t.name)).toEqual(['Climbing']);
    expect(c.locations.map((t) => t.name)).toEqual(['Springfield']);
    expect(c.circles).toEqual([expect.objectContaining({ name: 'Trail friends', kind: 'user', origin: 'user' })]);
    // the same tag name again reuses it
    await send('post', `/people/${ben}/collections`, { add: [{ type: 'tag', name: 'climbing' }] });
    expect(w.db.prepare('SELECT count(*) FROM tags').pluck().get()).toBe(1);
    await send('post', `/people/${ann}/collections`, { remove: [{ type: 'tag', id: c.tags[0]!.id }] });
    c = PersonCollections.parse((await get(`/people/${ann}/collections`)).body);
    expect(c.tags).toEqual([]);
    expect((await send('post', `/people/${ann}/collections`, { add: [{ type: 'tag', id: uuidv7() }] })).status).toBe(404);
    expect((await send('post', `/people/${ann}/collections`, { add: [{ type: 'tag' }] })).status).toBe(400);
  });

  it('pair page: strength, chips, timeline newest first, shared circles', async () => {
    await send('post', `/people/${ann}/collections`, { add: [{ type: 'tag', name: 'Climbing' }, { type: 'tag', name: 'Coffee' }] });
    await send('post', `/people/${ben}/collections`, { add: [{ type: 'tag', name: 'Climbing' }] });
    const p = PairView.parse((await get(`/people/${ann}/with/${ben}`)).body);
    expect(p.a.id).toBe(ann);
    expect(p.b.id).toBe(ben);
    expect(p.strength).toBeGreaterThan(0);
    expect(p.chips.map((c) => c.type).sort()).toEqual(['co_attend', 'co_group']);
    expect(p.timeline.map((t) => t.title)).toEqual(['In the group chat “Trail Crew”', 'At an event together']);
    expect(p.sharedCircles.both.map((c) => c.name)).toEqual(['Climbing']);
    expect(p.sharedCircles.onlyA.map((c) => c.name)).toEqual(['Coffee']);
    expect((await get(`/people/${ann}/with/${ann}`)).status).toBe(400);
    // a pair with no evidence still has a page (strength 0)
    const none = PairView.parse((await get(`/people/${cy}/with/${w.person('Dee', 'Dune')}`)).body);
    expect(none).toMatchObject({ strength: 0, tier: 'faint', chips: [], timeline: [] });
  });
});
