/**
 * /api/v1/eval over HTTP (dev auth bypass, synthetic world): lazy sampling on first visit, cursor paging, labels
 * with CSRF + validation, hidden people never listed, and the report's contract shape.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EvalItemPage, EvalReport } from '@yb/shared';
import { createApp } from '../../src/http/app';
import { buildEvalWorld } from './world';

async function app() {
  const w = await buildEvalWorld();
  return { w, app: createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } }) };
}

describe('GET /eval/items', () => {
  it('samples empty sets on first visit, pages by cursor, reports progress', async () => {
    const { w, app: a } = await app();
    const first = await request(a).get('/api/v1/eval/items?limit=3');
    expect(first.status).toBe(200);
    const page = EvalItemPage.parse(first.body);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    const counts = Object.fromEntries(page.counts.map((c) => [c.set, c]));
    expect(counts.extraction).toMatchObject({ total: 4, labeled: 0, target: 200 });
    expect(counts.identity!.total).toBeGreaterThan(0);
    expect(counts.reply_debt!.total).toBeGreaterThanOrEqual(1); // frozen at the real clock: which chats qualify depends on it
    expect(counts.ask!.total).toBe(2);
    const seen = new Set(page.items.map((i) => i.id));
    let cursor = page.nextCursor;
    while (cursor) {
      const next = EvalItemPage.parse((await request(a).get(`/api/v1/eval/items?limit=3&cursor=${cursor}`)).body);
      for (const it of next.items) {
        expect(seen.has(it.id)).toBe(false);
        seen.add(it.id);
      }
      cursor = next.nextCursor;
    }
    const total = page.counts.reduce((n, c) => n + c.total, 0);
    expect(seen.size).toBe(total);
    // The second visit doesn't resample (state recorded per set).
    const again = EvalItemPage.parse((await request(a).get('/api/v1/eval/items?set=extraction&status=all&limit=50')).body);
    expect(again.items).toHaveLength(4);
    expect(w.db.prepare('SELECT count(*) FROM eval_sample_state').pluck().get()).toBe(4);
  });

  it('filters by set and status; rejects a bad query', async () => {
    const { app: a } = await app();
    const r = EvalItemPage.parse((await request(a).get('/api/v1/eval/items?set=reply_debt&limit=10')).body);
    expect(r.items.every((i) => i.set === 'reply_debt')).toBe(true);
    expect((await request(a).get('/api/v1/eval/items?set=nope')).status).toBe(400);
    expect((await request(a).get('/api/v1/eval/items?limit=500')).status).toBe(400);
  });

  it('never lists an item about a person hidden since sampling', async () => {
    const { w, app: a } = await app();
    await request(a).get('/api/v1/eval/items?limit=1');
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.sam);
    const all = EvalItemPage.parse((await request(a).get('/api/v1/eval/items?status=all&limit=50')).body);
    const text = JSON.stringify(all.items);
    expect(text).not.toContain('Sam R');
    expect(text).not.toContain('Lumen');
    expect(all.items.some((i) => i.set === 'reply_debt' && i.predictions.some((p) => p.kind === 'needs_reply'))).toBe(false);
  });
});

describe('POST /eval/labels', () => {
  it('needs the CSRF header, validates, stores, and the labeled filter returns it', async () => {
    const { app: a } = await app();
    const page = EvalItemPage.parse((await request(a).get('/api/v1/eval/items?set=identity&limit=1')).body);
    const item = page.items[0]!;
    const body = { itemId: item.id, verdicts: [{ predictionId: item.predictions[0]!.id, verdict: 'correct' }], missing: [] };
    expect((await request(a).post('/api/v1/eval/labels').send(body)).status).toBe(403);
    const ok = await request(a).post('/api/v1/eval/labels').set('X-YB', '1').send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ itemId: item.id, labeledAt: expect.any(Number) });
    const bad = await request(a).post('/api/v1/eval/labels').set('X-YB', '1').send({ ...body, verdicts: [{ predictionId: 'zzz', verdict: 'correct' }] });
    expect(bad.status).toBe(400);
    expect((await request(a).post('/api/v1/eval/labels').set('X-YB', '1').send({ ...body, itemId: '019a0000-0000-7000-8000-000000000000' })).status).toBe(404);
    expect((await request(a).post('/api/v1/eval/labels').set('X-YB', '1').send({ itemId: item.id, verdicts: [{ predictionId: 'pair', verdict: 'maybe' }] })).status).toBe(400);
    const labeled = EvalItemPage.parse((await request(a).get('/api/v1/eval/items?set=identity&status=labeled')).body);
    expect(labeled.items.map((i) => i.id)).toEqual([item.id]);
    expect(labeled.items[0]!.label).toMatchObject({ verdicts: body.verdicts, missing: [], note: null });
    expect(labeled.counts.find((c) => c.set === 'identity')!.labeled).toBe(1);
  });
});

describe('GET /eval/report', () => {
  it('answers the EvalReport contract (counts and rates only)', async () => {
    const { app: a } = await app();
    await request(a).get('/api/v1/eval/items');
    const res = await request(a).get('/api/v1/eval/report');
    expect(res.status).toBe(200);
    const r = EvalReport.parse(res.body);
    expect(r.sets.map((s) => s.set)).toEqual(['extraction', 'identity', 'reply_debt', 'ask']);
    expect(r.online.map((m) => m.name)).toEqual(['digest_action_rate', 'dismiss_rate', 'wrong_rate', 'agent_undo_rate', 'merge_undo_rate']);
    expect(JSON.stringify(r)).not.toMatch(/Sam|Lumen|Denver|555/);
  });
});
