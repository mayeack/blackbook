/**
 * The weekly event-picks run (design docs/design/event-picks.md; job 'event-picks' in jobs.ts). On the picks day
 * (settings events.weekday / events.time) for the 7 nights starting that night:
 *
 *   1. outcomes  refresh which earlier picks he went to (outcomes.ts), so this week learns from last week;
 *   2. nights    which of the 7 nights are free (nights.ts); none → run 'empty', nothing is searched or sent;
 *   3. taste     the profile (profile.ts) and the city (events.city, else the home city: travel.home_city or his
 *                location fact);
 *   4. search    candidates (discover.ts, ~40% of events.max_searches);
 *   5. filter    each candidate must be on a free night of the window and name a venue; one row per real event
 *                (eventKey); never an event sent in an earlier week. Dropped rows are kept with the reason;
 *   6. score     rank.ts (taste, kind, learned, link);
 *   7. tickets   one targeted search per top candidate still without its own ticket page (the rest of the budget);
 *   8. choose    rank.ts choosePicks (≤ events.max_picks, 🎲 wildcard at ε);
 *   9. send      one text per pick (compose.ts) to his own handle, purpose 'events', stable client refs, so a retry
 *                never double-sends. Delivery not configured, or quiet hours → the run stays 'ready' (the web
 *                shows it) and a later tick sends it the same day.
 * A failed discovery (API error, budget, unreadable answer) is retried every RETRY_AFTER_MS, at most MAX_ATTEMPTS
 * times a week. Costs: two web_search calls (≤ events.max_searches × $0.01 + tokens), rarely a third structured call.
 */
import { addDays, localDate, localParts } from '@yb/shared';
import type { DB } from '../../db/connection';
import { stableUuid } from '../../delivery/text';
import type { OutboundSender } from '../../delivery/types';
import type { Egress, LlmClient } from '../../llm/types';
import type { Logger } from '../../ops/logger';
import { readSetting, settingTimeZone } from '../../settings/registry';
import { DAY, dayStart, HOUR } from '../common';
import { METROS } from '../places';
import { homePlace } from '../trips';
import { venueKey as venueKeyOf } from '../../pipeline/occasions/text';
import { picksTexts, type PickText } from './compose';
import { bestLink, eventKey, findTicketPages, searchCandidates, type CheckedEvent, type SearchSetup, type TicketQuery } from './discover';
import { nightsOf } from './nights';
import { updatePickOutcomes } from './outcomes';
import { tasteProfile } from './profile';
import { choosePicks, scoreCandidate, learnFrom, seededRng, type Candidate, type Scored } from './rank';
import * as store from './store';

export const WINDOW_DAYS = 7;
export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 30 * 60_000;
/** Nothing is sent after this local time on the picks day (quiet hours start at 22:00 by default). */
export const SEND_UNTIL = '21:00';
/** Learning looks back this far. */
const LEARN_DAYS = 365;

export interface EventPicksDeps {
  llm: LlmClient;
  egress: Egress;
  outbound: OutboundSender;
  log?: Logger;
  signal?: AbortSignal;
}

export interface RunOptions {
  now: number;
  /** Send the texts once picked (the job); false = pick only (preview, tests). */
  send: boolean;
  /** Run even when it isn't the picks day / time, or events.enabled is off (manual `yb run-job event-picks`). */
  force?: boolean;
}

export type RunResult =
  | { status: 'skipped'; reason: string }
  | { status: 'empty'; runId: string; reason?: string; searches: number; costUsd: number }
  | { status: 'failed'; runId: string; reason?: string; searches: number; costUsd: number }
  | { status: 'ready' | 'sent'; runId: string; picks: number; found: number; searches: number; costUsd: number; dropped: Record<string, number>; sendReason?: string };

/** Whether the picks are due now: on events.weekday, from events.time until SEND_UNTIL (local). */
export function picksDue(db: DB, now: number): boolean {
  if (!readSetting(db, 'events.enabled')) return false;
  const p = localParts(now, settingTimeZone(db));
  return p.dow === readSetting(db, 'events.weekday') && p.hhmm >= readSetting(db, 'events.time') && p.hhmm < SEND_UNTIL;
}

