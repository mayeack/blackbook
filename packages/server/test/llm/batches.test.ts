/**
 * Batch orchestration: the policy table (pure) and a full collect pass with a registered consumer, against the
 * real client over the fake API: apply, refusals final on Haiku 5.5 (recorded, skipped, never re-sent) and re-run
 * synchronously WITH fallbacks only on a Sonnet 5.5 override, max_tokens re-queue ×2 then split, invalid output
 * retried once, invalid_request dead-lettered + alert, expired re-queued for the next night.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { batchAction, collectBatches, MAX_TOKENS_CEILING, registerBatchConsumer, retryCustomId, type BatchConsumer, type StoredBatchItem } from '../../src/llm/batches';
import { createLlmClient } from '../../src/llm/client';
import { createEgress } from '../../src/llm/egress';
import { getRequest } from '../../src/llm/ledger';
import { HAIKU_5_5, SONNET_5_5 } from '../../src/llm/models';
import { customId, FALLBACK_BETA, type LlmBatchItem, type LlmBatchResult, type LlmUsage } from '../../src/llm/types';
import { writeSettings } from '../../src/settings/registry';
import { memDb, T0 } from '../helpers';
import { FakeAnthropic, reply, type BatchItemReply } from './fakeAnthropic';

const S = z.object({ facts: z.array(z.string()) });
const usage: LlmUsage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0, batch: true, servedByModel: null, fallbackUsed: false };
const ok = (stopReason: 'end_turn' | 'refusal' | 'max_tokens'): LlmBatchResult => ({ customId: 'x', type: 'succeeded', stopReason, text: '{}', refusalCategory: null, usage });

describe('batchAction (policy table)', () => {
  it('maps every result type', () => {
    const fresh = { attempt: 0, maxTokens: 6000, previous: null };
    expect(batchAction(ok('end_turn'), fresh)).toEqual({ do: 'apply' });
    expect(batchAction(ok('refusal'), fresh)).toEqual({ do: 'refused' });
    expect(batchAction(ok('refusal'), { ...fresh, rerunRefusal: false })).toEqual({ do: 'refused' });
    expect(batchAction(ok('refusal'), { ...fresh, rerunRefusal: true })).toEqual({ do: 'rerun_sync' });
    expect(batchAction(ok('max_tokens'), fresh)).toEqual({ do: 'requeue', maxTokens: 12000, nextNight: false });
    expect(batchAction(ok('max_tokens'), { attempt: 1, maxTokens: 12000, previous: 'max_tokens' })).toEqual({ do: 'split' });
    expect(batchAction(ok('max_tokens'), { attempt: 0, maxTokens: MAX_TOKENS_CEILING, previous: null })).toEqual({ do: 'split' });
    expect(batchAction({ customId: 'x', type: 'errored', errorType: 'invalid_request', message: '' }, fresh)).toEqual({ do: 'dead_letter', alert: true });
    expect(batchAction({ customId: 'x', type: 'errored', errorType: 'other', message: '' }, fresh)).toEqual({ do: 'requeue', maxTokens: 6000, nextNight: false });
    expect(batchAction({ customId: 'x', type: 'errored', errorType: 'other', message: '' }, fresh, true)).toEqual({ do: 'requeue', maxTokens: 6000, nextNight: true });
    expect(batchAction({ customId: 'x', type: 'canceled' }, fresh)).toMatchObject({ do: 'requeue' });
    expect(batchAction({ customId: 'x', type: 'expired' }, fresh)).toEqual({ do: 'requeue', maxTokens: 6000, nextNight: true });
    expect(batchAction({ customId: 'x', type: 'expired' }, { ...fresh, attempt: 3 })).toEqual({ do: 'dead_letter', alert: false });
  });

  it('re-queued ids bump the attempt', () => {
    expect(retryCustomId('xv1-w1-0')).toBe('xv1-w1-1');
    expect(retryCustomId('s_123')).toBeNull();
  });
});

describe('collectBatches', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  function setup(handler: (w: string, attempt: number, maxTokens: number) => BatchItemReply) {
    const api = new FakeAnthropic().onBatchItem((r) => {
      const [, w, a] = r.custom_id.split('-');
      return handler(w!, Number(a), r.params.max_tokens as number);
    });
    const db = memDb();
    writeSettings(db, { tz: 'UTC' }, { actor: 'user', now: T0 });
    let now = T0; // 12:00 UTC: "late" → errors and expiries wait for the next night
    const llm = createLlmClient({ db, apiKey: 'synthetic-test-key', egress: createEgress(db), fetch: api.fetch, now: () => now, maxRetries: 0 });
    const applied: { subject: string; facts: string[]; viaSync: boolean }[] = [];
    const failed: { subject: string; why: string }[] = [];
    const consumer: BatchConsumer<z.infer<typeof S>> = {
      purpose: 'extract',
      schema: () => S,
      validate: (v) => (v.facts.some((f) => f.length > 50) ? ['fact too long'] : []),
      apply: (_db, item, v, meta) => (applied.push({ subject: item.subjectRef, facts: v.facts, viaSync: meta.viaSync }), v.facts.length ? 'applied' : 'rejected'),
      fail: (_db, item, why) => void failed.push({ subject: item.subjectRef, why }),
      split: (item: StoredBatchItem): LlmBatchItem[] =>
        [1, 2].map((part) => ({
          kind: item.kind,
          route: item.route,
          subjectRef: `${item.subjectRef}p${part}`,
          customId: customId('extract', 'v1', `${item.subjectRef}p${part}`, 0),
          promptVersion: item.promptVersion,
          system: item.system,
          messages: item.messages,
          maxTokens: 6000,
          schema: S,
        })),
    };
    unregister = registerBatchConsumer(consumer);
    const item = (w: string): LlmBatchItem => ({
      kind: 'extract',
      route: 'extract_steady',
      subjectRef: w,
      customId: customId('extract', 'v1', w, 0),
      promptVersion: 'v1',
      system: 'stable extraction prompt',
      messages: [{ role: 'user', content: `[m:1|2026-10-12 19:04|P1→ME] hello ${w}` }],
      maxTokens: 6000,
      schema: S,
    });
    return { api, db, llm, applied, failed, item, tick: (ms: number) => (now += ms), at: () => now };
  }

  it('applies, records refusals as final (no re-run on Haiku), re-queues, splits and dead-letters, idempotently', async () => {
    const t = setup((w, attempt, maxTokens) => {
      if (w === 'ok') return { message: reply({ json: { facts: ['climbing'] } }) };
      if (w === 'empty') return { message: reply({ json: { facts: [] } }) };
      if (w === 'refuse') return { message: reply({ stop: 'refusal', category: 'bio' }) };
      if (w === 'long') return attempt === 0 ? { message: reply({ stop: 'max_tokens', text: '{"facts":["a' }) } : { message: reply({ json: { facts: [`ok at ${maxTokens}`] } }) };
      if (w === 'huge') return attempt <= 1 ? { message: reply({ stop: 'max_tokens', text: '{' }) } : { message: reply({ json: { facts: ['never'] } }) };
      if (w.startsWith('hugep')) return { message: reply({ json: { facts: [`part ${w}`] } }) };
      if (w === 'junk') return { message: reply({ text: 'not json' }) };
      if (w === 'bad') return { errored: 'invalid_request_error' };
      if (w === 'late') return { expired: true };
      return { canceled: true };
    });
    t.api.onMessage(() => reply({ json: { facts: ['rescued'] } })); // would answer a sync re-run (there must be none)
    const sub = await t.llm.submitBatch(['ok', 'empty', 'refuse', 'long', 'huge', 'junk', 'bad', 'late'].map(t.item), { purpose: 'extract', runId: 'run-1' });
    expect(sub.status).toBe('submitted');

    const s1 = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(s1).toMatchObject({ batches_ended: 1, results: 8, applied: 1, rejected: 1, refused: 1, rerun_sync: 0, dead_letter: 1 });
    // Haiku 5.5 has no server-side fallback: the refusal is final, recorded, and nothing is re-sent or escalated.
    expect(t.applied.find((a) => a.subject === 'refuse')).toBeUndefined();
    expect(t.failed).toContainEqual({ subject: 'refuse', why: 'refused' });
    expect(getRequest(t.db, customId('extract', 'v1', 'refuse', 0))).toMatchObject({ status: 'refused', model: HAIKU_5_5 });
    expect(getRequest(t.db, customId('extract', 'v1', 'refuse', 1))).toBeUndefined();
    expect(t.api.messageRequests).toHaveLength(0);
    // invalid_request → dead letter + one 'llm' alert
    expect(t.failed).toContainEqual({ subject: 'bad', why: 'dead_letter' });
    expect(t.db.prepare(`SELECT COUNT(*) FROM alerts WHERE source = 'llm' AND resolved_at IS NULL`).pluck().get()).toBe(1);
    // max_tokens → re-queued at ×2 and submitted in the same pass; junk retried once; expired waits for tonight
    expect(getRequest(t.db, customId('extract', 'v1', 'long', 1))).toMatchObject({ max_tokens: 12000, retry_of: customId('extract', 'v1', 'long', 0), status: 'submitted' });
    expect(getRequest(t.db, customId('extract', 'v1', 'junk', 1))).toMatchObject({ status: 'submitted' });
    const late = getRequest(t.db, customId('extract', 'v1', 'late', 1))!;
    expect(late.status).toBe('pending');
    expect(late.not_before! - t.at()).toBe((15 * 60 + 10) * 60_000); // 12:00 → 03:10 UTC
    expect(s1.submitted).toBe(3); // long, huge, junk

    // Second pass: the retry batch ends. long applies at 12000; huge hits max_tokens again → split; junk dead-letters.
    const s2 = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(s2).toMatchObject({ batches_ended: 1, results: 3, applied: 1, split: 1 });
    expect(t.applied.find((a) => a.subject === 'long')?.facts).toEqual(['ok at 12000']);
    expect(t.failed).toContainEqual({ subject: 'junk', why: 'invalid' });
    expect(s2.submitted).toBe(2); // huge p1 + p2

    // Third pass: the split parts apply. Then the expired one goes out once its night comes.
    const s3 = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(s3).toMatchObject({ applied: 2, submitted: 0 });
    t.tick(16 * 3_600_000);
    const s4 = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(s4.submitted).toBe(1);

    // Idempotent: nothing collected twice, nothing applied twice.
    const before = t.applied.length;
    await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    const expiredAgain = t.applied.length - before;
    expect(expiredAgain).toBe(0); // 'late' expires again each time but waits for the next night
    expect(t.applied.filter((a) => a.subject === 'ok')).toHaveLength(1);
  });

  it('a route overridden to Sonnet 5.5: a refused item is re-run once synchronously, WITH fallbacks', async () => {
    const t = setup(() => ({ message: reply({ stop: 'refusal', category: 'cyber', model: SONNET_5_5 }) }));
    writeSettings(t.db, { 'llm.route_overrides': { extract_steady: { model: SONNET_5_5 } } }, { actor: 'user', now: T0 });
    t.api.onMessage(() => reply({ json: { facts: ['rescued'] }, model: SONNET_5_5 }));
    expect((await t.llm.submitBatch([t.item('refuse')], { purpose: 'extract', runId: 'r' })).status).toBe('submitted');
    const s = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(s).toMatchObject({ rerun_sync: 1, applied: 1, refused: 0 });
    expect(t.applied.find((a) => a.subject === 'refuse')).toEqual({ subject: 'refuse', facts: ['rescued'], viaSync: true });
    const rerun = t.api.messageRequests[0]!;
    expect(rerun.body).toMatchObject({ model: SONNET_5_5, fallbacks: 'default', thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
    expect(rerun.headers['anthropic-beta']).toContain(FALLBACK_BETA);
    // The batch itself never carried fallbacks.
    const create = t.api.requests.find((r) => r.path === '/v1/messages/batches')!;
    expect((create.body!.requests as { params: object }[])[0]!.params).not.toHaveProperty('fallbacks');
  });

  it('Sonnet override: declines the fallback can not rescue (bio, general_harms, reasoning_extraction, none) stay final, never re-sent', async () => {
    for (const category of ['bio', 'general_harms', 'reasoning_extraction', null]) {
      const t = setup(() => ({ message: reply({ stop: 'refusal', category, model: SONNET_5_5 }) }));
      writeSettings(t.db, { 'llm.route_overrides': { extract_steady: { model: SONNET_5_5 } } }, { actor: 'user', now: T0 });
      expect((await t.llm.submitBatch([t.item('refuse')], { purpose: 'extract', runId: 'r' })).status).toBe('submitted');
      const s = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
      expect(s, String(category)).toMatchObject({ rerun_sync: 0, refused: 1, applied: 0 });
      expect(getRequest(t.db, customId('extract', 'v1', 'refuse', 0)), String(category)).toMatchObject({ status: 'refused' });
      expect(t.api.messageRequests, String(category)).toHaveLength(0);
      unregister?.();
      unregister = null;
    }
  });

  it('a Sonnet-sent cyber refusal is final once the override is gone (the re-run would go to Haiku, which has no fallback)', async () => {
    const t = setup(() => ({ message: reply({ stop: 'refusal', category: 'cyber', model: SONNET_5_5 }) }));
    writeSettings(t.db, { 'llm.route_overrides': { extract_steady: { model: SONNET_5_5 } } }, { actor: 'user', now: T0 });
    expect((await t.llm.submitBatch([t.item('refuse')], { purpose: 'extract', runId: 'r' })).status).toBe('submitted');
    writeSettings(t.db, { 'llm.route_overrides': {} }, { actor: 'user', now: T0 });
    const s = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(s).toMatchObject({ rerun_sync: 0, refused: 1 });
    expect(t.api.messageRequests).toHaveLength(0);
  });

  it('without a consumer a batch is left to its stage; an orphan is only booked (ledger + costs), nothing re-run', async () => {
    const t = setup(() => ({ message: reply({ stop: 'refusal', category: null }) }));
    unregister?.();
    unregister = null;
    const sub = await t.llm.submitBatch([t.item('a')], { purpose: 'circle_name', runId: 'r' });
    expect(sub.status).toBe('submitted');
    const polls = () => t.api.requests.filter((r) => r.method === 'GET').length;
    expect(await collectBatches({ db: t.db, llm: t.llm, now: t.at })).toMatchObject({ batches_owned: 1, batches_ended: 0 });
    expect(polls()).toBe(0); // no double polling of a batch its stage collects itself
    t.tick(27 * 3_600_000);
    const s = await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(s).toMatchObject({ batches_ended: 1, results: 1, unconsumed: 1, rerun_sync: 0 });
    expect(getRequest(t.db, customId('extract', 'v1', 'a', 0))).toMatchObject({ status: 'refused' });
    expect(t.api.messageRequests).toHaveLength(0);
    expect(getRequest(t.db, customId('extract', 'v1', 'a', 0))!.cost_usd).toBeGreaterThan(0);
  });

  it('a batch its stage already fetched is just marked collected', async () => {
    const t = setup(() => ({ message: reply({ json: { facts: ['x'] } }) }));
    unregister?.();
    unregister = null;
    const sub = await t.llm.submitBatch([t.item('a')], { purpose: 'historical', runId: 'r' });
    if (sub.status !== 'submitted') throw new Error('not submitted');
    await t.llm.batchStatus(sub.batchId);
    for await (const r of t.llm.batchResults(sub.batchId)) void r;
    const before = t.api.requests.length;
    await collectBatches({ db: t.db, llm: t.llm, now: t.at });
    expect(t.api.requests.length).toBe(before);
    expect(t.db.prepare('SELECT collected_at FROM llm_batches WHERE id = ?').pluck().get(sub.batchId)).toBe(t.at());
  });

  it('batches still processing stay open; abort stops early', async () => {
    const t = setup(() => ({ message: reply({ json: { facts: ['x'] } }) }));
    t.api.pendingPolls = 1;
    await t.llm.submitBatch([t.item('a')], { purpose: 'extract', runId: 'r' });
    expect(await collectBatches({ db: t.db, llm: t.llm, now: t.at })).toMatchObject({ batches_open: 1, batches_ended: 0 });
    const ac = new AbortController();
    ac.abort();
    expect(await collectBatches({ db: t.db, llm: t.llm, now: t.at, signal: ac.signal })).toMatchObject({ batches_ended: 0 });
    expect(await collectBatches({ db: t.db, llm: t.llm, now: t.at })).toMatchObject({ batches_ended: 1, applied: 1 });
  });
});
