/**
 * The weekly event-picks run (design docs/design/event-picks.md; job 'event-picks' in jobs.ts). On the picks day
 * (settings events.weekday / events.time; default Sunday 18:00) for the 7 nights of the week ahead (firstNight: an
 * evening send covers the next seven nights, Monday to Sunday; an earlier one starts that night):
 *
 *   1. outcomes     refresh which earlier picks he went to (outcomes.ts), so this week learns from last week;
 *   2. nights       which of the 7 nights are free (nights.ts); none → run 'empty', nothing is searched or sent;
 *   3. taste        the profile (profile.ts) and the city (events.city, else the home city: travel.home_city or his
 *                   location fact);
 *   4. search       web candidates (discover.ts, ~40% of events.max_searches);
 *   5. newsletters  events in the past week's event newsletters in Gmail (newsletters.ts; events.newsletters, the
 *                   read-only grant): one more Haiku call, source 'newsletter';
 *   6. filter       each candidate must be on a free night of the window and name a venue; one row per real event
 *                   (eventKey); never an event sent in an earlier week; not one already on his Recurring Events
 *                   calendar (its ticket link goes to that listing instead). Dropped rows are kept with the reason;
 *   7. score        rank.ts (taste, kind, learned, link);
 *   8. tickets      one targeted search per top candidate still without its own ticket page (the rest of the budget);
 *   9. choose       rank.ts choosePicks (≤ events.max_picks, 🎲 wildcard at ε), then the best Recurring Events
 *                   listings that fall when he's free (listings.ts; events.listings), numbered after the picks;
 *  10. send         events.channel 'email' (default): one email to his own Gmail (email.ts, delivery/email.ts;
 *                   email_state 'sending' is written first, so a crash mid-call never sends twice). Not connected,
 *                   or Gmail refused it → texts, with a line saying why. A failure worth retrying waits for the next
 *                   tick until LAST_EMAIL_TRY. 'text': one text per pick (compose.ts) to his own handle, purpose
 *                   'events', stable client refs, so a retry never double-sends. Delivery not configured, or quiet
 *                   hours → the run stays 'ready' (the web shows it) and a later tick sends it the same day.
 * A failed web discovery (API error, budget, unreadable answer) is retried every RETRY_AFTER_MS, at most MAX_ATTEMPTS
 * times a week; the last attempt goes on with the newsletters and listings alone. Costs: two web_search calls
 * (≤ events.max_searches × $0.01 + tokens), one newsletter read, rarely a third structured call.
 */
import { addDays, localDate, localParts } from '@yb/shared';
import type { GmailApi } from '../../adapters/gmail/api';
import type { DB } from '../../db/connection';
import type { EmailSender } from '../../delivery/email';
import { stableUuid } from '../../delivery/text';
import type { OutboundSender } from '../../delivery/types';
import type { Egress, LlmClient } from '../../llm/types';
import type { Logger } from '../../ops/logger';
import { readSetting, settingTimeZone } from '../../settings/registry';
import { DAY, dayStart, HOUR } from '../common';
import { METROS } from '../places';
import { homePlace } from '../trips';
import { venueKey as venueKeyOf } from '../../pipeline/occasions/text';
import { features } from '../similarity';
import { picksTexts, type PickText } from './compose';
import { bestLink, eventKey, findTicketPages, searchCandidates, type CheckedEvent, type SearchSetup, type TicketQuery } from './discover';
import { HOW_LABEL, picksEmail, type EmailPick, type LastWeek } from './email';
import type { CheckedLink } from './links';
import { chooseListings, listingsBetween, type Listing } from './listings';
import { newsletterEvents, readNewsletters, type NewsletterEvent } from './newsletters';
import { nightsOf } from './nights';
import { sameEvent, updatePickOutcomes } from './outcomes';
import { tasteProfile } from './profile';
import { choosePicks, scoreCandidate, learnFrom, seededRng, type Candidate, type PickSource, type Scored } from './rank';
import * as store from './store';

export const WINDOW_DAYS = 7;
export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 30 * 60_000;
/** Nothing is sent after this local time on the picks day (quiet hours start at 22:00 by default). */
export const SEND_UNTIL = '21:00';
/** From here on an email failure worth retrying falls back to texts instead of waiting for the next tick. */
export const LAST_EMAIL_TRY = '20:30';
/** Picks sent at or after this local time cover the next seven nights instead of starting that night. */
export const EVENING_SEND = '16:00';

/** Ends the intro text when the picks were meant to go by email. */
export const EMAIL_NOTES = {
  notConnected: 'To get these by email, connect “Email me” in Settings → Email & photos.',
  failed: 'The email didn’t go through, so here they are by text. Check “Email me” in Settings → Email & photos.',
} as const;
/** Learning looks back this far. */
const LEARN_DAYS = 365;