/** The city to search and its search localization. */
export function pickCity(db: DB, now: number, timeZone: string): SearchSetup['location'] & { label: string } | null {
  const setting = readSetting(db, 'events.city');
  if (setting?.trim()) return { label: setting.trim(), city: setting.split(',')[0]!.trim(), timezone: timeZone };
  const home = homePlace(db, now);
  if (!home) return null;
  const metro = METROS.find((m) => `metro:${m.id}` === home.key);
  return { label: home.label, city: home.label, country: metro ? metro.country.toUpperCase() : null, timezone: timeZone };
}

const startsAtOf = (date: string, time: string | null, timeZone: string): number => {
  const [h, m] = (time ?? '20:00').split(':').map(Number) as [number, number];
  return dayStart(date, timeZone) + h * HOUR + m * 60_000;
};

interface Row extends Candidate {
  e: CheckedEvent;
  eventKey: string;
  drop: string | null;
}

export async function runEventPicks(db: DB, deps: EventPicksDeps, o: RunOptions): Promise<RunResult> {
  if (!o.force && !picksDue(db, o.now)) return { status: 'skipped', reason: 'not_due' };
  const tz = settingTimeZone(db);
  const today = localDate(o.now, tz);
  const existing = store.runForWeek(db, today);
  if (existing?.status === 'sent' || existing?.status === 'empty') return { status: 'skipped', reason: `already_${existing.status}` };
  if (existing?.status === 'ready') return sendRun(db, deps, existing, o);
  if (existing && !o.force) {
    if (existing.attempts >= MAX_ATTEMPTS) return { status: 'skipped', reason: 'attempts_exhausted' };
    if (o.now - existing.updated_at < RETRY_AFTER_MS) return { status: 'skipped', reason: existing.status === 'discovering' ? 'in_progress' : 'retry_later' };
  }
  const run = store.startRun(db, { id: store.newRunId(), weekStart: today, windowEnd: addDays(today, WINDOW_DAYS - 1), now: o.now });
  const log = deps.log;
  try {
    updatePickOutcomes(db, o.now, tz);
  } catch (e) {
    log?.warn('event_picks.outcomes_failed', { error_class: e instanceof Error ? e.name : 'unknown' });
  }

  const nights = nightsOf(db, today, WINDOW_DAYS, tz);
  const free = nights.filter((n) => n.free).map((n) => n.date);
  if (!free.length) {
    store.finishRun(db, run.id, { status: 'empty', now: o.now, freeNights: [], error: 'no_free_nights' });
    log?.info('event_picks.empty', { counts: { busy: nights.length } });
    return { status: 'empty', runId: run.id, reason: 'no_free_nights', searches: 0, costUsd: 0 };
  }
  const city = pickCity(db, o.now, tz);
  if (!city) {
    store.finishRun(db, run.id, { status: 'failed', now: o.now, freeNights: free, error: 'no_city' });
    return { status: 'failed', runId: run.id, reason: 'no_city', searches: 0, costUsd: 0 };
  }
  const maxPicks = readSetting(db, 'events.max_picks');
  const maxSearches = readSetting(db, 'events.max_searches');
  const searchesA = Math.max(1, Math.min(maxSearches - 1, Math.ceil(maxSearches * 0.4))) || 1;
  const profile = tasteProfile(db, o.now);
  const setup: SearchSetup = { city: city.label, location: city, nights: free, want: Math.min(15, maxPicks * 3) };
  const sdeps = { llm: deps.llm, egress: deps.egress, runId: run.id, signal: deps.signal };

  const a = await searchCandidates(sdeps, profile, setup, searchesA);
  let searches = a.searches;
  let cost = a.usage?.costUsd ?? 0;
  if (a.status === 'failed') {
    store.finishRun(db, run.id, { status: 'failed', now: o.now, city: city.label, freeNights: free, searches, costUsd: cost, error: a.reason });
    log?.warn('event_picks.search_failed', { error_code: a.reason, counts: { searches } });
    return { status: 'failed', runId: run.id, reason: a.reason, searches, costUsd: cost };
  }

  // Filter and dedupe (rows are kept with the reason).
  const freeSet = new Set(free);
  const windowEnd = addDays(today, WINDOW_DAYS - 1);
  const earlier = store.sentKeys(db, run.id);
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const e of a.events) {
    const venue = e.venue?.trim() ?? '';
    const key = eventKey({ date: e.date, venue, title: e.title });
    let drop: string | null = null;
    if (e.date < today || e.date > windowEnd) drop = 'outside_window';
    else if (!freeSet.has(e.date)) drop = 'busy_night';
    else if (!venue || /^(?:tba|tbd|secret|undisclosed|unknown|various|n\/a|none|venue)\b/i.test(venue)) drop = 'no_venue';
    else if (e.category === 'party' || e.category === 'member_event') drop = 'not_public';
    else if (seen.has(key)) drop = 'duplicate';
    else if (earlier.has(key)) drop = 'picked_before';
    seen.add(key);
    rows.push({
      id: store.newPickId(),
      date: e.date,
      category: e.category,
      performers: e.performers,
      genres: e.genres,
      venue: venue || '(unknown)',
      venueKey: venueKeyOf(venue),
      title: e.title,
      linkKind: e.ticket?.kind ?? null,
      e,
      eventKey: key,
      drop: drop ?? (e.ticket ? null : 'no_link'),
    });
  }
  // A missing link is fixable by the ticket pass; every other drop is final.
  const live = rows.filter((r) => r.drop === null || r.drop === 'no_link');
  const learned = learnFrom(store.pickOutcomes(db, o.now - LEARN_DAYS * DAY));
  const rng = seededRng(hashSeed(run.id));
  const score = (r: Row): Scored<Row> => ({ c: r, parts: scoreCandidate(r, profile, learned, rng) });
  let scored = live.map(score);

  // Ticket pages for the best candidates that lack their own page.
  const searchesB = maxSearches - searchesA;
  const needPages = [...scored]
    .sort((x, y) => y.parts.score - x.parts.score)
    .slice(0, maxPicks + 2)
    .filter((s) => s.c.linkKind !== 'ticket')
    .slice(0, searchesB);
  if (needPages.length) {
    const queries: TicketQuery[] = needPages.map((s, i) => ({ ref: `E${i + 1}`, title: s.c.title, performers: s.c.performers, venue: s.c.venue, city: s.c.e.city, date: s.c.date }));
    const b = await findTicketPages(sdeps, queries, setup, Math.min(searchesB, queries.length));
    searches += b.searches;
    cost += b.usage?.costUsd ?? 0;
    if (b.status === 'ok') {
      queries.forEach((q, i) => {
        const page = b.pages.get(q.ref);
        const r = needPages[i]!.c;
        if (!page) return;
        const better = bestLink(page.ticket, r.e.ticket);
        if (better && better !== r.e.ticket) {
          r.e.ticket = better;
          r.linkKind = better.kind;
          if (r.drop === 'no_link') r.drop = null;
        }
        if (page.start && !r.e.start) r.e.start = page.start;
      });
    } else log?.info('event_picks.tickets_skipped', { error_code: b.reason });
    scored = live.map(score);
  }

  const pickable = scored.filter((s) => s.c.drop === null);
  const chosen = choosePicks(pickable, maxPicks, profile, rng);
  const chosenIds = new Map(chosen.map((c, i) => [c.c.id, { ordinal: i + 1, wildcard: c.wildcard }]));
  const scoreOf = new Map(scored.map((s) => [s.c.id, s.parts]));
  const dropped: Record<string, number> = {};
  for (const r of rows) {
    const reason = chosenIds.has(r.id) ? null : (r.drop ?? 'not_chosen');
    if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
  }
  store.savePicks(
    db,
    run.id,
    rows.map((r) => {
      const c = chosenIds.get(r.id);
      return {
        id: r.id,
        ordinal: c?.ordinal ?? null,
        eventKey: r.eventKey,
        title: r.title,
        performers: r.performers,
        genres: r.genres,
        category: r.category,
        venue: r.venue,
        venueKey: r.venueKey,
        city: r.e.city,
        localDate: r.date,
        startTime: r.e.start,
        startsAt: startsAtOf(r.date, r.e.start, tz),
        ticketUrl: r.e.ticket?.url ?? null,
        ticketHost: r.e.ticket?.host ?? null,
        linkKind: r.e.ticket?.kind ?? null,
        sourceUrl: r.e.source?.url ?? null,
        why: r.e.why,
        parts: scoreOf.get(r.id) ?? null,
        wildcard: c?.wildcard ?? false,
        dropReason: c ? null : (r.drop ?? 'not_chosen'),
      };
    }),
    o.now,
  );
  const status = chosen.length ? 'ready' : 'empty';
  store.finishRun(db, run.id, {
    status,
    now: o.now,
    city: city.label,
    freeNights: free,
    searches,
    costUsd: cost,
    found: rows.length,
    dropped,
    error: chosen.length ? null : 'nothing_chosen',
  });
  log?.info('event_picks.picked', { counts: { found: rows.length, picked: chosen.length, searches, free_nights: free.length } });
  if (!chosen.length) return { status: 'empty', runId: run.id, reason: 'nothing_chosen', searches, costUsd: cost };
  const ready: RunResult = { status: 'ready', runId: run.id, picks: chosen.length, found: rows.length, searches, costUsd: cost, dropped };
  if (!o.send) return ready;
  const sent = await sendRun(db, deps, store.runForWeek(db, today)!, o);
  return sent.status === 'sent' || sent.status === 'ready' ? { ...ready, status: sent.status, ...(sent.status === 'ready' && sent.sendReason ? { sendReason: sent.sendReason } : {}) } : ready;
}

