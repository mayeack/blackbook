/**
 * event_pick_runs / event_picks reads and writes (migration 027; design docs/design/event-picks.md). Runs and picks
 * are the agent's own recommendations, not the owner's data, so they aren't journaled; the owner's answers
 * (going / not for me / undo) are stored on the pick itself and are what the ranker learns from.
 */
import { randomBytes } from 'node:crypto';
import type { DB } from '../../db/connection';
import type { LinkKind } from './links';
import type { PickOutcome, PickSource, ScoreParts } from './rank';

export type RunStatus = 'discovering' | 'ready' | 'sent' | 'empty' | 'failed';
export type PickStatus = 'found' | 'picked' | 'going' | 'not_for_me' | 'passed';

export interface RunRow {
  id: string;
  week_start: string;
  window_end: string;
  status: RunStatus;
  city: string | null;
  free_nights: string;
  searches: number;
  cost_usd: number;
  found: number;
  dropped: string;
  attempts: number;
  error: string | null;
  outbound_ids: string;
  newsletters: number;
  listings: number;
  channel: 'email' | 'text' | null;
  email_state: 'sending' | 'sent' | 'failed' | null;
  email_id: string | null;
  email_at: number | null;
  created_at: number;
  sent_at: number | null;
  updated_at: number;
}

