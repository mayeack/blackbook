/**
 * LLM jobs (registered by scheduler/jobs/index.ts only with an API key; times in scheduler/timetable.ts):
 *   llm-collect  every AGENT_TIMES.llmCollectEveryMs: poll open Message Batches, stream results into the ledger,
 *                hand them to the purpose's BatchConsumer (validate → apply / re-run / re-queue), submit due
 *                re-queues (llm/batches.ts). Yields the event loop between chunks and stops early on ctx.signal.
 *   llm-purge    daily AGENT_TIMES.llmPurge: llm_requests.output (and the stored request bodies) older than 30 days
 *                are cleared in chunks. Costs, usage and statuses stay for the budget and the eval.
 */
import type { JobDef } from '../scheduler/scheduler';
import { daily, interval } from '../scheduler/scheduler';
import { AGENT_TIMES, jobServices, type AgentJobDeps } from '../scheduler/timetable';
import { resolveServices } from '../services';
import { collectBatches } from './batches';
import { purgeOutputsChunk } from './ledger';

export type LlmJobDeps = AgentJobDeps;

const PURGE_CHUNK = 500;
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  ];
}