/** Sends a 'ready' run's texts (intro + one per pick). Idempotent: every text has a stable client ref. */
export async function sendRun(db: DB, deps: EventPicksDeps, run: store.RunRow, o: RunOptions): Promise<RunResult> {
  const picks = store.picksOfRun(db, run.id, { pickedOnly: true });
  const base = { runId: run.id, picks: picks.length, found: run.found, searches: run.searches, costUsd: run.cost_usd, dropped: JSON.parse(run.dropped) as Record<string, number> };
  if (!o.send) return { status: 'ready', ...base };
  if (!deps.outbound.configured) return { status: 'ready', ...base, sendReason: 'delivery_not_configured' };
  const tz = settingTimeZone(db);
  const p = localParts(o.now, tz);
  if (!o.force && (p.date !== run.week_start || p.hhmm >= SEND_UNTIL)) return { status: 'ready', ...base, sendReason: 'too_late' };
  const texts = picksTexts(
    picks.map(
      (p): PickText => ({
        id: p.id,
        ordinal: p.ordinal!,
        title: p.title,
        venue: p.venue,
        localDate: p.local_date,
        startTime: p.start_time,
        why: p.why,
        wildcard: p.wildcard === 1,
        hasLink: p.link_kind === 'ticket' || p.link_kind === 'resale',
      }),
    ),
    JSON.parse(run.free_nights) as string[],
  );
  const outboundIds: string[] = [];
  const pickOutbound = new Map<string, string>();
  for (const [i, text] of texts.entries()) {
    const r = await deps.outbound.sendToSelf(text, 'events', stableUuid(`events:${run.id}:${i}`));
    if (r.status === 'blocked' || r.status === 'disabled' || r.status === 'failed') {
      deps.log?.warn('event_picks.send_failed', { error_code: r.reason ?? r.status, counts: { part: i } });
      // Nothing more goes out of order; the next tick resumes (sent parts come back 'duplicate').
      if (outboundIds.length) store.markSent(db, run.id, { now: o.now, outboundIds, pickOutbound });
      db.prepare(`UPDATE event_pick_runs SET status = 'ready', updated_at = ? WHERE id = ?`).run(o.now, run.id);
      return { status: 'ready', ...base, sendReason: r.reason ?? r.status };
    }
    if (r.outboundId) {
      outboundIds.push(r.outboundId);
      if (i > 0) pickOutbound.set(picks[i - 1]!.id, r.outboundId);
    }
  }
  store.markSent(db, run.id, { now: o.now, outboundIds, pickOutbound });
  deps.log?.info('event_picks.sent', { counts: { texts: texts.length, picks: picks.length } });
  return { status: 'sent', ...base };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