export interface PickRow {
  id: string;
  run_id: string;
  ordinal: number | null;
  event_key: string;
  source: PickSource;
  source_ref: string | null;
  title: string;
  performers: string;
  genres: string;
  category: string;
  venue: string;
  venue_key: string;
  city: string | null;
  local_date: string;
  start_time: string | null;
  starts_at: number;
  ticket_url: string | null;
  ticket_host: string | null;
  link_kind: LinkKind | null;
  source_url: string | null;
  why: string | null;
  score: number;
  parts: string;
  wildcard: number;
  drop_reason: string | null;
  status: PickStatus;
  clicks: number;
  clicked_at: number | null;
  outcome_at: number | null;
  outcome_source: string | null;
  outbound_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A random, URL-safe pick id (it appears in yeackbot.com/go/<id>; unguessable, not a secret). */
export const newPickId = (): string => randomBytes(9).toString('base64url');
export const newRunId = (): string => `epr_${randomBytes(8).toString('hex')}`;

export function runForWeek(db: DB, weekStart: string): RunRow | null {
  return (db.prepare('SELECT * FROM event_pick_runs WHERE week_start = ?').get(weekStart) as RunRow | undefined) ?? null;
}

export function latestSentRun(db: DB): RunRow | null {
  return (db.prepare(`SELECT * FROM event_pick_runs WHERE status IN ('sent','ready') ORDER BY week_start DESC LIMIT 1`).get() as RunRow | undefined) ?? null;
}

export function startRun(db: DB, o: { id: string; weekStart: string; windowEnd: string; now: number }): RunRow {
  db.prepare(
    `INSERT INTO event_pick_runs (id, week_start, window_end, status, attempts, created_at, updated_at)
     VALUES (@id, @weekStart, @windowEnd, 'discovering', 1, @now, @now)
     ON CONFLICT(week_start) DO UPDATE SET status = 'discovering', attempts = attempts + 1, error = NULL, updated_at = @now`,
  ).run(o);
  return runForWeek(db, o.weekStart)!;
}

export function finishRun(
  db: DB,
  id: string,
  o: {
    status: RunStatus;
    now: number;
    city?: string | null;
    freeNights?: string[];
    searches?: number;
    costUsd?: number;
    found?: number;
    dropped?: Record<string, number>;
    newsletters?: number;
    listings?: number;
    error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE event_pick_runs SET status = @status, city = coalesce(@city, city), free_nights = coalesce(@freeNights, free_nights),
       searches = searches + @searches, cost_usd = cost_usd + @cost, found = coalesce(@found, found), dropped = coalesce(@dropped, dropped),
       newsletters = coalesce(@newsletters, newsletters), listings = coalesce(@listings, listings), error = @error, updated_at = @now
     WHERE id = @id`,
  ).run({
    newsletters: o.newsletters ?? null,
    listings: o.listings ?? null,
    id,
    status: o.status,
    now: o.now,
    city: o.city ?? null,
    freeNights: o.freeNights ? JSON.stringify(o.freeNights) : null,
    searches: o.searches ?? 0,
    cost: o.costUsd ?? 0,
    found: o.found ?? null,
    dropped: o.dropped ? JSON.stringify(o.dropped) : null,
    error: o.error ? o.error.slice(0, 80) : null,
  });
}

export interface NewPick {
  id: string;
  ordinal: number | null;
  eventKey: string;
  source: PickSource;
  sourceRef: string | null;
  title: string;
  performers: string[];
  genres: string[];
  category: string;
  venue: string;
  venueKey: string;
  city: string | null;
  localDate: string;
  startTime: string | null;
  startsAt: number;
  ticketUrl: string | null;
  ticketHost: string | null;
  linkKind: LinkKind | null;
  sourceUrl: string | null;
  why: string | null;
  parts: ScoreParts | null;
  wildcard: boolean;
  dropReason: string | null;
}

/** Replaces a run's picks (a re-run of the same week starts over). */
export function savePicks(db: DB, runId: string, picks: readonly NewPick[], now: number): void {
  db.prepare('DELETE FROM event_picks WHERE run_id = ? AND outbound_id IS NULL').run(runId);
  const ins = db.prepare(
    `INSERT INTO event_picks (id, run_id, ordinal, event_key, source, source_ref, title, performers, genres, category, venue, venue_key, city, local_date,
       start_time, starts_at, ticket_url, ticket_host, link_kind, source_url, why, score, parts, wildcard, drop_reason, status, created_at, updated_at)
     VALUES (@id, @runId, @ordinal, @eventKey, @source, @sourceRef, @title, @performers, @genres, @category, @venue, @venueKey, @city, @localDate,
       @startTime, @startsAt, @ticketUrl, @ticketHost, @linkKind, @sourceUrl, @why, @score, @parts, @wildcard, @dropReason, @status, @now, @now)`,
  );
  for (const p of picks) {
    ins.run({
      ...p,
      runId,
      sourceRef: p.sourceRef ? p.sourceRef.slice(0, 200) : null,
      performers: JSON.stringify(p.performers),
      genres: JSON.stringify(p.genres),
      score: p.parts?.score ?? 0,
      parts: JSON.stringify(p.parts ?? {}),
      wildcard: p.wildcard ? 1 : 0,
      status: p.ordinal !== null ? 'picked' : 'found',
      why: p.why ? p.why.slice(0, 160) : null,
      dropReason: p.dropReason ? p.dropReason.slice(0, 40) : null,
      now,
    });
  }
}

export function picksOfRun(db: DB, runId: string, o: { pickedOnly?: boolean } = {}): PickRow[] {
  return db
    .prepare(`SELECT * FROM event_picks WHERE run_id = ? ${o.pickedOnly ? 'AND ordinal IS NOT NULL' : ''} ORDER BY ordinal IS NULL, ordinal, score DESC`)
    .all(runId) as PickRow[];
}

export function pickById(db: DB, id: string): PickRow | null {
  return (db.prepare('SELECT * FROM event_picks WHERE id = ?').get(id) as PickRow | undefined) ?? null;
}

/** Event keys already sent in an earlier week (never pick the same event twice). */
export function sentKeys(db: DB, exceptRunId: string): Set<string> {
  return new Set(db.prepare(`SELECT event_key FROM event_picks WHERE ordinal IS NOT NULL AND run_id <> ?`).pluck().all(exceptRunId) as string[]);
}

/** Every sent pick with an answer or a passed night, for the learner. */
export function pickOutcomes(db: DB, since: number): PickOutcome[] {
  const rows = db
    .prepare(`SELECT category, genres, performers, venue_key, status, clicks, source, outcome_source FROM event_picks WHERE ordinal IS NOT NULL AND starts_at >= ? AND status <> 'found'`)
    .all(since) as {
    category: string;
    genres: string;
    performers: string;
    venue_key: string;
    status: PickOutcome['status'];
    clicks: number;
    source: PickSource;
    outcome_source: string | null;
  }[];
  const list = (raw: string) => {
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return rows.map((r) => ({
    category: r.category,
    genres: list(r.genres),
    performers: list(r.performers),
    venueKey: r.venue_key,
    status: r.status,
    clicks: r.clicks,
    source: r.source,
    outcomeSource: r.outcome_source,
  }));
}

export function markSent(db: DB, runId: string, o: { now: number; outboundIds: string[]; pickOutbound: Map<string, string>; channel?: 'email' | 'text' }): void {
  db.prepare(
    `UPDATE event_pick_runs SET status = 'sent', sent_at = coalesce(sent_at, @now), outbound_ids = @ids, channel = @channel, updated_at = @now WHERE id = @runId`,
  ).run({
    runId,
    now: o.now,
    ids: JSON.stringify(o.outboundIds),
    channel: o.channel ?? 'text',
  });
  const upd = db.prepare('UPDATE event_picks SET outbound_id = ?, updated_at = ? WHERE id = ?');
  for (const [pickId, outboundId] of o.pickOutbound) upd.run(outboundId, o.now, pickId);
}

/**
 * The email's state. 'sending' is written BEFORE the Gmail call: a run that finds it still 'sending' (the process
 * died mid-call) never sends again, since the mail may have gone out. Gmail's definite refusal sets 'failed', which a
 * later tick may retry.
 */
export function markEmail(db: DB, runId: string, state: 'sending' | 'sent' | 'failed', o: { now: number; emailId?: string | null }): void {
  db.prepare(
    `UPDATE event_pick_runs SET email_state = @state, email_id = coalesce(@emailId, email_id), email_at = @now, updated_at = @now,
       status = CASE WHEN @state = 'sent' THEN 'sent' ELSE status END, channel = CASE WHEN @state = 'sent' THEN 'email' ELSE channel END,
       sent_at = CASE WHEN @state = 'sent' THEN coalesce(sent_at, @now) ELSE sent_at END
     WHERE id = @runId`,
  ).run({ runId, state, now: o.now, emailId: o.emailId ? o.emailId.slice(0, 64) : null });
}

/** The run before `weekStart` that went out (for "last week" in the email). */
export function previousSentRun(db: DB, weekStart: string): RunRow | null {
  return (db.prepare(`SELECT * FROM event_pick_runs WHERE status = 'sent' AND week_start < ? ORDER BY week_start DESC LIMIT 1`).get(weekStart) as RunRow | undefined) ?? null;
}

/** A tap on yeackbot.com/go/<id>. */
export function recordClick(db: DB, id: string, now: number): void {
  db.prepare('UPDATE event_picks SET clicks = clicks + 1, clicked_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

export type Verdict = 'going' | 'not_for_me' | 'undo';

/**
 * The owner's own answer on a sent pick. 'undo' clears HIS answer only (back to picked, or passed when the night is
 * over); an outcome the agent detected (a ticket, the calendar) isn't his to undo here. Returns the new status, or
 * null when the pick isn't a sent one.
 */
export function setVerdict(db: DB, id: string, verdict: Verdict, o: { now: number; today: string }): PickStatus | null {
  const p = pickById(db, id);
  if (!p || p.ordinal === null) return null;
  if (verdict === 'undo') {
    if (p.outcome_source !== 'owner') return p.status;
    const back: PickStatus = p.local_date < o.today ? 'passed' : 'picked';
    db.prepare(`UPDATE event_picks SET status = @back, outcome_at = CASE WHEN @back = 'passed' THEN @now END, outcome_source = CASE WHEN @back = 'passed' THEN 'date' END, updated_at = @now WHERE id = @id`).run({
      id,
      back,
      now: o.now,
    });
    return back;
  }
  db.prepare(`UPDATE event_picks SET status = @verdict, outcome_at = @now, outcome_source = 'owner', updated_at = @now WHERE id = @id`).run({ id, verdict, now: o.now });
  return verdict;
}
