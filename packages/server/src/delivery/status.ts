/**
 * The digest's status lines, all built from counts and fixed labels (never alert messages, titles or names):
 *   - "Last night: 2 merges · 4 links · 11 facts" (agent change batches in the 24 h before compose, not undone);
 *   - at most one health line ("⚠ WhatsApp quiet 4d · see Sources") from open alerts and source_health;
 *   - pipeline failure: a nightly agent job (or nightly run) that failed in the last 24 h and hasn't recovered;
 *   - people added over the last N days (the heartbeat's count).
 */
import type { DB } from '../db/connection';
import { plural } from './text';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface LastNightCounts {
  merges: number;
  links: number;
  facts: number;
}

/** Agent changes in [since, until): merges, identity links, facts (undone batches excluded). */
export function lastNightCounts(db: DB, since: number, until: number): LastNightCounts {
  const rows = db
    .prepare(
      `SELECT kind, count(*) AS n FROM change_batches
       WHERE actor = 'agent' AND undone_at IS NULL AND created_at >= ? AND created_at < ? AND kind IN ('merge','attach_identity','fact')
       GROUP BY kind`,
    )
    .all(since, until) as { kind: string; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.kind, r.n])) as Record<string, number>;
  return { merges: by.merge ?? 0, links: by.attach_identity ?? 0, facts: by.fact ?? 0 };
}

/** "Last night: 2 merges · 4 links · 11 facts", or null when nothing happened. */
export function lastNightLine(c: LastNightCounts): string | null {
  if (!c.merges && !c.links && !c.facts) return null;
  return `Last night: ${plural(c.merges, 'merge')} · ${plural(c.links, 'link')} · ${plural(c.facts, 'fact')}`;
}

/** Display labels for source_health / alerts sources (anything else is skipped: no free text goes out). */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  collector: 'The collector',
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
  beeper: 'Instagram',
  instagram: 'Instagram',
  instagram_dyi: 'Instagram export',
  partiful: 'Partiful',
  gcal: 'Google Calendar',
  calendar: 'Google Calendar',
  google_calendar: 'Google Calendar',
  addressbook: 'Contacts',
  contacts: 'Contacts',
};

/** What to do about a source, as a sentence. */
const ACTION: Readonly<Record<string, string>> = {
  WhatsApp: 'Open WhatsApp on your phone to wake it up.',
  Instagram: 'Check that Beeper is running on the Mac.',
  Partiful: 'Sign in to Partiful again.',
  'Google Calendar': 'Reconnect Google in Settings.',
};

export interface HealthIssue {
  source: string;
  label: string;
  severity: 'critical' | 'warning';
  /** Days since the newest data (stale sources), when known. */
  quietDays: number | null;
  status: string;
}

/** The single most urgent health issue (critical alerts, then broken sources, then stale ones), or null. */
export function topHealthIssue(db: DB, now: number): HealthIssue | null {
  const issues: HealthIssue[] = [];
  const alerts = db.prepare(`SELECT source, severity FROM alerts WHERE resolved_at IS NULL AND severity IN ('critical','warning')`).all() as {
    source: string;
    severity: 'critical' | 'warning';
  }[];
  for (const a of alerts) {
    const label = SOURCE_LABELS[a.source];
    if (label) issues.push({ source: a.source, label, severity: a.severity, quietDays: null, status: 'alert' });
  }
  const health = db.prepare(`SELECT source, status, newest_data_at FROM source_health WHERE status IN ('stale','error','auth_required','contract_broken')`).all() as {
    source: string;
    status: string;
    newest_data_at: number | null;
  }[];
  for (const h of health) {
    const label = SOURCE_LABELS[h.source];
    if (!label) continue;
    issues.push({
      source: h.source,
      label,
      severity: h.status === 'stale' ? 'warning' : 'critical',
      quietDays: h.newest_data_at ? Math.max(1, Math.floor((now - h.newest_data_at) / DAY)) : null,
      status: h.status,
    });
  }
  const rank = (i: HealthIssue) => (i.severity === 'critical' ? 0 : 1) * 10 + (i.status === 'stale' ? 2 : i.status === 'alert' ? 0 : 1);
  issues.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  return issues[0] ?? null;
}

/** "Heads up: WhatsApp hasn't synced in 4 days. Open WhatsApp on your phone to wake it up." */
export function healthLine(i: HealthIssue | null): string | null {
  if (!i) return null;
  const what = i.status === 'stale' && i.quietDays ? `hasn't synced in ${i.quietDays === 1 ? 'a day' : `${i.quietDays} days`}` : 'needs attention';
  return `Heads up: ${i.label} ${what}. ${ACTION[i.label] ?? 'See yeackbot.com/sources'}`;
}

/** "Heads up: last night's run failed at extract. Details at yeackbot.com/sources" */
export const failureLine = (stage: string): string => `Heads up: last night's run failed at ${stage}. Details at yeackbot.com/sources`;

/** Jobs that run every few seconds/minutes or deliver: their failures are source health, not "last night's run". */
const NOT_PIPELINE = /(?:tail|health|commands|digest-send|compose|backup|logs-prune|whatsapp|beeper|gcal|addressbook|contacts|partiful|instagram)/;

export interface PipelineFailure {
  /** A safe stage label (job name or run stage, [a-z0-9_-]). */
  stage: string;
  at: number;
}

const safeStage = (s: string | null | undefined): string | null => {
  const t = s?.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
  return t ? t : null;
};

/** A nightly pipeline stage that failed in the 24 h before `now` and is still failing, or null. */
export function pipelineFailure(db: DB, now: number): PipelineFailure | null {
  const since = now - DAY;
  const run = db
    .prepare(`SELECT stage, started_at FROM runs WHERE kind = 'nightly' AND status = 'error' AND started_at >= ? ORDER BY started_at DESC LIMIT 1`)
    .get(since) as { stage: string | null; started_at: number } | undefined;
  const jobs = db
    .prepare(
      `SELECT r.job, max(r.started_at) AS at FROM job_runs r JOIN job_state s ON s.job = r.job
       WHERE r.status = 'error' AND r.started_at >= ? AND s.consecutive_failures > 0
       GROUP BY r.job ORDER BY at DESC`,
    )
    .all(since) as { job: string; at: number }[];
  const job = jobs.find((j) => !NOT_PIPELINE.test(j.job));
  if (job) return { stage: safeStage(job.job) ?? 'nightly', at: job.at };
  if (run) {
    // A later successful nightly run means it recovered.
    const recovered = db.prepare(`SELECT 1 FROM runs WHERE kind = 'nightly' AND status = 'ok' AND started_at > ?`).get(run.started_at);
    if (!recovered) return { stage: safeStage(run.stage) ?? 'nightly', at: run.started_at };
  }
  return null;
}

/** People the agent added (visible now) in [since, until). */
export function peopleAdded(db: DB, since: number, until: number): number {
  return db.prepare('SELECT count(*) FROM person_visible WHERE created_at >= ? AND created_at < ?').pluck().get(since, until) as number;
}
