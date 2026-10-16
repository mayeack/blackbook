/**
 * GET /today and the alerts routes over a synthetic day (invented people, 555-01xx phones): the ranker's picks as
 * template cards, the live delivery state (texting ships off), open loops, "Check these", alerts and the activity
 * summary; serving the cards records one impression per showing. Nothing is ever sent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AlertList, TodayResponse, uuidv7 } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { mergePeople } from '../../src/identity/merge';
import { startRun } from '../../src/journal/runs';
import { generators as defaultGenerators } from '../../src/pipeline/suggestions/generators';
import { runSuggestionsStage } from '../../src/pipeline/suggestions/stage';
import type { DB } from '../../src/db/connection';
import { fadingFriend, friend, HOUR, replyDebt, setSetting, stats, suggestionsDb, type Friend } from '../pipeline/suggestions/world';

let db: DB;
let app: ReturnType<typeof createApp>;
let sam: Friend;
let bram: Friend;

beforeEach(() => {
  db = suggestionsDb();
  setSetting(db, 'learner.enabled', false);
  sam = friend(db, 'Avery', 'Quill');
  stats(db, sam.id, { tie: 60 });
  replyDebt(db, sam, Date.now() - 30 * HOUR);
  bram = fadingFriend(db, 'Bram', 'Ostrow');
  app = createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
});

const post = (url: string, body: object = {}) => request(app).post(url).set('X-YB', '1').set('Content-Type', 'application/json').send(body);
const today = async () => {
  const res = await request(app).get('/api/v1/today');
  expect(res.status).toBe(200);
  return TodayResponse.parse(res.body);
};

describe('GET /today', () => {
  it('before the morning run: no digest, no cards (not "all clear"), loops and the activity summary still there', async () => {
    const t = await today();
    expect(t.digest).toBeNull();
    expect(t.items).toEqual([]);
    expect(t.allClear).toBe(false);
    expect(t.openLoops.counts.replyDebts).toBe(1);
    expect(t.openLoops.preview[0]).toMatchObject({ type: 'reply_debt', person: { id: sam.id } });
    expect(t.activity).toMatchObject({ lastRun: null, line: null });
    expect((await request(app).get('/api/v1/today?date=yesterday')).status).toBe(400);
  });

  it('after ranking: template cards with people chips, the delivery state says texting is off, impressions recorded once', async () => {
    const r = await runSuggestionsStage(db, { now: Date.now(), seed: 5, generators: defaultGenerators, wildcardSources: [] });
    expect(r.selectedIds.length).toBeGreaterThan(0);
    const t = await today();
    expect(t.digest).toMatchObject({ id: r.digestId, status: 'composing', imessage: 'disabled', push: 'disabled', skipReason: 'disabled' });
    expect(t.items.map((i) => i.suggestionId)).toEqual(r.selectedIds);
    const debt = t.items.find((i) => i.kind === 'reply_debt')!;
    expect(debt).toMatchObject({ copy: 'template', people: [{ id: sam.id, firstName: 'Avery' }], target: { type: 'person', href: `/p/${sam.id}` } });
    expect(debt.headline).toMatch(/^Avery Q\./);
    expect(debt.actions).toEqual(expect.arrayContaining(['done', 'snooze', 'skip', 'wrong', 'why']));
    expect(t.allClear).toBe(false);
    const seen = () => db.prepare(`SELECT count(*) FROM feedback WHERE action = 'seen' AND channel = 'web'`).pluck().get() as number;
    expect(seen()).toBe(r.selectedIds.length);
    await today();
    expect(seen()).toBe(r.selectedIds.length);
    // a hidden person's card disappears
    db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(bram.id);
    expect(JSON.stringify(await today())).not.toContain(bram.id);
  });

  it('an empty ranked day is "all clear"', async () => {
    db.prepare(`INSERT INTO digests (id, local_date, status, skip_reason) VALUES (?, ?, 'skipped', 'empty')`).run(uuidv7(), (await today()).date);
    const t = await today();
    expect(t).toMatchObject({ allClear: true, items: [], digest: { status: 'skipped', skipReason: 'empty' } });
  });

  it('Check these: probabilistic merges of the last 7 days (with the evidence families), not undone ones', async () => {
    const runId = startRun(db, 'nightly');
    const dup = friend(db, 'Avery', null);
    mergePeople(db, {
      survivorId: sam.id,
      mergedId: dup.id,
      method: 'probabilistic',
      runId,
      actor: 'agent',
      score: 0.91,
      confidence: 0.91,
      evidence: { p: 0.91, families: ['name', 'graph'], counts: { shared_groups: 2 } },
    });
    const t = await today();
    expect(t.checkThese).toHaveLength(1);
    expect(t.checkThese[0]!.reason).toBe('Merged on name + 2 shared groups (p 0.91)');
    expect(t.checkThese[0]!.batch).toMatchObject({ kind: 'merge', actor: 'agent', undoable: true, subjectPersonId: sam.id });
    expect(t.activity.last24h.merges).toBe(1);
    expect(t.activity.line).toBe('Last night: 1 merge · 0 links · 0 facts');
    expect(t.activity.lastRun).toMatchObject({ id: runId, kind: 'nightly' });
    await post(`/api/v1/activity/${t.checkThese[0]!.batch.id}/undo`, {});
    expect((await today()).checkThese).toEqual([]);
  });
});

describe('alerts', () => {
  it('lists open alerts (masked, with the screen that fixes them), dismiss resolves, Today carries them', async () => {
    const id = uuidv7();
    db.prepare(`INSERT INTO alerts (id, source, severity, message, opened_at) VALUES (?, 'whatsapp', 'critical', 'WhatsApp stopped · call 212-555-0123', ?)`).run(id, Date.now());
    db.prepare(`INSERT INTO alerts (id, source, severity, message, opened_at) VALUES (?, 'llm', 'warning', 'Daily AI budget reached', ?)`).run(uuidv7(), Date.now() - HOUR);
    const list = AlertList.parse((await request(app).get('/api/v1/alerts')).body);
    expect(list.alerts.map((a) => [a.source, a.severity, a.href])).toEqual([
      ['whatsapp', 'critical', '/sources'],
      ['llm', 'warning', '/settings/privacy'],
    ]);
    expect(list.alerts[0]!.message).not.toContain('555-0123');
    expect((await today()).alerts).toHaveLength(2);
    expect((await post(`/api/v1/alerts/${id}/dismiss`)).body).toEqual({ ok: true });
    expect(AlertList.parse((await request(app).get('/api/v1/alerts?status=open')).body).alerts).toHaveLength(1);
    const all = AlertList.parse((await request(app).get('/api/v1/alerts?status=all')).body).alerts;
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.id === id)!.resolvedAt).not.toBeNull();
    expect((await post(`/api/v1/alerts/${uuidv7()}/dismiss`)).status).toBe(404);
    expect((await request(app).get('/api/v1/alerts?status=bogus')).status).toBe(400);
  });
});
