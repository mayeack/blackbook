/**
 * His "Recurring Events" calendar (owner request 2026-10-25: "Check my calendar 'Recurring events' for cool recurring
 * events happening that week"): weekly happenings he keeps as listings (jazz nights, comedy, night markets), not
 * plans (nights.ts isListing). Each week the run adds the best of them that fall when he is free:
 *
 *   which    timed instances in the window on a calendar whose name says "recurring" (LISTINGS.calendarName), that
 *            are listings (recurring, no invitees, not the primary calendar) and not cancelled;
 *   free     only on a free day (his evening is free, nights.ts: a busy day's email shows his plans instead); a
 *            daytime one (a weekend market) also needs LISTINGS.minFreeHours of it clear of plans and Partiful RSVPs
 *            (a 10–6 market with a 3 pm plan still has the morning);
 *   series   one instance per series (the earliest free one); a series shown in the last LISTINGS.cooldownDays that he
 *            didn't act on (no going, no tap) rests for a while, so the same jazz night isn't in every email;
 *   cool     scored like any pick (rank.ts scoreCandidate: taste, kind, learned), best first, at most
 *            LISTINGS.perDay a day (they take that day's first slots; web and newsletter picks fill the rest).
 * Rows here only ever go into his own email / texts (never into a prompt). Pure reader.
 */
import { addDays, localDate, localParts } from '@yb/shared';
import type { DB } from '../../db/connection';
import { venueKey } from '../../pipeline/occasions/text';
import { dayStart, HOUR } from '../common';
import { categoryFromTitle, type TicketCategory } from '../similarity';
import { linkKind, normalizeUrl, type LinkKind } from './links';
import { calendarPlans, EVENING, isListing, partifulSpans, type Night, type Span } from './nights';
import type { TasteProfile } from './profile';
import { scoreCandidate, type Candidate, type Learned, type Rng, type ScoreParts } from './rank';

export const LISTINGS = {
  /** Calendars whose name matches are read ("Recurring Events"). */
  calendarName: /\brecurring\b/i,
  max: 14,
  perDay: 2,
  /** A series shown this recently and not acted on rests. */
  cooldownDays: 21,
  /** No end time: assume this long. */
  defaultHours: 2,
  /** A daytime listing needs this much of it free (or all of it, when shorter). */
  minFreeHours: 2,
} as const;

export interface Listing extends Candidate {
  /** The series (recurring_event_id): local only. */
  seriesRef: string;
  startTime: string;
  startsAt: number;
  endsAt: number;
  /** The listing's own link (its description), checked like a web link; else null. */
  ticketUrl: string | null;
  ticketHost: string | null;
  /** The Google Calendar page of the entry. */
  sourceUrl: string | null;
}

export interface ChosenListing {
  l: Listing;
  parts: ScoreParts;
  why: string | null;
}

/** Music words the generic title rules don't cover ("Sofitel Jazz", "Sounds at the Georgian"). */
const MUSIC = /\b(?:jazz|blues|soul|funk|salsa|bossa|music|sounds|band|acoustic|unplugged|orchestra|quartet|trio|vinyl)\b/i;

/** The kind of happening from its title, else its venue ("Westside Comedy Theater"), else music words. */
export const listingCategory = (title: string, venue: string | null = null): TicketCategory =>
  categoryFromTitle(title) ?? (venue ? categoryFromTitle(venue) : null) ?? (MUSIC.test(title) ? 'concert' : 'other');

