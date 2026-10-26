/**
 * Pure helpers for the weekly Event picks screen (routes/eventPicks.ts; shapes in @yb/shared api/eventPicks.ts):
 * the week line, each card's meta, status pill, ticket link and which answers it offers, and the history footer.
 * Unit-tested in test/picks.test.ts; no React here.
 */
import type { EventPickItem, EventPicksResponse, EventPicksWeek } from '@yb/shared';
import { plural } from './format';

/** Local midnight of a `YYYY-MM-DD` date, plus `HH:MM` when given (ms). */
export function localDayMs(ymd: string, hhmm: string | null = null): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const [h, min] = hhmm ? (hhmm.split(':').map(Number) as [number, number]) : [0, 0];
  return new Date(y, m - 1, d, h, min).getTime();
}

/** "10pm", "7:30pm" (12-hour locales) or "22:00" (24-hour ones) from `HH:MM`. */
export function pickTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const f = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  if (f.resolvedOptions().hour12 === false) return f.format(new Date(2000, 0, 1, h, m));
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** "Week of Mon, Oct 26 · Springfield · 3 free nights · sent". */
export function weekLine(w: Pick<EventPicksWeek, 'weekStart' | 'city' | 'freeNights' | 'status'>): string {
  const start = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(localDayMs(w.weekStart));
  const parts = [`Week of ${start}`, w.city?.trim() || null, plural(w.freeNights.length, 'free night'), w.status === 'sent' ? 'sent' : null];
  return parts.filter(Boolean).join(' · ');
}

/** "Example Hall · 10pm" (either may be missing). */
export function pickMeta(p: Pick<EventPickItem, 'venue' | 'startTime'>): string {
  return [p.venue.trim() || null, p.startTime ? pickTime(p.startTime) : null].filter(Boolean).join(' · ');
}

/** Picks in the order the text listed them. */
export const sortPicks = (picks: readonly EventPickItem[]): EventPickItem[] => [...picks].sort((a, b) => a.ordinal - b.ordinal);

const FOUND_VIA: Partial<Record<NonNullable<EventPickItem['outcomeSource']>, string>> = {
  ticket: 'found your ticket',
  calendar: 'on your calendar',
  partiful: 'Partiful RSVP',
};

/** The status pill; none while the pick is still open. "Going · found your ticket" when yeackbot noticed it. */
export function pickStatus(p: Pick<EventPickItem, 'status' | 'outcomeSource'>): { label: string; tone: 'ok' | 'neutral' } | null {
  switch (p.status) {
    case 'picked':
      return null;
    case 'going': {
      const via = p.outcomeSource ? FOUND_VIA[p.outcomeSource] : undefined;
      return { label: via ? `Going · ${via}` : 'Going', tone: 'ok' };
    }
    case 'not_for_me':
      return { label: 'Not for me', tone: 'neutral' };
    case 'passed':
      return { label: 'Passed', tone: 'neutral' };
  }
}

/**
 * The card's primary link: /go/<id> (an Express route outside the SPA that counts the tap and redirects to the checked
 * ticket page), never the ticket URL itself. Null when the pick has no link.
 */
export function pickLink(p: Pick<EventPickItem, 'id' | 'linkKind' | 'ticketHost'>): { href: string; label: string } | null {
  const href = `/go/${encodeURIComponent(p.id)}`;
  if (p.linkKind === 'ticket' || p.linkKind === 'resale') return { href, label: p.ticketHost ? `Get tickets on ${p.ticketHost}` : 'Get tickets' };
  if (p.linkKind === 'listing') return { href, label: 'See listing' };
  return null;
}

/** Which answers a card offers: going / not for me while unanswered, Undo only for the owner's own answer. */
export function pickActions(p: Pick<EventPickItem, 'status' | 'outcomeSource'>): { answer: boolean; undo: boolean } {
  return { answer: p.status === 'picked' || p.status === 'passed', undo: p.outcomeSource === 'owner' };
}

/** "So far: 3 went · 1 not for me · 2 passed" (zero parts left out), or null before any answer. */
export function historyLine(h: EventPicksResponse['history']): string | null {
  const parts = [h.going ? `${h.going} went` : null, h.notForMe ? `${h.notForMe} not for me` : null, h.passed ? `${h.passed} passed` : null].filter(Boolean);
  return parts.length ? `So far: ${parts.join(' · ')}` : null;
}

/** Puts the server's updated pick into a cached response (the feedback POST answers with it). */
export function withPick(res: EventPicksResponse, item: EventPickItem): EventPicksResponse {
  if (!res.week) return res;
  return { ...res, week: { ...res.week, picks: res.week.picks.map((p) => (p.id === item.id ? item : p)) } };
}
