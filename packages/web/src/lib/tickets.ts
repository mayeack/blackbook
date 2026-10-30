/**
 * Pure helpers for the Tickets screen and the person page's "Met at" (routes/tickets.ts, routes/personExtras.ts;
 * shapes in @yb/shared api/tickets.ts and api/person.ts). Unit-tested; no React here.
 */
import type { MetAtLink, MetAtList, TicketItem } from '@yb/shared';
import { eventPath } from './events';
import { date, percent, plural, span } from './format';
import { metSignalLabel, ticketCategoryLabel } from './labels';

export type TicketsWhen = 'upcoming' | 'past';

/** `?when=past` → past, anything else upcoming. */
export const ticketsWhen = (params: URLSearchParams): TicketsWhen => (params.get('when') === 'past' ? 'past' : 'upcoming');

/** "Sat, Oct 18, 8:00 – 11:00 PM". */
export function ticketWhen(t: Pick<TicketItem, 'startsAt' | 'endsAt'>, now = Date.now()): string {
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(t.startsAt);
  return `${weekday}, ${span(t.startsAt, t.endsAt, now)}`;
}

/** "Venue · City" (either may be missing), or null. */
export function ticketPlace(t: Pick<TicketItem, 'venue' | 'city'>): string | null {
  const parts = [t.venue, t.city].filter((x): x is string => !!x && x.trim() !== '');
  // A venue string that already names the city ("Hall, Springfield") doesn't repeat it.
  if (parts.length === 2 && parts[0]!.toLowerCase().includes(parts[1]!.toLowerCase())) return parts[0]!;
  return parts.length ? parts.join(' · ') : null;
}

/** The headline count for the ticket's status: "You hold 2", "Sold", "Count unknown". */
function heldText(t: Pick<TicketItem, 'status' | 'held'>): string | null {
  switch (t.status) {
    case 'holding':
      return t.held == null ? 'Holding (count unknown)' : t.held > 0 ? `You hold ${plural(t.held, 'ticket')}` : 'Holding';
    case 'gave_away':
      return 'All given away';
    case 'sold':
      return 'All sold';
    case 'refunded':
      return 'Refunded';
    case 'cancelled':
      return 'Event cancelled';
    case 'unconfirmed':
      return 'No ticket confirmation found';
  }
}

/** "You hold 2 · bought 4 · sent 2": the status's count, then every non-zero flow. */
export function ticketCountsLine(t: Pick<TicketItem, 'status' | 'held' | 'quantities'>): string {
  const q = t.quantities;
  const flows = [
    q.bought ? `bought ${q.bought}` : null,
    q.received ? `received ${q.received}` : null,
    q.sent ? `sent ${q.sent}` : null,
    q.sold ? `sold ${q.sold}` : null,
    q.refunded ? `refunded ${q.refunded}` : null,
  ].filter((x): x is string => x != null);
  return [heldText(t), ...flows].filter(Boolean).join(' · ');
}

/** "Concert · house, techno": the category and up to three inferred genres (a ticket's, or an event pick's). */
export function ticketKindLine(t: { category: string; genres: readonly string[] }): string {
  const genres = t.genres.slice(0, 3).join(', ');
  return genres ? `${ticketCategoryLabel(t.category)} · ${genres}` : ticketCategoryLabel(t.category);
}

/** Performers worth a line: not when the title already is the only performer. */
export function performersLine(t: Pick<TicketItem, 'title' | 'performers'>, max = 4): string | null {
  const list = t.performers.filter((p) => p.trim() && p.trim().toLowerCase() !== t.title.trim().toLowerCase());
  if (!list.length) return null;
  const shown = list.slice(0, max).join(', ');
  return list.length > max ? `${shown} +${list.length - max}` : shown;
}

/** The get-together page the ticket feeds, when there is a live one. */
export const ticketHref = (t: Pick<TicketItem, 'occasionId'>): string | null => (t.occasionId ? eventPath(t.occasionId) : null);

/** Pages joined in order, a ticket that moved between pages kept once (its first place). */
export function flattenTickets(pages: readonly { items: TicketItem[] }[]): TicketItem[] {
  const seen = new Set<string>();
  const out: TicketItem[] = [];
  for (const p of pages)
    for (const t of p.items) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  return out;
}

// ---------------------------------------------------------------------------------------------- met at

/** "Met at Neon Nights · Oct 18 · via an Instagram follow". */
export function metAtLine(l: Pick<MetAtLink, 'title' | 'startsAt' | 'signal'>, now = Date.now()): string {
  return `Met at ${l.title ?? 'an event'} · ${date(l.startsAt, now)} · via ${metSignalLabel(l.signal)}`;
}

/** "82% sure · connected Oct 19" (+ " · screenshot" when the owner screenshotted their contact info). */
export function metAtDetail(l: Pick<MetAtLink, 'confidence' | 'signalAt' | 'screenshot'>, now = Date.now()): string {
  const parts = [`${percent(l.confidence)} sure`, `connected ${date(l.signalAt, now)}`];
  if (l.screenshot) parts.push('you saved their contact');
  return parts.join(' · ');
}

/** The person header's line, "Met at {event} · {date} · via {signal}": the first (earliest) link, or null. */
export function metAtHeader(
  list: Pick<MetAtList, 'links'> | null | undefined,
  now = Date.now(),
): { title: string; when: string; via: string; href: string } | null {
  const l = list?.links[0];
  if (!l) return null;
  return { title: l.title ?? 'an event', when: date(l.startsAt, now), via: metSignalLabel(l.signal), href: l.href };
}
