import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { LearnerState, SUGGESTION_KINDS, SuggestionFeedbackResult, SuggestionList, WhyThis } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { generators as defaultGenerators } from '../../src/pipeline/suggestions/generators';
import { recordIgnore } from '../../src/pipeline/suggestions/learner';
import { runSuggestionsStage } from '../../src/pipeline/suggestions/stage';
import type { DB } from '../../src/db/connection';
import { DAY, fadingFriend, friend, HOUR, replyDebt, setSetting, stats, suggestionRow, suggestionsDb, type Friend } from '../pipeline/suggestions/world';

let db: DB;
let app: ReturnType<typeof createApp>;
let ids: string[];
let fading: Friend;
let sam: Friend;

beforeEach(async () => {
  db = suggestionsDb();
  setSetting(db, 'learner.enabled', false);
  sam = friend(db, 'Avery', 'Quill');
  stats(db, sam.id, { tie: 60 });
  replyDebt(db, sam, Date.now() - 30 * HOUR);
  fading = fadingFriend(db, 'Bram', 'Ostrow');
  const r = await runSuggestionsStage(db, { now: Date.now(), seed: 11, generators: defaultGenerators, wildcardSources: [] });
  ids = r.selectedIds;
  app = createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
});

const post = (url: string, body: object = {}) => request(app).post(url).set('X-YB', '1').set('Content-Type', 'application/json').send(body);
const idOf = (kind: string) => ids.find((id) => suggestionRow(db, id).kind === kind)!;

describe('suggestions routes', () => {
  it('GET /suggestions lists history with visible people chips and template headlines; filters and paginates', async () => {
    const res = await request(app).get('/api/v1/suggestions?limit=1');
    expect(res.status).toBe(200);
    const page = SuggestionList.parse(res.body);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const rest = SuggestionList.parse((await request(app).get(`/api/v1/suggestions?limit=10&cursor=${encodeURIComponent(page.nextCursor!)}`)).body);
    expect(rest.items.map((i) => i.id)).not.toContain(page.items[0]!.id);
    const all = SuggestionList.parse((await request(app).get('/api/v1/suggestions?status=open&kind=fading')).body);
    expect(all.items).toHaveLength(1);
    expect(all.items[0]).toMatchObject({ kind: 'fading', headline: 'Bram O. · quiet 60d (usually ~10d)', people: [{ id: fading.id, firstName: 'Bram' }] });
    expect((await request(app).get('/api/v1/suggestions?limit=0')).status).toBe(400);
    // hidden people's items disappear everywhere
    db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(fading.id);
    const after = SuggestionList.parse((await request(app).get('/api/v1/suggestions')).body);
    expect(JSON.stringify(after)).not.toContain(fading.id);
    expect((await request(app).get(`/api/v1/suggestions/${idOf('fading')}/why`)).status).toBe(404);
  });

  it('POST feedback: CSRF-guarded, validated, applies and answers the batch', async () => {
    const id = idOf('reply_debt');
    expect((await request(app).post(`/api/v1/suggestions/${id}/feedback`).set('Content-Type', 'application/json').send({ action: 'done' })).status).toBe(403);
    expect((await post(`/api/v1/suggestions/${id}/feedback`, { action: 'nope' })).status).toBe(400);
    expect((await post('/api/v1/suggestions/not-a-uuid/feedback', { action: 'done' })).status).toBe(400);
    expect((await post('/api/v1/suggestions/019a0000-0000-7000-8000-0000000000ff/feedback', { action: 'done' })).status).toBe(404);
    const res = await post(`/api/v1/suggestions/${id}/feedback`, { action: 'done' });
    expect(res.status).toBe(200);
    const out = SuggestionFeedbackResult.parse(res.body);
    expect(out).toMatchObject({ suggestionId: id, status: 'done' });
    expect(out.batchId).not.toBeNull();
    const drafts = SuggestionFeedbackResult.parse((await post(`/api/v1/suggestions/${idOf('fading')}/feedback`, { action: 'draft' })).body);
    expect(drafts.openers).toHaveLength(2);
    const snooze = await post(`/api/v1/suggestions/${idOf('fading')}/feedback`, { action: 'snooze', until: Date.now() + 7 * DAY });
    expect(SuggestionFeedbackResult.parse(snooze.body).status).toBe('snoozed');
  });

  it('GET why: factors, signals, evidence', async () => {
    const res = await request(app).get(`/api/v1/suggestions/${idOf('fading')}/why`);
    expect(res.status).toBe(200);
    const why = WhyThis.parse(res.body);
    expect(why.kind).toBe('fading');
    expect(why.factors[0]).toMatchObject({ arm: 'kind', value: 1 });
    expect(why.adjustments).toEqual(expect.arrayContaining([{ label: 'Learning', value: 'off' }]));
  });
});