export interface EventPicksDeps {
  llm: LlmClient;
  egress: Egress;
  outbound: OutboundSender;
  /** His own Gmail for the weekly email (absent / unconfigured = texts). */
  email?: EmailSender;
  /** Read-only Gmail for newsletters (absent, or null = not connected: none read). */
  gmail?: () => GmailApi | null;
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
  | {
      status: 'ready' | 'sent';
      runId: string;
      picks: number;
      found: number;
      searches: number;
      costUsd: number;
      dropped: Record<string, number>;
      newsletters?: number;
      listings?: number;
      channel?: 'email' | 'text';
      sendReason?: string;
    };

/** The first night a send on `sendDay` at `time` covers (see the header). */
export const firstNight = (sendDay: string, time: string): string => (time >= EVENING_SEND ? addDays(sendDay, 1) : sendDay);

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
  source: PickSource;
  sourceRef: string | null;
}

/** A web / newsletter candidate that is one of his calendar listings that day (he already knows it's on). */
function listingFor(r: Pick<Row, 'date' | 'title' | 'venue'>, listings: readonly Listing[]): Listing | null {
  for (const l of listings) {
    if (l.date !== r.date) continue;
    if (sameEvent(features({ category: l.category, venue: l.venue, venueKey: l.venueKey, titles: [l.title] }), r.title, r.venue)) return l;
  }
  return null;
}

