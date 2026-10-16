/** llm-collect / llm-purge jobs, the 016 schema and the prompt-caching helpers. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputFormat, schemaJson, systemBlocks, volatileMarkers } from '../../src/llm/caching';
import { createLlmClient } from '../../src/llm/client';
import { createEgress } from '../../src/llm/egress';
import { llmJobs, purgeOldOutputs } from '../../src/llm/jobs';
import { OUTPUT_RETENTION_MS } from '../../src/llm/ledger';
import { LLM_MODEL, promptVersion } from '../../src/llm/types';
import { nullLogger } from '../../src/ops/logger';
import { AGENT_TIMES } from '../../src/scheduler/timetable';
import type { AgentServices } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { memDb, T0 } from '../helpers';
import { FakeAnthropic, reply } from './fakeAnthropic';

const row = (db: ReturnType<typeof memDb>, id: string, createdAt: number) =>
  db
    .prepare(
      `INSERT INTO llm_requests (custom_id, kind, subject_ref, prompt_version, model, input_hash, status, created_at, output, params, cost_usd, spent_date)
       VALUES (?, 'extract', 's', 'v1', ?, 'h', 'applied', ?, '{"facts":[]}', '{"system":"s","cacheTtl":"1h","messages":[],"outputSchema":null}', 0.01, '2026-09-01')`,
    )
    .run(id, LLM_MODEL, createdAt);

describe('llm jobs', () => {
  it('registers llm-collect (every 5 min) and llm-purge (daily)', () => {
    const jobs = llmJobs({});
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([
      ['llm-collect', { kind: 'interval', everyMs: AGENT_TIMES.llmCollectEveryMs }],
      ['llm-purge', { kind: 'daily', at: AGENT_TIMES.llmPurge }],
    ]);
  });

  it('llm-purge clears outputs and stored bodies older than 30 days; costs stay', async () => {
    const db = memDb();
    for (let i = 0; i < 1203; i++) row(db, `xv1-old${i}-0`, T0 - OUTPUT_RETENTION_MS - 1000);
    row(db, 'xv1-new-0', T0 - 86_400_000);
    expect(await purgeOldOutputs(db, T0)).toBe(1203);
    expect(db.prepare('SELECT COUNT(*) FROM llm_requests WHERE output IS NULL AND params IS NULL AND purged_at = ?').pluck().get(T0)).toBe(1203);
    expect(db.prepare(`SELECT output IS NOT NULL FROM llm_requests WHERE custom_id = 'xv1-new-0'`).pluck().get()).toBe(1);
    expect(db.prepare('SELECT ROUND(SUM(cost_usd), 2) FROM llm_requests').pluck().get()).toBe(12.04);
    expect(await purgeOldOutputs(db, T0)).toBe(0);
    const purge = llmJobs({}).find((j) => j.name === 'llm-purge')!;
    const out = await purge.run({ db, jobRunId: 1, trigger: 'manual', now: () => T0, log: nullLogger, signal: new AbortController().signal });
    expect(out).toEqual({ stats: { purged: 0 } });
  });

  it('llm-collect runs a collect pass through the injected services (skipped without a key)', async () => {
    const db = memDb();
    const api = new FakeAnthropic().onBatchItem(() => ({ message: reply({ json: { ok: true } }) }));
    const llm = createLlmClient({ db, apiKey: 'synthetic-test-key', egress: createEgress(db), fetch: api.fetch, now: () => T0, maxRetries: 0 });
    const services = (): AgentServices => ({ llm, egress: createEgress(db), outbound: new FakeOutboundSender({ db, now: () => T0 }), push: new FakePushSender() });
    const sub = await llm.submitBatch(
      [{ kind: 'circle_name', route: 'circle_name', subjectRef: 'c1', customId: 'nv1-c1-0', promptVersion: 'v1', system: 's', messages: [{ role: 'user', content: 'Climbing crew' }], maxTokens: 500, schema: z.object({ ok: z.boolean() }) }],
      { purpose: 'circle_name', runId: 'r' },
    );
    expect(sub.status).toBe('submitted');
    const collect = llmJobs({ services }).find((j) => j.name === 'llm-collect')!;
    // No consumer for circle_name: the batch is left to its stage until it is an orphan (26 h).
    const ctx = { db, jobRunId: 1, trigger: 'manual' as const, now: () => T0 + 27 * 3_600_000, log: nullLogger, signal: new AbortController().signal };
    expect(await collect.run(ctx)).toMatchObject({ status: 'ok', stats: { batches_ended: 1, results: 1, unconsumed: 1 } });
    const noKey = llmJobs({ services: () => ({ ...services(), llm: createLlmClient({ db, apiKey: null, egress: createEgress(db) }) }) }).find((j) => j.name === 'llm-collect')!;
    expect(await noKey.run(ctx)).toEqual({ status: 'skipped' });
  });
});

describe('016 schema', () => {
  it('adds the ledger columns with their checks', () => {
    const db = memDb();
    const cols = db.prepare(`SELECT name FROM pragma_table_info('llm_requests')`).pluck().all() as string[];
    for (const c of ['pool', 'mode', 'params', 'estimate_usd', 'refusal_category', 'error_type', 'fallback_used', 'retry_of', 'not_before', 'spent_date']) expect(cols).toContain(c);
    const bcols = db.prepare(`SELECT name FROM pragma_table_info('llm_batches')`).pluck().all() as string[];
    for (const c of ['pool', 'counts', 'last_polled_at', 'poll_count', 'collected_at']) expect(bcols).toContain(c);
    expect(() =>
      db
        .prepare(`INSERT INTO llm_requests (custom_id, kind, subject_ref, prompt_version, model, input_hash, status, created_at, pool) VALUES ('a', 'extract', 's', 'v', 'm', 'h', 'pending', 1, 'free')`)
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('prompt caching helpers', () => {
  it('one byte-stable cached system block; volatile markers are detected', () => {
    expect(systemBlocks('stable')).toEqual([{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(systemBlocks('stable', '5m')[0]!.cache_control?.ttl).toBe('5m');
    expect(systemBlocks('stable', null)).toEqual([{ type: 'text', text: 'stable' }]);
    expect(volatileMarkers('You are the extractor. Example: [m:1|2026-10-12|P1→ME] hi')).toEqual([]);
    expect(volatileMarkers(`Today is Tuesday. Run 019a0000-0000-7000-8000-00000000000a at 2026-10-14T07:30`)).toEqual(['iso_timestamp', 'uuid', 'today']);
  });

  it('structured-output formats come from the zod schema (memoized, so byte-stable) and feed promptVersion', () => {
    const S = z.object({ n: z.number().min(0).max(5), tags: z.array(z.string()).max(5), note: z.string().nullable() });
    const f = outputFormat(S);
    expect(f.type).toBe('json_schema');
    expect(outputFormat(S)).toBe(f);
    expect(f.schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['n', 'tags', 'note'] });
    expect(JSON.stringify(f)).not.toContain('function');
    expect(promptVersion('sys', schemaJson(S), 'low')).toBe(promptVersion('sys', schemaJson(S), 'low'));
  });
});