describe('learner routes', () => {
  it('GET /learner: per-kind propensities, wildcard stats, muted and cooled people, adaptive cap', async () => {
    await post(`/api/v1/suggestions/${idOf('reply_debt')}/feedback`, { action: 'done' });
    await post(`/api/v1/suggestions/${idOf('fading')}/feedback`, { action: 'mute', scope: 'person_kind' });
    recordIgnore(db, sam.id, Date.now(), 7);
    const hidden = friend(db, 'Hollis', 'Vane', { is_hidden: 1 });
    recordIgnore(db, hidden.id, Date.now(), 7);
    const res = await request(app).get('/api/v1/learner');
    expect(res.status).toBe(200);
    const s = LearnerState.parse(res.body);
    const debt = s.kinds.find((k) => k.kind === 'reply_debt')!;
    expect(debt).toMatchObject({ alpha: 3, beta: 2, propensity: 0.6, shown30d: 1, acted30d: 1, trend: 'flat', muted: false });
    expect(s.kinds.map((k) => k.kind)).toEqual([...SUGGESTION_KINDS]);
    expect(s.wildcard).toMatchObject({ epsilon: 0.2, shown: 0, hitRate: null });
    expect(s.mutedPeople).toEqual([{ person: expect.objectContaining({ id: fading.id }), kinds: ['fading'], since: expect.any(Number) }]);
    expect(s.cooledPeople.map((c) => c.person.id)).toEqual([sam.id]);
    expect(s.adaptiveCap).toEqual({ current: 4, lateActRate: null });
    expect(JSON.stringify(s)).not.toContain(hidden.id);
  });

  it('POST /learner/reset and /learner/unmute', async () => {
    await post(`/api/v1/suggestions/${idOf('reply_debt')}/feedback`, { action: 'done' });
    expect((await post('/api/v1/learner/reset', { scope: 'nope' })).status).toBe(400);
    expect((await post('/api/v1/learner/reset', { scope: 'person', personId: '019a0000-0000-7000-8000-0000000000ff' })).status).toBe(404);
    const r = await post('/api/v1/learner/reset', { scope: 'kind', kind: 'reply_debt' });
    expect(r.status).toBe(200);
    expect(r.body.reset).toBeGreaterThanOrEqual(1);
    const s = LearnerState.parse((await request(app).get('/api/v1/learner')).body);
    expect(s.kinds.find((k) => k.kind === 'reply_debt')).toMatchObject({ alpha: 2, beta: 2 });

    await post(`/api/v1/suggestions/${idOf('fading')}/feedback`, { action: 'mute', scope: 'kind' });
    expect(LearnerState.parse((await request(app).get('/api/v1/learner')).body).kinds.find((k) => k.kind === 'fading')!.muted).toBe(true);
    expect((await post('/api/v1/learner/unmute', { kind: 'fading' })).body).toEqual({ ok: true });
    expect(LearnerState.parse((await request(app).get('/api/v1/learner')).body).kinds.find((k) => k.kind === 'fading')!.muted).toBe(false);
    expect((await post('/api/v1/learner/unmute', { personId: fading.id })).body).toEqual({ ok: true });
    expect((await post('/api/v1/learner/unmute', { personId: 'bad' })).status).toBe(400);
  });
});

