/**
 * The agent loop's timetable (PLAN "Schedule"; every job is "if due, run" on the 10 s tick) and the shared
 * dependencies agent job modules receive. Source jobs keep their own times (02:00 Partiful, 02:15 backup,
 * 02:30 iMessage overlap, 02:45 identity-match, 02:50 identity tie-break (LLM, identity/tiebreakJobs.ts),
 * 03:00 occasions).
 *
 * Night order (each stage reads what the earlier ones applied; the digest uses whatever is applied by compose):
 *   03:10 extraction windows → batch submit (+ calendar adjudication batch)
 *   every 5 min llm collect: poll → validate → apply (until done; deadline 07:15)
 *   06:50 graph (edge_stats from edge_evidence)      Sun 04:00 circles (Louvain, naming)
 *   06:55 ties (person_stats, snapshots)
 *   07:00 obligations nightly pass (+ hourly reply-debt/commitment closers)
 *   07:05 intel (trips, briefs, follow-ups, intros)
 *   07:16 suggestions (candidates → rank → digest row)
 *   07:30 compose (digest copy; template fallback)
 *   every 60 s delivery (sends at settings digest.time; catch-up until digest.catch_up_until)
 *   every 10 s commands (after the iMessage tail: self-thread rows)
 */
import type { DB } from '../db/connection';
import type { ServicesConfig, ServicesProvider } from '../services';
import type { Logger } from '../ops/logger';

const MIN = 60_000;

export const AGENT_TIMES = {
  extractSubmit: '03:10',
  llmCollectEveryMs: 5 * MIN,
  llmPurge: '04:30',
  /** Met-at inference (intel/metAt): after identity-match 02:45 and occasions 03:00, before graph and intel. */
  metAt: '06:40',
  graph: '06:50',
  circles: { dow: 0, at: '04:00' },
  ties: '06:55',
  obligations: '07:00',
  obligationsEveryMs: 60 * MIN,
  intel: '07:05',
  suggestions: '07:16',
  compose: '07:30',
  deliveryTickMs: MIN,
  commandsTickMs: 10_000,
} as const;

/** What every agent job module receives from buildJobs. */
export interface AgentJobDeps {
  /** IANA zone for daily times (default: the system zone; the `tz` setting governs local dates inside jobs). */
  timeZone?: string;
  /** The config subset services are built from (keys are never logged). */
  config?: ServicesConfig;
  /** Injected services (tests); else resolveServices builds the memoized defaults. */
  services?: ServicesProvider;
  log?: Logger;
}

/** For job bodies: `resolveServices(jobServices(deps, ctx.db))`. */
export const jobServices = (deps: AgentJobDeps, db: DB) => ({ db, services: deps.services, config: deps.config, log: deps.log });
