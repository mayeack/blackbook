/**
 * THE job registration list. Add new jobs here (one entry per job; cadences per PLAN.md "Schedule").
 * Source jobs are registered only when their configuration is present (sourceJobDeps), so callers that pass only
 * backup/log paths (tests) get none of them. Agent-loop jobs come after the source jobs, gated by agentJobDeps;
 * each builder fills its own module's `…Jobs()` (times in ../timetable.ts).
 */
import path from 'node:path';
import { COLLECTOR_DEFAULT_URL } from '@yb/shared/collector/v1';
import { addressbookJobs, type AddressbookJobDeps } from '../../adapters/addressbook/jobs';
import { beeperJobs, type BeeperJobDeps } from '../../adapters/beeper/jobs';
import { calendarJobs, type CalendarJobDeps } from '../../adapters/calendar/jobs';
import { gmailJobs, ticketParseJobs, type GmailJobDeps } from '../../adapters/gmail/jobs';
import { gphotosJobs, type GphotosDeps } from '../../adapters/gphotos/jobs';
import { callsJobs, type CallsJobDeps } from '../../adapters/calls/jobs';
import { imessageJobs, type ImessageJobDeps } from '../../adapters/imessage/jobs';
import { instagramDyiJobs, type InstagramDyiJobDeps } from '../../adapters/instagram/jobs';
import { partifulJobs, type PartifulJobDeps } from '../../adapters/partiful/jobs';
import { whatsappJobs, type WhatsappJobDeps } from '../../adapters/whatsapp/jobs';
import type { AppConfig } from '../../config';
import { dailyBackup } from '../../db/backup';
import { commandsJobs } from '../../commands/jobs';
import { deliveryJobs } from '../../delivery/jobs';
import { extractionJobs } from '../../extraction/jobs';
import { matcherJobs, type MatcherJobDeps } from '../../identity/matcherJobs';
import { tiebreakJobs } from '../../identity/tiebreakJobs';
import { intelJobs } from '../../intel/jobs';
import { metAtJobs } from '../../intel/metAt/jobs';
import { llmJobs } from '../../llm/jobs';
import { pruneLogs, type Logger } from '../../ops/logger';
import { circlesJobs } from '../../pipeline/circles/jobs';
import { graphJobs } from '../../pipeline/graph/jobs';
import { obligationsJobs } from '../../pipeline/obligations/jobs';
import { occasionJobs, type OccasionJobDeps } from '../../pipeline/occasions/jobs';
import { suggestionsJobs } from '../../pipeline/suggestions/jobs';
import { tiesJobs } from '../../pipeline/ties/jobs';
import type { ServicesProvider } from '../../services';
import { daily, type JobDef } from '../scheduler';
import type { AgentJobDeps } from '../timetable';

type SourceConfigKeys =
  | 'dataDir'
  | 'collectorUrl'
  | 'collectorTokenFile'
  | 'beeper'
  | 'browserCdpUrl'
  | 'google'
  | 'importsDir'
  | 'secretsKey'
  | 'anthropicApiKey'
  | 'vapid';

export interface JobDeps {
  config: Pick<AppConfig, 'backupDir' | 'logDir'> & Partial<Pick<AppConfig, SourceConfigKeys>>;
  timeZone?: string;
  /** Injected LLM/egress/outbound/push (tests); else jobs build the memoized defaults from config. */
  services?: ServicesProvider;
  log?: Logger;
}

/** Per-source job dependencies; null = that source isn't configured here, so its jobs aren't registered. */
export interface SourceJobDeps {
  imessage: ImessageJobDeps | null;
  whatsapp: WhatsappJobDeps | null;
  addressbook: AddressbookJobDeps | null;
  calls: CallsJobDeps | null;
  beeper: BeeperJobDeps | null;
  instagramDyi: InstagramDyiJobDeps | null;
  partiful: PartifulJobDeps | null;
  calendar: CalendarJobDeps | null;
  /** Gmail ticket emails (adapters/gmail; needs the Google OAuth client and SECRETS_KEY). */
  gmail: GmailJobDeps | null;
  /** Google Photos Picker screenshots (adapters/gphotos; needs the OAuth client, SECRETS_KEY and a data dir). */
  gphotos: GphotosDeps | null;
  /** Database-only pipeline jobs (identity matcher, occasions): any server with a data dir. */
  matcher: MatcherJobDeps | null;
  occasions: OccasionJobDeps | null;
}

/**
 * Agent-loop job dependencies; null = not configured here.
 *   pipeline: any server with a data dir (ties, graph, circles, obligations, intel, suggestions, delivery);
 *   llm:      also needs ANTHROPIC_API_KEY (llm collect/purge, extraction submit, identity tie-break);
 *   commands: also needs the collector (self-thread rows arrive through the iMessage tail).
 */
export interface AgentJobDepsSet {
  pipeline: AgentJobDeps | null;
  llm: AgentJobDeps | null;
  commands: AgentJobDeps | null;
}