export async function runEventPicks(db: DB, deps: EventPicksDeps, o: RunOptions): Promise<RunResult> {
  if (!o.force && !picksDue(db, o.now)) return { status: 'skipped', reason: 'not_due' };
  const tz = settingTimeZone(db);
  const today = firstNight(localDate(o.now, tz), readSetting(db, 'events.time'));
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
    log?.warn('event_picks.search_failed', { error_code: a.reason, counts: { searches, attempt: run.attempts } });
    // Retried later; the week's last attempt goes on with the newsletters and the calendar.
    if (run.attempts < MAX_ATTEMPTS) {
      store.finishRun(db, run.id, { status: 'failed', now: o.now, city: city.label, freeNights: free, searches, costUsd: cost, error: a.reason });
      return { status: 'failed', runId: run.id, reason: a.reason, searches, costUsd: cost };
    }
  }
  const webEvents = a.status === 'ok' ? a.events : [];

  // Newsletters (read-only Gmail): one Haiku call over the past week's event newsletters.
  let newsletterCount = 0;
  let fromNewsletters: NewsletterEvent[] = [];
  const gmail = readSetting(db, 'events.newsletters') ? (deps.gmail?.() ?? null) : null;
  if (gmail) {
    try {
      const read = await readNewsletters(db, gmail, { now: o.now, signal: deps.signal });
      newsletterCount = read.newsletters.length;
      if (read.newsletters.length) {
        const n = await newsletterEvents(sdeps, profile, setup, read.newsletters);
        cost += n.usage?.costUsd ?? 0;
        if (n.status === 'ok') fromNewsletters = n.events;
        else log?.info('event_picks.newsletters_skipped', { error_code: n.reason });
      }
    } catch (e) {
      log?.warn('event_picks.newsletters_failed', { error_class: e instanceof Error ? e.name : 'unknown' });
    }
  }
  const windowFrom = dayStart(today, tz);
  const listingsOn = readSetting(db, 'events.listings');
  const weekListings = listingsOn ? listingsBetween(db, windowFrom, dayStart(addDays(today, WINDOW_DAYS), tz), tz) : [];
  const listingLinks = new Map<string, CheckedLink>();

  // Filter and dedupe (rows are kept with the reason).
  const freeSet = new Set(free);
  const windowEnd = addDays(today, WINDOW_DAYS - 1);
  const earlier = store.sentKeys(db, run.id);
  const seen = new Set<string>();
  const rows: Row[] = [];
  const found: { e: CheckedEvent; source: PickSource; sourceRef: string | null }[] = [
    ...webEvents.map((e) => ({ e, source: 'web' as const, sourceRef: null })),
    ...fromNewsletters.map((e) => ({ e, source: 'newsletter' as const, sourceRef: e.newsletterId })),
  ];
  for (const { e, source, sourceRef } of found) {
    const venue = e.venue?.trim() ?? '';
    const key = eventKey({ date: e.date, venue, title: e.title });
    let drop: string | null = null;
    const listing = weekListings.length ? listingFor({ date: e.date, title: e.title, venue }, weekListings) : null;
    if (e.date < today || e.date > windowEnd) drop = 'outside_window';
    else if (!freeSet.has(e.date)) drop = 'busy_night';
    else if (!venue || /^(?:tba|tbd|secret|undisclosed|unknown|various|n\/a|none|venue)\b/i.test(venue)) drop = 'no_venue';
    else if (e.category === 'party' || e.category === 'member_event') drop = 'not_public';
    else if (seen.has(key)) drop = 'duplicate';
    else if (earlier.has(key)) drop = 'picked_before';
    else if (listing) {
      drop = 'on_calendar';
      const k = `${listing.seriesRef}|${listing.date}`;
      if (e.ticket && !listingLinks.has(k)) listingLinks.set(k, e.ticket);
    }
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
      source,
      sourceRef,
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
  // The best Recurring Events listings when he's free, numbered after the picks; a web / newsletter twin's ticket link
  // goes to its listing when the calendar entry has none.
  const listings = listingsOn ? chooseListings(db, { nights, first: today, days: WINDOW_DAYS, timeZone: tz, profile, learned, rng, runId: run.id }) : [];
  for (const x of listings) {
    const link = listingLinks.get(`${x.l.seriesRef}|${x.l.date}`);
    if (link && x.l.linkKind !== 'ticket' && x.l.linkKind !== 'resale') {
      x.l.ticketUrl = link.url;
      x.l.ticketHost = link.host;
      x.l.linkKind = link.kind;
    }
  }
  const scoreOf = new Map(scored.map((s) => [s.c.id, s.parts]));
  const dropped: Record<string, number> = {};
  for (const r of rows) {
    const reason = chosenIds.has(r.id) ? null : (r.drop ?? 'not_chosen');
    if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
  }
  store.savePicks(
    db,
    run.id,
    [
      ...rows.map((r): store.NewPick => {
      const c = chosenIds.get(r.id);
      return {
        id: r.id,
        ordinal: c?.ordinal ?? null,
        eventKey: r.eventKey,
        source: r.source,
        sourceRef: r.sourceRef,
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
      ...listings.map(
        ({ l, parts, why }, i): store.NewPick => ({
          id: store.newPickId(),
          ordinal: chosen.length + i + 1,
          eventKey: eventKey({ date: l.date, venue: l.venue, title: l.title }),
          source: 'calendar',
          sourceRef: l.seriesRef,
          title: l.title,
          performers: [],
          genres: [],
          category: l.category,
          venue: l.venue,
          venueKey: l.venueKey,
          city: null,
          localDate: l.date,
          startTime: l.startTime,
          startsAt: l.startsAt,
          ticketUrl: l.ticketUrl,
          ticketHost: l.ticketHost,
          linkKind: l.linkKind,
          sourceUrl: l.sourceUrl,
          why,
          parts,
          wildcard: false,
          dropReason: null,
        }),
      ),
    ],
    o.now,
  );
  const total = chosen.length + listings.length;
  const status = total ? 'ready' : 'empty';
  store.finishRun(db, run.id, {
    status,
    now: o.now,
    city: city.label,
    freeNights: free,
    searches,
    costUsd: cost,
    found: rows.length,
    dropped,
    newsletters: newsletterCount,
    listings: listings.length,
    error: total ? null : a.status === 'failed' ? a.reason : 'nothing_chosen',
  });
  log?.info('event_picks.picked', {
    counts: { found: rows.length, picked: chosen.length, listings: listings.length, newsletters: newsletterCount, searches, free_nights: free.length },
  });
  if (!total) return { status: 'empty', runId: run.id, reason: 'nothing_chosen', searches, costUsd: cost };
  const ready: RunResult = {
    status: 'ready',
    runId: run.id,
    picks: total,
    found: rows.length,
    searches,
    costUsd: cost,
    dropped,
    newsletters: newsletterCount,
    listings: listings.length,
  };
  if (!o.send) return ready;
  const sent = await sendRun(db, deps, store.runForWeek(db, today)!, o);
  return sent.status === 'sent' || sent.status === 'ready'
    ? { ...ready, status: sent.status, ...(sent.channel ? { channel: sent.channel } : {}), ...(sent.status === 'ready' && sent.sendReason ? { sendReason: sent.sendReason } : {}) }
    : ready;
}

const jsonList = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** What last week's picks taught, for the email's "Last week" line. */
export function lastWeekOf(db: DB, weekStart: string): LastWeek | null {
  const prev = store.previousSentRun(db, weekStart);
  if (!prev) return null;
  const picks = store.picksOfRun(db, prev.id, { pickedOnly: true });
  return {
    sent: picks.length,
    went: picks.filter((p) => p.status === 'going').map((p) => ({ title: p.title, how: HOW_LABEL[p.outcome_source ?? ''] ?? null })),
    tapped: picks.filter((p) => p.status !== 'going' && p.clicks > 0).length,
    notForMe: picks.filter((p) => p.status === 'not_for_me').length,
  };
}

const emailPick = (p: store.PickRow): EmailPick => ({
  id: p.id,
  title: p.title,
  venue: p.venue,
  localDate: p.local_date,
  startTime: p.start_time,
  why: p.why,
  wildcard: p.wildcard === 1,
  hasLink: p.link_kind === 'ticket' || p.link_kind === 'resale',
  ticketHost: p.link_kind === 'ticket' || p.link_kind === 'resale' ? p.ticket_host : null,
  source: p.source,
});

/** Emails a 'ready' run (see the header, step 10): 'sent', 'retry' (wait for the next tick) or 'fallback' (texts). */
async function emailRun(
  db: DB,
  deps: EventPicksDeps,
  run: store.RunRow,
  picks: readonly store.PickRow[],
  o: RunOptions & { lastChance: boolean },
): Promise<{ outcome: 'sent' } | { outcome: 'retry'; reason: string } | { outcome: 'fallback'; note: string }> {
  // A send that may have gone out (the process stopped mid-call) is never repeated.
  if (run.email_state === 'sending' || run.email_state === 'sent') {
    store.markEmail(db, run.id, 'sent', { now: o.now });
    deps.log?.warn('event_picks.email_unconfirmed', { counts: { picks: picks.length } });
    return { outcome: 'sent' };
  }
  if (!deps.email?.configured) return { outcome: 'fallback', note: EMAIL_NOTES.notConnected };
  const message = picksEmail({
    weekStart: run.week_start,
    windowEnd: run.window_end,
    freeNights: jsonList(run.free_nights),
    picks: picks.filter((p) => p.source !== 'calendar').map(emailPick),
    listings: picks.filter((p) => p.source === 'calendar').map(emailPick),
    lastWeek: lastWeekOf(db, run.week_start),
  });
  store.markEmail(db, run.id, 'sending', { now: o.now });
  const r = await deps.email.sendToSelf(message, { signal: deps.signal, now: o.now });
  if (r.status === 'sent') {
    store.markEmail(db, run.id, 'sent', { now: o.now, emailId: r.messageId });
    deps.log?.info('event_picks.emailed', { counts: { picks: picks.length } });
    return { outcome: 'sent' };
  }
  store.markEmail(db, run.id, 'failed', { now: o.now });
  if (r.status === 'failed' && r.retryable && !o.lastChance && !o.force) return { outcome: 'retry', reason: `email_${r.reason}` };
  return { outcome: 'fallback', note: r.status === 'disabled' ? EMAIL_NOTES.notConnected : EMAIL_NOTES.failed };
}

/**
 * Sends a 'ready' run: the email (events.channel 'email' and connected), else the texts (intro + one per pick).
 * Idempotent: the email's state is written before the call; every text has a stable client ref.
 */
export async function sendRun(db: DB, deps: EventPicksDeps, run: store.RunRow, o: RunOptions): Promise<RunResult> {
  const picks = store.picksOfRun(db, run.id, { pickedOnly: true });
  const base = {
    runId: run.id,
    picks: picks.length,
    found: run.found,
    searches: run.searches,
    costUsd: run.cost_usd,
    dropped: JSON.parse(run.dropped) as Record<string, number>,
    newsletters: run.newsletters,
    listings: run.listings,
  };
  if (!o.send) return { status: 'ready', ...base };
  const tz = settingTimeZone(db);
  const p = localParts(o.now, tz);
  if (!o.force && (firstNight(p.date, readSetting(db, 'events.time')) !== run.week_start || p.hhmm >= SEND_UNTIL)) return { status: 'ready', ...base, sendReason: 'too_late' };
  let note: string | null = null;
  if (readSetting(db, 'events.channel') === 'email') {
    const e = await emailRun(db, deps, run, picks, { ...o, lastChance: p.hhmm >= LAST_EMAIL_TRY });
    if (e.outcome === 'sent') return { status: 'sent', ...base, channel: 'email' };
    if (e.outcome === 'retry') return { status: 'ready', ...base, sendReason: e.reason };
    note = e.note;
  }
  if (!deps.outbound.configured) return { status: 'ready', ...base, sendReason: 'delivery_not_configured' };
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
        source: p.source,
      }),
    ),
    jsonList(run.free_nights),
    note,
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
  store.markSent(db, run.id, { now: o.now, outboundIds, pickOutbound, channel: 'text' });
  deps.log?.info('event_picks.sent', { counts: { texts: texts.length, picks: picks.length } });
  return { status: 'sent', ...base, channel: 'text' };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
