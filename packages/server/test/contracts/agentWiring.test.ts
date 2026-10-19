/**
 * Foundation wiring for the agent loop: routes (every AGENT_ROUTES entry is mounted), jobs (gated on config),
 * the generator registry, the timetable, LLM/delivery contracts and their fakes. Nothing here reaches the
 * network: the fakes never send, the default services are inert, and the suite-wide egress guard is active.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { AGENT_ROUTES, isHHMM, SUGGESTION_KINDS, type PushPayload } from '@yb/shared';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { outboundTextHash } from '../../src/adapters/imessage/mapping';
import { loadConfig } from '../../src/config';
import { checkOutboundText, MAX_OUTBOUND_PER_HOUR } from '../../src/delivery/types';
import { createApp } from '../../src/http/app';
import { createEgress, findRawIdentifiers } from '../../src/llm/egress';
import { unavailableLlmClient } from '../../src/llm/client';
import { costUsd, CUSTOM_ID_LETTER, customId, DEFAULT_MODEL, EgressBlocked, parseCustomId, promptVersion, type LlmBatchItem } from '../../src/llm/types';
import { allGenerators, allWildcardSources } from '../../src/pipeline/suggestions/registry';
import { armKey, KIND_POLICY, REWARDS, suggestionDedupeKey } from '../../src/pipeline/suggestions/types';
import { agentJobDeps, buildJobs } from '../../src/scheduler/jobs/index';
import { AGENT_TIMES } from '../../src/scheduler/timetable';
import { resolveServices, servicesFor } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { memDb, T0 } from '../helpers';

const base = { VITEST: '1', YB_DATA_DIR: '/tmp/yb-agent-wiring-test', DEV_AUTH_BYPASS: '1' };
const ID = '019a0000-0000-7000-8000-00000000000a';

describe('agent-loop routes', () => {
  it('AGENT_ROUTES has no duplicates and every entry is mounted and built (never 501, never "unknown route")', async () => {
    const keys = AGENT_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const app = createApp({ db: memDb(), auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
    for (const spec of AGENT_ROUTES) {
      const url = '/api/v1' + spec.path.replace(/:[A-Za-z]+/g, (p) => (p === ':type' ? 'reply_debt' : ID));
      const m = spec.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
      const req = request(app)[m](url);
      const res = spec.method === 'GET' ? await req : await req.set('X-YB', '1').set('Content-Type', 'application/json').send({});
      expect(res.body?.error?.message, `${spec.method} ${spec.path}`).not.toBe('Unknown API route.');
      expect([200, 400, 403, 404, 409], `${spec.method} ${spec.path} → ${res.status}`).toContain(res.status);
      expect(res.body?.error?.code, `${spec.method} ${spec.path}`).not.toBe('NOT_IMPLEMENTED');
    }
  });
});

describe('agent-loop jobs', () => {
  it('are gated: nothing without a data dir; LLM jobs only with an API key', () => {
    const paths = { backupDir: '/tmp/yb-x/backups', logDir: '/tmp/yb-x/logs' };
    expect(agentJobDeps({ config: paths })).toEqual({ pipeline: null, llm: null, commands: null });
    const plain = agentJobDeps({ config: loadConfig(base) });
    expect(plain.pipeline).not.toBeNull();
    expect(plain.commands).not.toBeNull();
    expect(plain.llm).toBeNull();
    expect(plain.pipeline?.config).toMatchObject({ anthropicApiKey: null, vapid: null });
    const keyed = agentJobDeps({ config: loadConfig({ ...base, ANTHROPIC_API_KEY: 'synthetic-test-key' }) });
    expect(keyed.llm).not.toBeNull();
    // Every registered job name is unique and every schedule is well-formed.
    const jobs = buildJobs({ config: loadConfig({ ...base, ANTHROPIC_API_KEY: 'synthetic-test-key' }) });
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
  });

  it('timetable: valid times, in pipeline order before compose', () => {
    const daily = [AGENT_TIMES.extractSubmit, AGENT_TIMES.llmPurge, AGENT_TIMES.graph, AGENT_TIMES.ties, AGENT_TIMES.obligations, AGENT_TIMES.intel, AGENT_TIMES.suggestions, AGENT_TIMES.compose, AGENT_TIMES.circles.at];
    expect(daily.every(isHHMM)).toBe(true);
    const order = [AGENT_TIMES.graph, AGENT_TIMES.ties, AGENT_TIMES.obligations, AGENT_TIMES.intel, AGENT_TIMES.suggestions, AGENT_TIMES.compose];
    expect([...order].sort()).toEqual(order);
    expect(AGENT_TIMES.extractSubmit > '03:00').toBe(true); // after occasions
    expect(AGENT_TIMES.suggestions > '07:15').toBe(true); // after the LLM apply deadline
    expect(AGENT_TIMES.compose < '08:00').toBe(true); // before the default brief time
  });
});

describe('suggestion contracts', () => {
  it('every kind has a policy; the generator registry is wired (empty until builders fill it)', () => {
    expect(Object.keys(KIND_POLICY).sort()).toEqual([...SUGGESTION_KINDS].sort());
    expect(KIND_POLICY.reply_debt).toMatchObject({ weight: 1, cooldownDays: 2, maxShowings: 3, actWindowMs: 72 * 3_600_000 });
    expect(KIND_POLICY.fading.actWindowMs).toBe(7 * 86_400_000);
    expect(Array.isArray(allGenerators())).toBe(true);
    expect(Array.isArray(allWildcardSources())).toBe(true);
    const kinds = allGenerators().map((g) => g.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(suggestionDedupeKey({ kind: 'fading', subjectKey: ID })).toBe(`fading:${ID}`);
    expect(armKey.bucket('fading', 'close')).toBe('kind:fading|tier:close');
    expect(REWARDS.skip).toEqual({ reward: 0, weight: 1.5, source: 'explicit' });
    expect(REWARDS.wrong.weight).toBe(2);
    expect(REWARDS.open.reward).toBe(0.3);
  });
});

describe('LLM contracts', () => {
  it('custom ids: ≤64 chars of [A-Za-z0-9_-], unique letters, round-trip, attempt in the id', () => {
    const letters = Object.values(CUSTOM_ID_LETTER);
    expect(new Set(letters).size).toBe(letters.length);
    const id = customId('extract', 'a3f9c21b', ID, 0);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(parseCustomId(id)).toEqual({ kind: 'extract', version: 'a3f9c21b', subject: ID.replace(/-/g, ''), attempt: 0 });
    expect(customId('extract', 'a3f9c21b', ID, 1)).not.toBe(id);
    expect(customId('historical', 'v1', 'x'.repeat(200), 3).length).toBeLessThanOrEqual(64);
    expect(() => customId('extract', 'bad-ver', ID, 0)).toThrow();
    expect(() => customId('extract', 'v1', '---', 0)).toThrow();
  });

  it('prompt versions are stable 8-hex digests; costs follow the Haiku 5.5 price table', () => {
    const v = promptVersion('system', '{}', 'low');
    expect(v).toMatch(/^[0-9a-f]{8}$/);
    expect(promptVersion('system', '{}', 'low')).toBe(v);
    expect(promptVersion('system', '{}', 'medium')).not.toBe(v);
    // 3M-token prompt → the >100K rate card ($0.50 in, $0.05 cache read, $2.50 out); batch halves it.
    const t = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0 };
    expect(costUsd(t, 'sync')).toBeCloseTo(0.5 + 2.5 + 0.05);
    expect(costUsd(t, 'batch')).toBeCloseTo((0.5 + 2.5 + 0.05) / 2);
    // A ≤100K prompt: $0.10 in, $0.01 cache read, $0.50 out.
    const small = { inputTokens: 50_000, outputTokens: 10_000, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0 };
    expect(costUsd(small, 'sync')).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01 + 10_000 * 0.5) / 1e6, 12);
  });

  it('the default services are inert: no key → unavailable, no collector → nothing sent, egress fails closed', async () => {
    const db = memDb();
    const s = servicesFor(db);
    expect(servicesFor(db)).toBe(s);
    expect(s.llm.configured).toBe(false);
    expect(s.llm.canSpend()).toEqual({ ok: false, reason: 'no_key' });
    const out = await s.llm.parse({
      kind: 'digest',
      route: 'digest_compose',
      subjectRef: '2026-10-14',
      promptVersion: 'v1',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      schema: z.object({ ok: z.boolean() }),
    });
    expect(out).toEqual({ status: 'unavailable', reason: 'no_key' });
    expect(await s.outbound.sendToSelf(`${BOT_MARKER} hi`, 'test', ID)).toMatchObject({ status: 'disabled' });
    expect(s.push.configured).toBe(false);
    expect(() => s.egress.pseudonymize({ purpose: 'extract', sections: [] })).toThrow(EgressBlocked);
    expect(() => s.egress.scan('call me at +1 212 555 0123')).toThrow(EgressBlocked);
    expect(() => s.egress.scan('mail owner@example.com')).toThrow(EgressBlocked);
    expect(() => s.egress.scan('dm @someone')).toThrow(EgressBlocked);
    expect(() => s.egress.scan('[m:8812|2026-10-12 19:04|P17→ME] brunch at 11?')).not.toThrow();
    expect(createEgress(null).resolveToken('P1')).toBeNull();
    const injected = new FakeLlmClient();
    expect(resolveServices({ db, services: () => ({ ...s, llm: injected }) }).llm).toBe(injected);
    expect(unavailableLlmClient('budget_daily').canSpend()).toEqual({ ok: false, reason: 'budget_daily' });
  });

  it('FakeLlmClient: scripted structured outputs, validation, refusals, budgets, egress', async () => {
    const Out = z.object({ n: z.number() });
    const req = (subjectRef: string, extra: object = {}) => ({
      kind: 'digest' as const,
      route: 'digest_compose' as const,
      subjectRef,
      promptVersion: 'v1',
      system: 'stable',
      messages: [{ role: 'user' as const, content: 'packet' }],
      schema: Out,
      ...extra,
    });
    const llm = new FakeLlmClient({ budget: { steady: 1, backfill: null } })
      .on('digest:ok', { json: { n: 3 } })
      .on('digest:bounds', { json: { n: 300 } })
      .on('digest:refuse', { refusal: 'cyber' })
      .on('digest:junk', { text: 'not json' });
    expect(await llm.parse(req('ok'))).toMatchObject({ status: 'ok', value: { n: 3 } });
    expect(await llm.parse(req('bounds', { validate: (v: { n: number }) => (v.n > 100 ? ['n too big'] : []) }))).toMatchObject({ status: 'invalid', issues: ['n too big'] });
    expect(await llm.parse(req('refuse'))).toMatchObject({ status: 'refused', category: 'cyber' });
    expect(await llm.parse(req('junk'))).toMatchObject({ status: 'invalid' });
    expect(await llm.parse(req('ok', { messages: [{ role: 'user', content: 'reach me at owner@example.com' }] }))).toEqual({
      status: 'unavailable',
      reason: 'egress_blocked',
    });
    // The route's parameters: Haiku 5.5, effort low, thinking off, no fallbacks.
    expect(llm.calls.every((c) => !c.fallbacks && c.effort === 'low' && c.model === DEFAULT_MODEL && c.thinking === 'disabled')).toBe(true);
    llm.addSpend('steady', 5);
    expect(await llm.parse(req('ok'))).toEqual({ status: 'unavailable', reason: 'budget_daily' });
    expect(await new FakeLlmClient({ configured: false }).parse(req('ok'))).toEqual({ status: 'unavailable', reason: 'no_key' });
  });

  it('FakeLlmClient batches: no fallbacks, results in any order keyed by custom_id, refusal surfaced as stop reason', async () => {
    const llm = new FakeLlmClient().on('extract:w1', { json: { facts: [] } }).on('extract:w2', { refusal: null }).on('extract:w3', { expired: true });
    const items: LlmBatchItem[] = ['w1', 'w2', 'w3'].map((w) => ({
      kind: 'extract',
      route: 'extract_steady',
      subjectRef: w,
      customId: customId('extract', 'v1', w, 0),
      promptVersion: 'v1',
      system: 'stable',
      messages: [{ role: 'user', content: `[m:1|2026-10-12 19:04|P1→ME] hello ${w}` }],
      schema: z.object({ facts: z.array(z.string()) }),
    }));
    const sub = await llm.submitBatch(items, { purpose: 'extract', runId: 'run' });
    expect(sub).toMatchObject({ status: 'submitted', count: 3 });
    if (sub.status !== 'submitted') return;
    expect((await llm.batchStatus(sub.batchId)).processing).toBe('ended');
    const results = new Map<string, unknown>();
    for await (const r of llm.batchResults(sub.batchId)) results.set(r.customId, r);
    expect(results.get(items[0]!.customId)).toMatchObject({ type: 'succeeded', stopReason: 'end_turn', text: '{"facts":[]}' });
    expect(results.get(items[1]!.customId)).toMatchObject({ type: 'succeeded', stopReason: 'refusal', text: null });
    expect(results.get(items[2]!.customId)).toEqual({ customId: items[2]!.customId, type: 'expired' });
    expect(llm.calls.filter((c) => c.method === 'batch').every((c) => !c.fallbacks)).toBe(true);
  });

  it('FakeLlmClient tool loop: runs scripted tools through executeTool, streams the answer', async () => {
    const llm = new FakeLlmClient().on('ask', { toolCalls: [{ name: 'search_people', input: { query: 'Springfield' } }], then: { text: 'Avery [P1] lives there.' } });
    const ran: string[] = [];
    const deltas: string[] = [];
    const out = await llm.runTools({
      kind: 'ask',
      route: 'ask_web',
      subjectRef: 'turn-1',
      promptVersion: 'v1',
      system: 'stable',
      messages: [{ role: 'user', content: 'who do I know in Springfield?' }],
      tools: [{ name: 'search_people', description: 'Search people', inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] } }],
      maxToolCalls: 8,
      executeTool: async (c) => (ran.push(c.name), { content: '[]', citableIds: ['P1'] }),
      onTextDelta: (t) => deltas.push(t),
    });
    expect(out).toMatchObject({ status: 'ok', text: 'Avery [P1] lives there.', toolCalls: 1, citableIds: ['P1'] });
    expect(ran).toEqual(['search_people']);
    expect(deltas.join('')).toBe('Avery [P1] lives there.');
  });

  it('FakeEgress scrubs identifiers and passes its own scan', () => {
    const e = new FakeEgress();
    const p = e.pseudonymize({
      purpose: 'extract',
      people: [{ personId: ID, firstName: 'Avery', lastName: 'Quill' }],
      sections: [{ name: 'window', text: 'Avery Quill said call +1 (212) 555-0123 or mail avery@example.com, dm @averyq' }],
    });
    expect(p.text).not.toMatch(/555|example\.com|@averyq|Quill/);
    expect(p.text).toContain('Avery Q.');
    expect(() => e.scan(p.text)).not.toThrow();
    expect(e.tokenFor(ID)).toBe('P1');
    expect(e.resolveToken('P1')).toEqual({ kind: 'person', id: ID });
    expect(findRawIdentifiers(p.text)).toEqual([]);
  });
});

describe('delivery contracts', () => {
  it('outbound text rules: marker on the raw text, yeackbot.com links only, no identifiers', () => {
    expect(checkOutboundText(`${BOT_MARKER} Tue Oct 14 · 2 for today\nyeackbot.com/today`)).toEqual([]);
    expect(checkOutboundText(` ${BOT_MARKER} leading space`)).toContain('no_marker');
    expect(checkOutboundText('done 2')).toContain('no_marker');
    expect(checkOutboundText(`${BOT_MARKER} see https://phish.example.net/x`)).toContain('url_not_allowed');
    expect(checkOutboundText(`${BOT_MARKER} https://yeackbot.com/p/7kq2`)).toEqual([]);
    expect(checkOutboundText(`${BOT_MARKER} text 212-555-0123`)).toContain('contains_identifier');
    expect(checkOutboundText(`${BOT_MARKER} mail owner@example.com`)).toContain('contains_identifier');
  });

  it('FakeOutboundSender records sends like the real one (hash, guid, idempotent client_ref) and refuses rule breaks', async () => {
    const db = memDb();
    const out = new FakeOutboundSender({ db, now: () => T0 });
    const text = `${BOT_MARKER} hello`;
    const r = await out.sendToSelf(text, 'test', ID);
    expect(r).toMatchObject({ status: 'delivered', guids: ['FAKE-GUID-1'] });
    expect(db.prepare('SELECT purpose, text_hash, status FROM outbound_messages WHERE id = ?').get(r.outboundId)).toEqual({
      purpose: 'test',
      text_hash: outboundTextHash(text),
      status: 'delivered',
    });
    expect(db.prepare('SELECT outbound_id FROM outbound_guids WHERE guid = ?').pluck().get('FAKE-GUID-1')).toBe(r.outboundId);
    expect(await out.sendToSelf(text, 'test', ID)).toMatchObject({ status: 'duplicate', outboundId: r.outboundId });
    expect(await out.sendToSelf('no marker', 'reply', '019a0000-0000-7000-8000-0000000000ff')).toMatchObject({ status: 'blocked', reason: 'no_marker' });
    for (let i = 1; i < MAX_OUTBOUND_PER_HOUR; i++) await out.sendToSelf(`${BOT_MARKER} ${i}`, 'reply', `019a0000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(await out.sendToSelf(`${BOT_MARKER} one too many`, 'reply', '019a0000-0000-7000-8000-0000000000fe')).toMatchObject({ status: 'blocked', reason: 'circuit_open' });
    expect(out.sent).toHaveLength(MAX_OUTBOUND_PER_HOUR);
  });

  it('FakePushSender records payloads; 410 means gone', async () => {
    const push = new FakePushSender().fail('https://push.example.com/dead', 410);
    const payload: PushPayload = { kind: 'test', title: 'Yeackbot', body: 'Test push', url: '/today' };
    expect(await push.send({ id: '1', endpoint: 'https://push.example.com/live', p256dh: 'k', auth: 'a' }, payload)).toEqual({ ok: true, statusCode: 201 });
    expect(await push.send({ id: '2', endpoint: 'https://push.example.com/dead', p256dh: 'k', auth: 'a' }, payload)).toMatchObject({ ok: false, gone: true });
    expect(push.sent).toHaveLength(1);
  });
});
