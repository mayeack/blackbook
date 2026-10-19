/**
 * The recurring API-efficiency check (llm/efficiency.ts, the llm-efficiency job, `yb llm-usage`): the per-kind token
 * profile from the ledger, what caching saved, and each finding's trigger, with nothing but counts and dollars in
 * what it prints, logs or alerts.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db/connection';
import { migrate } from '../../src/db/migrate';
import { efficiencyReport, findingsFor, formatEfficiencyReport, MIN_REQUESTS, type KindProfile } from '../../src/llm/efficiency';
import { EFFICIENCY_ALERT, llmJobs } from '../../src/llm/jobs';
import { costUsd, HAIKU_5_5, priceTokens, SONNET_5_5 } from '../../src/llm/models';
import { llmUsageCommand } from '../../src/llm/usageCli';
import { nullLogger } from '../../src/ops/logger';
import { memDb, T0, tempDir } from '../helpers';

type DBT = ReturnType<typeof memDb>;
let seq = 0;

interface RowOpts {
  kind?: string;
  mode?: 'sync' | 'batch';
  model?: string;
  status?: string;
  pool?: 'steady' | 'backfill';
  at?: number;
  /** [input, cacheRead, cacheWrite, output]; null = no usage (unbilled). */
  usage?: [number, number, number, number] | null;
  estimate?: number | null;
  cacheTtl?: '5m' | '1h';
}

/** One ledger row priced the way the client prices it. */
function row(db: DBT, o: RowOpts = {}): void {
  const mode = o.mode ?? 'batch';
  const model = o.model ?? HAIKU_5_5;
  const ttl = o.cacheTtl ?? (mode === 'batch' ? '1h' : '5m');
  const u: [number, number, number, number] | null = o.usage === undefined ? [2000, 2000, 0, 150] : o.usage;
  const usage = u ? { inputTokens: u[0], cacheReadInputTokens: u[1], cacheCreationInputTokens: u[2], outputTokens: u[3], costUsd: 0, batch: mode === 'batch', servedByModel: model, fallbackUsed: false } : null;
  const cost = u ? costUsd({ inputTokens: u[0], cacheReadInputTokens: u[1], cacheCreationInputTokens: u[2], outputTokens: u[3] }, mode, ttl, model) : null;
  db.prepare(
    `INSERT INTO llm_requests (custom_id, kind, subject_ref, prompt_version, model, input_hash, status, created_at, usage, cost_usd, pool, mode, estimate_usd, params, spent_date)
     VALUES (?, ?, 's', 'v1', ?, 'h', ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-14')`,
  ).run(
    `r${++seq}`,
    o.kind ?? 'calendar',
    model,
    o.status ?? (u ? 'applied' : 'errored'),
    o.at ?? T0 - 3_600_000,
    usage ? JSON.stringify(usage) : null,
    cost,
    o.pool ?? 'steady',
    mode,
    o.estimate === undefined ? null : o.estimate,
    mode === 'batch' ? JSON.stringify({ system: 's', cacheTtl: ttl, messages: [], outputSchema: null }) : null,
  );
}

const rows = (db: DBT, count: number, o: RowOpts = {}) => {
  for (let i = 0; i < count; i++) row(db, o);
};
const codes = (db: DBT) => efficiencyReport(db, T0).findings.map((f) => `${f.kind}:${f.code}:${f.severity}`);

