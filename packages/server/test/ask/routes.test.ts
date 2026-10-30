import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AskConversation, AskConversationList, SseParser, type AskEvent } from '@yb/shared';
import { NEEDS_KEY_MESSAGE } from '../../src/ask';
import { factRef } from '../../src/ask/refs';
import { startTurn } from '../../src/ask/store';
import { createApp } from '../../src/http/app';
import { errorHandler } from '../../src/http/errors';
import { nullLogger } from '../../src/ops/logger';
import { askRoutes } from '../../src/routes/ask';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { buildAskWorld, MIN, NOW } from './world';

function appWith(llm: FakeLlmClient, egress: FakeEgress, db = buildAskWorld().db) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', askRoutes({ db, log: nullLogger, services: () => ({ llm, egress, outbound: new FakeOutboundSender(), push: new FakePushSender() }) }));
  app.use(errorHandler(nullLogger));
  return app;
}

const events = (text: string): AskEvent[] => new SseParser().push(text);

describe('POST /api/v1/ask (SSE)', () => {
  it('streams start → tool_status → delta → citation → done and stores the conversation', async () => {
    const w = buildAskWorld();
    const egress = new FakeEgress();
    const sam = egress.tokenFor(w.sam);
    const f = factRef(w.facts.samAustin);
    const llm = new FakeLlmClient().on('ask', {
      toolCalls: [{ name: 'search_people', input: { query: null, city: 'Austin', near_km: null, circle: null, interest: null, employer: null, min_strength: null, limit: 5 } }],
      then: { text: `${sam} lives in Austin [${f}].` },
    });
    const app = appWith(llm, egress, w.db);
    const res = await request(app).post('/api/v1/ask').set('X-YB', '1').send({ question: 'Who do I know in Austin?' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-store');
    const ev = events(res.text);
    expect(ev.map((e) => e.type)).toEqual(['start', 'tool_status', 'tool_status', 'delta', 'citation', 'delta', 'done']);
    const done = ev.at(-1) as Extract<AskEvent, { type: 'done' }>;
    expect(done).toMatchObject({ answer: `Sam Rivera lives in Austin [${f}].`, degraded: false, people: [{ id: w.sam, displayName: 'Sam Rivera' }] });
    expect(done.citations[0]).toMatchObject({ ref: f, kind: 'fact', href: `/p/${w.sam}` });

    const list = await request(app).get('/api/v1/ask/conversations');
    expect(list.status).toBe(200);
    const parsed = AskConversationList.parse(list.body);
    expect(parsed.conversations).toEqual([expect.objectContaining({ id: done.conversationId, title: 'Who do I know in Austin?', turnCount: 1 })]);
    expect(parsed.suggestedPrompts).toHaveLength(5);
    expect(parsed.suggestedPrompts[0]).toBe('Who do I know in Austin?');

    const conv = await request(app).get(`/api/v1/ask/conversations/${done.conversationId}`);
    expect(AskConversation.parse(conv.body).turns[0]).toMatchObject({ id: done.turnId, status: 'done', answer: done.answer });

    // A follow-up in the same conversation.
    llm.on('ask', { text: `Still ${sam} [${f}].` });
    const again = await request(app).post('/api/v1/ask').set('X-YB', '1').send({ question: 'And now?', conversationId: done.conversationId });
    expect((events(again.text).at(-1) as Extract<AskEvent, { type: 'done' }>).conversationId).toBe(done.conversationId);
  });

  it('stored answers are re-checked on read: someone hidden later drops out of chips, citations and text', async () => {
    const w = buildAskWorld();
    const egress = new FakeEgress();
    const jess = egress.tokenFor(w.jess);
    const f = factRef(w.facts.jessAustin);
    const llm = new FakeLlmClient().on('ask', {
      toolCalls: [{ name: 'search_people', input: { query: null, city: 'Austin', near_km: null, circle: null, interest: null, employer: null, min_strength: null, limit: 5 } }],
      then: { text: `${jess} lives in East Austin [${f}].` },
    });
    const app = appWith(llm, egress, w.db);
    const done = events((await request(app).post('/api/v1/ask').set('X-YB', '1').send({ question: 'Who lives in Austin?' })).text).at(-1) as Extract<AskEvent, { type: 'done' }>;
    expect(done.answer).toContain('Jess Kim');
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.jess);
    const turn = AskConversation.parse((await request(app).get(`/api/v1/ask/conversations/${done.conversationId}`)).body).turns[0]!;
    expect(turn.people).toEqual([]);
    expect(turn.citations).toEqual([]);
    expect(turn.answer).not.toContain('Jess');
  });

  it('pages the conversation list newest first with a cursor: every conversation once, ties broken by id', async () => {
    const w = buildAskWorld();
    const app = appWith(new FakeLlmClient(), new FakeEgress(), w.db);
    // Seven conversations; two share an updated_at (and straddle the first page break) so the cursor has to break the tie.
    const minutes = [1, 2, 3, 4, 4, 5, 6];
    const ids = minutes.map((m, i) => startTurn(w.db, { question: `Question ${i + 1}`, channel: 'web', now: NOW + m * MIN }).conversationId);
    const newestFirst = ids
      .map((id, i) => ({ id, m: minutes[i]! }))
      .sort((a, b) => b.m - a.m || (a.id < b.id ? 1 : -1))
      .map((x) => x.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await request(app).get(`/api/v1/ask/conversations?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      const body = AskConversationList.parse(res.body);
      expect(body.conversations.length).toBeLessThanOrEqual(3);
      expect(body.suggestedPrompts.length).toBeGreaterThan(0);
      seen.push(...body.conversations.map((c) => c.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(newestFirst);
    expect(new Set(seen).size).toBe(7);

    // A full last page says there is no next one.
    const exact = AskConversationList.parse((await request(app).get('/api/v1/ask/conversations?limit=7')).body);
    expect(exact.conversations).toHaveLength(7);
    expect(exact.nextCursor).toBeNull();
    expect((await request(app).get('/api/v1/ask/conversations?cursor=nope')).status).toBe(400);
  });

  it('validates before streaming: bad body → 400 JSON, unknown conversation → 404', async () => {
    const app = appWith(new FakeLlmClient(), new FakeEgress());
    const bad = await request(app).post('/api/v1/ask').send({ question: '   ' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
    const missing = await request(app).post('/api/v1/ask').send({ question: 'hi', conversationId: '019a0000-0000-7000-8000-0000000000ff' });
    expect(missing.status).toBe(404);
    expect((await request(app).get('/api/v1/ask/conversations/not-a-uuid')).status).toBe(404);
    expect((await request(app).get('/api/v1/ask/conversations/019a0000-0000-7000-8000-0000000000ff')).status).toBe(404);
  });

  it('through the real app with default services (no API key): a degraded answer that says the key is needed', async () => {
    const w = buildAskWorld();
    const app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
    const res = await request(app).post('/api/v1/ask').set('X-YB', '1').set('Content-Type', 'application/json').send({ question: 'Who do I know in Austin?' });
    expect(res.status).toBe(200);
    const done = events(res.text).at(-1) as Extract<AskEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.degraded).toBe(true);
    expect(done.answer.startsWith(NEEDS_KEY_MESSAGE)).toBe(true);
    expect(done.answer).toContain('Sam Rivera');
    expect(done.usage).toBeNull();
  });
});
