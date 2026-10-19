/**
 * LLM jobs (registered by scheduler/jobs/index.ts only with an API key; times in scheduler/timetable.ts):
 *   llm-collect     every AGENT_TIMES.llmCollectEveryMs: poll open Message Batches, stream results into the ledger,
 *                   hand them to the purpose's BatchConsumer (validate → apply / re-run / re-queue), submit due
 *                   re-queues (llm/batches.ts). Yields the event loop between chunks and stops early on ctx.signal.
 *   llm-purge       daily AGENT_TIMES.llmPurge: llm_requests.output (and the stored request bodies) older than 30 days
 *                   are cleared in chunks. Costs, usage and statuses stay for the budget and the eval.
 *   llm-efficiency  weekly AGENT_TIMES.llmEfficiency: the API-efficiency report over the past 7 days
 *                   (llm/efficiency.ts). Findings are logged (counts only); a 'warning' finding opens the 'llm' alert,
 *                   which points at `yb llm-usage` for the details.
 */
import type { JobDef } from '../scheduler/scheduler';
import { daily, interval, weekly } from '../scheduler/scheduler';
import { AGENT_TIMES, jobServices, type AgentJobDeps } from '../scheduler/timetable';
import { resolveServices } from '../services';
import { collectBatches } from './batches';
import { efficiencyReport } from './efficiency';
import { openLlmAlert, purgeOutputsChunk } from './ledger';

export type LlmJobDeps = AgentJobDeps;

const PURGE_CHUNK = 500;
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The alert a 'warning' efficiency finding opens (fixed text: never ids, names or content). */
export const EFFICIENCY_ALERT = 'The weekly LLM efficiency check found spend worth a look (caching, prompt size, wasted calls or estimates). Run `yb llm-usage` for the details.';

/** Clears outputs older than 30 days; returns how many rows were purged. */
export async function purgeOldOutputs(db: Parameters<typeof purgeOutputsChunk>[0], now: number, signal?: AbortSignal): Promise<number> {
  let total = 0;
  for (;;) {
    if (signal?.aborted) break;
    const n = purgeOutputsChunk(db, now, PURGE_CHUNK);
    total += n;
    if (n < PURGE_CHUNK) break;
    await yieldLoop();
  }
  return total;
}

export function llmJobs(deps: LlmJobDeps): JobDef[] {
  return [
    {
      name: 'llm-collect',
      schedule: interval(AGENT_TIMES.llmCollectEveryMs),
      async run(ctx) {
        const { llm } = resolveServices(jobServices(deps, ctx.db));
        if (!llm.configured) return { status: 'skipped' };
        const stats = await collectBatches({ db: ctx.db, llm, now: ctx.now, signal: ctx.signal, log: ctx.log });
        return { status: stats.poll_errors || stats.apply_errors ? 'partial' : 'ok', stats };
      },
    },
    {
      name: 'llm-purge',
      schedule: daily(AGENT_TIMES.llmPurge),
      async run(ctx) {
        return { stats: { purged: await purgeOldOutputs(ctx.db, ctx.now(), ctx.signal) } };
      },
    },
    {
      name: 'llm-efficiency',
      schedule: weekly(AGENT_TIMES.llmEfficiency.dow, AGENT_TIMES.llmEfficiency.at),
      async run(ctx) {
        const now = ctx.now();
        const r = efficiencyReport(ctx.db, now, { days: 7 });
        for (const f of r.findings) ctx.log.info('llm_efficiency_finding', { job: f.kind, counts: { [f.code]: 1, warning: f.severity === 'warning' ? 1 : 0 } });
        const warnings = r.findings.filter((f) => f.severity === 'warning').length;
        if (warnings) openLlmAlert(ctx.db, EFFICIENCY_ALERT, now, 'info');
        return {
          stats: {
            requests: r.totals.requests,
            billed: r.totals.billed,
            cost_micro_usd: Math.round(r.totals.costUsd * 1e6),
            cache_read_pct: r.totals.cacheReadShare === null ? 0 : Math.round(r.totals.cacheReadShare * 100),
            warnings,
            infos: r.findings.length - warnings,
          },
        };
      },
    },
  ];
}