const URL_IN = /https:\/\/[^\s<>"')\]]+/i;

/** The first plain https link in a description (Google's HTML or plain text), checked and classified. */
export function listingLink(description: string | null): { url: string; host: string; kind: LinkKind } | null {
  const m = description ? URL_IN.exec(description.replace(/&amp;/g, '&')) : null;
  const url = m ? normalizeUrl(m[0]) : null;
  return url ? { url, host: new URL(url).hostname.replace(/^www\./, ''), kind: linkKind(url) } : null;
}

/**
 * "Example Hall, 12 Sample St, City" → "Example Hall"; an address keeps its street line. No location: the place a
 * title names after "@" or " at " ("Jazz @ Example Bar").
 */
export function listingVenue(location: string | null, title = ''): string {
  const first = (location ?? '').split(/[\n,;|]/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (first) return first.slice(0, 80);
  const named = /(?:\s@\s*|\sat\s+(?:the\s+)?)([^@]{2,60})$/i.exec(title)?.[1]?.trim();
  return named ?? '';
}

interface Row {
  id: string;
  recurring_event_id: string;
  summary: string | null;
  location: string | null;
  description: string | null;
  starts_at: number;
  ends_at: number | null;
  html_link: string | null;
  treatment: string;
  attendees: string | null;
  calendar_name: string;
}

/** Every listing instance on a Recurring Events calendar starting in [from, to). */
export function listingsBetween(db: DB, from: number, to: number, timeZone: string): Listing[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.recurring_event_id, e.summary, e.location, e.description, e.starts_at, e.ends_at, e.html_link, e.treatment, e.attendees,
              c.summary AS calendar_name
       FROM calendar_events_included e JOIN gcal_calendars c ON c.calendar_id = e.calendar_id
       WHERE c.is_primary = 0 AND c.removed_at IS NULL AND c.summary IS NOT NULL AND e.all_day = 0 AND e.status <> 'cancelled'
         AND e.recurring_event_id IS NOT NULL AND e.starts_at >= @from AND e.starts_at < @to
       ORDER BY e.starts_at`,
    )
    .all({ from, to }) as Row[];
  const out: Listing[] = [];
  for (const r of rows) {
    const title = r.summary?.replace(/\s+/g, ' ').trim();
    if (!title || !LISTINGS.calendarName.test(r.calendar_name) || !isListing(r)) continue;
    const venue = listingVenue(r.location, title);
    const link = listingLink(r.description);
    const html = r.html_link ? normalizeUrl(r.html_link) : null;
    const end = r.ends_at && r.ends_at > r.starts_at ? r.ends_at : r.starts_at + LISTINGS.defaultHours * HOUR;
    out.push({
      id: r.id,
      seriesRef: r.recurring_event_id.slice(0, 200),
      date: localDate(r.starts_at, timeZone),
      startTime: localParts(r.starts_at, timeZone).hhmm,
      startsAt: r.starts_at,
      endsAt: end,
      category: listingCategory(title, venue || null),
      performers: [],
      genres: [],
      venue: venue || '(unknown)',
      venueKey: venueKey(venue),
      title: title.slice(0, 140),
      linkKind: link?.kind ?? null,
      ticketUrl: link?.url ?? null,
      ticketHost: link?.host ?? null,
      sourceUrl: html,
    });
  }
  return out;
}

/** The longest stretch of [from, to) that none of the spans covers (ms). */
export function longestGap(spans: readonly Span[], from: number, to: number): number {
  let best = 0;
  let cursor = from;
  for (const s of [...spans].filter((x) => x.start < to && x.end > from).sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) best = Math.max(best, s.start - cursor);
    cursor = Math.max(cursor, s.end);
  }
  return Math.max(best, to - cursor);
}

/** Whether he is free for a listing: only on a free day, and a daytime one also needs enough clear time. */
export function listingFree(db: DB, l: Pick<Listing, 'date' | 'startsAt' | 'endsAt'>, nights: readonly Night[], timeZone: string): boolean {
  const night = nights.find((n) => n.date === l.date);
  if (!night?.free) return false;
  const evening = dayStart(l.date, timeZone) + EVENING.fromHour * HOUR;
  if (l.endsAt > evening) return true;
  const busy = [...calendarPlans(db, l.startsAt, l.endsAt), ...partifulSpans(db, l.startsAt, l.endsAt)];
  return longestGap(busy, l.startsAt, l.endsAt) >= Math.min(LISTINGS.minFreeHours * HOUR, l.endsAt - l.startsAt);
}

/** Series that rest this week: shown in the last cooldownDays, not gone to, never tapped. */
export function restingSeries(db: DB, today: string, exceptRunId: string): Set<string> {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT source_ref FROM event_picks
         WHERE source = 'calendar' AND ordinal IS NOT NULL AND source_ref IS NOT NULL AND run_id <> ? AND local_date >= ?
         GROUP BY source_ref HAVING sum(status = 'going') = 0 AND sum(clicks) = 0`,
      )
      .pluck()
      .all(exceptRunId, addDays(today, -LISTINGS.cooldownDays)) as string[],
  );
}

/** A short second-person reason from the score, or null when nothing stands out. */
export function listingWhy(parts: ScoreParts): string | null {
  if (parts.taste >= 0.45) return 'Close to what you usually go to.';
  if (parts.learned >= 0.65) return 'You liked picks like this before.';
  if (parts.kind >= 0.8) return 'Your kind of night out.';
  return null;
}

export interface ChooseListingsInput {
  nights: readonly Night[];
  first: string;
  days: number;
  timeZone: string;
  profile: TasteProfile;
  learned: Learned;
  rng: Rng;
  runId: string;
  max?: number;
}

/** The week's listings worth a line, best first (see the header). */
export function chooseListings(db: DB, i: ChooseListingsInput): ChosenListing[] {
  const from = dayStart(i.first, i.timeZone);
  const to = dayStart(addDays(i.first, i.days), i.timeZone);
  const resting = restingSeries(db, i.first, i.runId);
  const all = listingsBetween(db, from, to, i.timeZone).filter((l) => l.date >= i.first && l.date < addDays(i.first, i.days));
  const firstFree = new Map<string, Listing>();
  for (const l of all) {
    if (resting.has(l.seriesRef) || firstFree.has(l.seriesRef)) continue;
    if (listingFree(db, l, i.nights, i.timeZone)) firstFree.set(l.seriesRef, l);
  }
  const scored = [...firstFree.values()]
    .map((l) => ({ l, parts: scoreCandidate(l, i.profile, i.learned, i.rng) }))
    .sort((a, b) => b.parts.score - a.parts.score || a.l.startsAt - b.l.startsAt);
  const out: ChosenListing[] = [];
  for (const s of scored) {
    if (out.length >= (i.max ?? LISTINGS.max)) break;
    if (out.filter((x) => x.l.date === s.l.date).length >= LISTINGS.perDay) continue;
    out.push({ ...s, why: listingWhy(s.parts) });
  }
  return out.sort((a, b) => a.l.startsAt - b.l.startsAt);
}