export function agentJobDeps(deps: JobDeps): AgentJobDepsSet {
  const c = deps.config;
  if (!c.dataDir) return { pipeline: null, llm: null, commands: null };
  const tokenFile = c.collectorTokenFile ?? path.join(c.dataDir, 'collector.token');
  const base: AgentJobDeps = {
    timeZone: deps.timeZone,
    services: deps.services,
    log: deps.log,
    config: {
      anthropicApiKey: c.anthropicApiKey ?? null,
      vapid: c.vapid ?? null,
      collectorUrl: c.collectorUrl ?? COLLECTOR_DEFAULT_URL,
      collectorTokenFile: tokenFile,
    },
  };
  return { pipeline: base, llm: c.anthropicApiKey ? base : null, commands: sourceJobDeps(deps).imessage ? base : null };
}

export function sourceJobDeps(deps: JobDeps): SourceJobDeps {
  const c = deps.config;
  // The collector token path: explicit, or <data dir>/collector.token.
  const tokenFile = c.collectorTokenFile ?? (c.dataDir ? path.join(c.dataDir, 'collector.token') : undefined);
  const collector = tokenFile ? { collectorUrl: c.collectorUrl ?? COLLECTOR_DEFAULT_URL, collectorTokenFile: tokenFile } : null;
  const secretsKey = c.secretsKey ?? null;
  const pipeline = c.dataDir ? { timeZone: deps.timeZone } : null;
  return {
    imessage: collector,
    whatsapp: collector,
    addressbook: collector,
    calls: collector,
    // The token comes from the environment or the secrets table (which needs SECRETS_KEY).
    beeper: c.beeper && (c.beeper.token || secretsKey) ? { url: c.beeper.url, token: c.beeper.token, secretsKey } : null,
    instagramDyi: c.importsDir ? { importsDir: c.importsDir } : null,
    partiful: c.browserCdpUrl ? { browserCdpUrl: c.browserCdpUrl, secretsKey } : null,
    calendar: c.google && secretsKey ? { google: c.google, secretsKey } : null,
    gmail: c.google && secretsKey ? { google: c.google, secretsKey } : null,
    gphotos:
      c.google && secretsKey && c.dataDir
        ? { google: c.google, secretsKey, dataDir: c.dataDir, collectorUrl: collector?.collectorUrl, collectorTokenFile: collector?.collectorTokenFile }
        : null,
    matcher: pipeline,
    occasions: pipeline,
  };
}

export function buildJobs(deps: JobDeps): JobDef[] {
  const s = sourceJobDeps(deps);
  const a = agentJobDeps(deps);
  return [
    {
      name: 'backup',
      schedule: daily('02:15'),
      exclusive: true,
      async run(ctx) {
        const { pruned } = await dailyBackup(ctx.db, deps.config.backupDir, ctx.now(), deps.timeZone);
        return { stats: { pruned: pruned.length } };
      },
    },
    {
      name: 'logs-prune',
      schedule: daily('04:45'),
      run(ctx) {
        return { stats: { removed: pruneLogs(deps.config.logDir, 14, ctx.now()).length } };
      },
    },
    // imessage-tail (10 s) + imessage-overlap (02:30)
    ...(s.imessage ? imessageJobs(s.imessage) : []),
    ...(s.addressbook ? addressbookJobs(s.addressbook) : []),
    ...(s.calls ? callsJobs(s.calls) : []),
    ...(s.whatsapp ? whatsappJobs(s.whatsapp) : []),
    ...(s.beeper ? beeperJobs(s.beeper) : []),
    ...(s.instagramDyi ? instagramDyiJobs(s.instagramDyi) : []),
    ...(s.partiful ? partifulJobs(s.partiful) : []),
    ...(s.calendar ? calendarJobs(s.calendar) : []),
    ...(s.matcher ? matcherJobs(s.matcher) : []),
    ...(s.occasions ? occasionJobs(s.occasions) : []),
    ...(s.gmail ? gmailJobs(s.gmail) : []),
    ...(s.gphotos ? gphotosJobs(s.gphotos) : []),
    // agent loop (scheduler/timetable.ts AGENT_TIMES)
    ...(a.llm ? tiebreakJobs(a.llm) : []),
    ...(a.llm ? extractionJobs(a.llm) : []),
    ...(a.llm ? llmJobs(a.llm) : []),
    // Building it registers the 'ticket_parse' batch consumer that llm-collect hands results to.
    ...(a.llm ? ticketParseJobs(a.llm) : []),
    ...(a.pipeline ? metAtJobs(a.pipeline) : []),
    ...(a.pipeline ? graphJobs(a.pipeline) : []),
    ...(a.pipeline ? circlesJobs(a.pipeline) : []),
    ...(a.pipeline ? tiesJobs(a.pipeline) : []),
    ...(a.pipeline ? obligationsJobs(a.pipeline) : []),
    ...(a.pipeline ? intelJobs(a.pipeline) : []),
    ...(a.pipeline ? suggestionsJobs(a.pipeline) : []),
    ...(a.pipeline ? deliveryJobs(a.pipeline) : []),
    ...(a.commands ? commandsJobs(a.commands) : []),
  ];
}