describe('efficiencyReport: the measured profile', () => {
  it('sums the four token meters and cost per kind × mode, inside the window only', () => {
    const db = memDb();
    rows(db, 4, { kind: 'calendar', usage: [2000, 2100, 0, 140] });
    row(db, { kind: 'calendar', usage: [2000, 0, 2100, 140] });
    rows(db, 2, { kind: 'tiebreak', mode: 'sync', usage: [200, 600, 0, 210] });
    row(db, { kind: 'calendar', at: T0 - 8 * 86_400_000, usage: [99_999, 0, 0, 0] });
    const r = efficiencyReport(db, T0);
    const cal = r.kinds.find((k) => k.kind === 'calendar')!;
    expect(cal).toMatchObject({ mode: 'batch', route: 'adjudicate', requests: 5, billed: 5, inputTokens: 10_000, cacheReadTokens: 8400, cacheWriteTokens: 2100, outputTokens: 700 });
    expect(cal.cacheReadShare).toBeCloseTo(8400 / 20_500, 9);
    expect(r.kinds.map((k) => k.kind)).toEqual(['calendar', 'tiebreak']);
    expect(r.totals.requests).toBe(7);
    expect(r.totals.costUsd).toBeCloseTo(r.kinds.reduce((n, k) => n + k.costUsd, 0), 12);
    expect(r.totals.projectedSteady30dUsd).toBeCloseTo((r.totals.steadyUsd / 7) * 30, 12);
  });

  it('cacheSavedUsd = the same tokens uncached minus what they cost (1-h batch writes at 2×, reads at the model’s rate)', () => {
    const db = memDb();
    row(db, { usage: [1000, 3000, 1000, 100] });
    const k = efficiencyReport(db, T0).kinds[0]!;
    const priced = { model: HAIKU_5_5, mode: 'batch' as const };
    const expected = priceTokens({ input: 5000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, priced) - priceTokens({ input: 1000, output: 100, cacheRead: 3000, cacheWrite5m: 0, cacheWrite1h: 1000 }, priced);
    expect(k.cacheSavedUsd).toBeCloseTo(expected, 12);
    expect(k.cacheSavedUsd).toBeGreaterThan(0);
  });

  it('splits steady from the one-time backfill and projects only the steady pool', () => {
    const db = memDb();
    rows(db, 3, { pool: 'backfill' });
    row(db, { pool: 'steady' });
    const t = efficiencyReport(db, T0, { days: 7 }).totals;
    expect(t.backfillUsd).toBeCloseTo(3 * t.steadyUsd, 12);
    expect(t.projectedSteady30dUsd).toBeCloseTo((t.steadyUsd / 7) * 30, 12);
  });
});

describe('findings', () => {
  it('a healthy week (cache reads, estimates in line, nothing wasted) has none', () => {
    const db = memDb();
    rows(db, 30, { estimate: 0.0003 });
    expect(codes(db)).toEqual([]);
  });

  it('cache_unpaid: writes that the reads never pay back (needs MIN_REQUESTS billed rows)', () => {
    const db = memDb();
    rows(db, MIN_REQUESTS - 1, { usage: [500, 0, 2000, 100] });
    expect(codes(db)).toEqual([]);
    row(db, { usage: [500, 0, 2000, 100] });
    expect(codes(db)).toEqual(['calendar:cache_unpaid:warning']);
    // Enough reads per write and caching pays for itself again.
    rows(db, 40, { usage: [500, 2000, 0, 100] });
    expect(codes(db)).toEqual([]);
  });

  it('long_context: any single request over 100K prompt tokens; a tool loop’s summed turns are exempt', () => {
    const db = memDb();
    row(db, { kind: 'extract', usage: [90_000, 9000, 2000, 100] });
    rows(db, 3, { kind: 'ask', mode: 'sync', usage: [40_000, 80_000, 3000, 500], status: 'succeeded' });
    expect(codes(db)).toEqual(['extract:long_context:warning']);
  });

  it('wasted_spend: invalid / max_tokens / refused outcomes at ≥10% of a kind’s spend, at least 3 of them', () => {
    const db = memDb();
    rows(db, 20, { kind: 'circle_name', mode: 'sync', status: 'succeeded' });
    rows(db, 2, { kind: 'circle_name', mode: 'sync', status: 'schema_invalid' });
    expect(codes(db)).toEqual([]);
    row(db, { kind: 'circle_name', mode: 'sync', status: 'max_tokens' });
    expect(codes(db)).toEqual(['circle_name:wasted_spend:warning']);
    // 'rejected' is valid output the gates declined: not waste.
    const db2 = memDb();
    rows(db2, 10, { status: 'rejected' });
    expect(codes(db2)).toEqual([]);
  });

  it('estimate_low: actual cost well above the estimates the budget gates use; an over-estimate is fine', () => {
    const db = memDb();
    rows(db, MIN_REQUESTS, { estimate: 0.00001 });
    expect(codes(db)).toEqual(['calendar:estimate_low:warning']);
    const db2 = memDb();
    rows(db2, MIN_REQUESTS, { estimate: 1 });
    expect(codes(db2)).toEqual([]);
  });

  it('info: requests off the route’s default model, sync calls on a batch route, failed requests', () => {
    const db = memDb();
    row(db, { kind: 'tiebreak', mode: 'sync', model: SONNET_5_5, status: 'succeeded' });
    rows(db, MIN_REQUESTS, { kind: 'consolidate', mode: 'sync', status: 'succeeded' });
    rows(db, 5, { kind: 'extract', usage: null, status: 'dead_letter' });
    expect(codes(db).sort()).toEqual(['consolidate:sync_on_batch_route:info', 'extract:failed_requests:info', 'tiebreak:off_default_model:info']);
    const msg = efficiencyReport(db, T0).findings.find((f) => f.code === 'off_default_model')!.message;
    expect(msg).toContain('Claude Sonnet 5.5');
    expect(msg).toContain('Claude Haiku 5.5');
  });

  it('findingsFor is pure over a profile (messages carry counts and dollars only)', () => {
    const k: KindProfile = {
      kind: 'calendar',
      mode: 'batch',
      route: 'adjudicate',
      requests: 12,
      billed: 12,
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 10,
      outputTokens: 1,
      costUsd: 1,
      cacheReadShare: 0,
      cacheSavedUsd: -0.5,
      estimateRatio: null,
      estimated: 0,
      wasted: 0,
      wastedUsd: 0,
      failed: 0,
      overLimit: 0,
      offDefaultModel: 0,
      models: [HAIKU_5_5],
    };
    expect(findingsFor(k)).toEqual([
      {
        code: 'cache_unpaid',
        severity: 'warning',
        kind: 'calendar',
        mode: 'batch',
        message: 'calendar (batch): prompt caching cost $0.5000 more than it saved (10 tokens written, 0 read): look for a volatile system prompt, or a TTL longer than the gap between calls.',
      },
    ]);
  });
});

describe('formatEfficiencyReport', () => {
  it('prints the totals, one row per kind × mode, and the findings', () => {
    const db = memDb();
    rows(db, 3, { estimate: 0.0003 });
    row(db, { kind: 'extract', usage: [90_000, 9000, 2000, 100] });
    const lines = formatEfficiencyReport(efficiencyReport(db, T0));
    expect(lines[0]).toBe('LLM usage last 7 day(s) (counts and dollars only):');
    expect(lines[1]).toMatch(/^ {2}total \$0\.\d{4} · 4 request\(s\), 4 billed · cache-read share \d+% · caching saved/);
    expect(lines.some((l) => /^ {2}kind +mode +reqs/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {2}calendar +batch +3 /.test(l))).toBe(true);
    expect(lines.at(-2)).toBe('findings:');
    expect(lines.at(-1)).toMatch(/^ {2}\[warning\] extract \(batch\): 1 request\(s\) went over 100K prompt tokens/);
  });
});

describe('the llm-efficiency job', () => {
  const ctx = (db: DBT) => ({ db, jobRunId: 1, trigger: 'manual' as const, now: () => T0, log: nullLogger, signal: new AbortController().signal });
  const job = () => llmJobs({}).find((j) => j.name === 'llm-efficiency')!;
  const alerts = (db: DBT) => db.prepare(`SELECT severity, message FROM alerts WHERE source = 'llm' AND resolved_at IS NULL`).all();

  it('a warning finding opens the one llm alert (fixed text); a clean week opens none', async () => {
    const clean = memDb();
    rows(clean, 12, { estimate: 0.0003 });
    const ok = await job().run(ctx(clean));
    expect(ok).toMatchObject({ stats: { requests: 12, billed: 12, warnings: 0, infos: 0 } });
    expect(alerts(clean)).toEqual([]);

    const db = memDb();
    row(db, { kind: 'extract', usage: [90_000, 9000, 2000, 100] });
    const out = await job().run(ctx(db));
    expect(out).toMatchObject({ stats: { requests: 1, warnings: 1 } });
    expect(alerts(db)).toEqual([{ severity: 'info', message: EFFICIENCY_ALERT }]);
    // Re-running keeps the one open alert.
    await job().run(ctx(db));
    expect(alerts(db)).toHaveLength(1);
  });
});

describe('yb llm-usage', () => {
  function withDb(fill: (db: DBT) => void) {
    const { dir, cleanup } = tempDir('yb-llm-usage-');
    const dbPath = path.join(dir, 'yeackbot.db');
    const db = openDatabase(dbPath);
    migrate(db);
    fill(db);
    closeDatabase(db);
    return { paths: { dbPath } as Parameters<typeof llmUsageCommand>[1], cleanup };
  }
  const io = () => {
    const o = { out: [] as string[], err: [] as string[] };
    return { o, io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s) } };
  };

  it('prints the report read-only, or JSON with --json; bad --days is a usage error', async () => {
    const { paths, cleanup } = withDb((db) => rows(db, 2));
    try {
      const a = io();
      expect(await llmUsageCommand([], paths, a.io, () => T0)).toBe(0);
      expect(a.o.out[0]).toMatch(/^LLM usage 2026-10-0\d → 2026-10-14 \(counts and dollars only\):$/);
      const b = io();
      expect(await llmUsageCommand(['--json', '--days', '30'], paths, b.io, () => T0)).toBe(0);
      expect(JSON.parse(b.o.out[0]!)).toMatchObject({ days: 30, totals: { requests: 2 } });
      const c = io();
      expect(await llmUsageCommand(['--days', '0'], paths, c.io, () => T0)).toBe(2);
      expect(c.o.err).toEqual(['--days must be a whole number from 1 to 90.']);
    } finally {
      cleanup();
    }
  });
});
