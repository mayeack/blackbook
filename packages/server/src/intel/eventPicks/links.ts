/**
 * Ticket links for event picks (design docs/design/event-picks.md §4). The model's answer is untrusted text and the
 * web is untrusted content, so a URL is only ever kept when it is exactly (after light normalization) a page the
 * web_search tool returned in the same call — never one the model wrote itself — and is plain https on a named
 * host. It is then classified:
 *
 *   ticket    one event's own page on a ticketing site or a venue / promoter site (dice.fm/event/…, ra.co/events/123,
 *             ticketmaster …/event/…, eventbrite.com/e/…, a venue's /events/<slug>);
 *   resale    one event's page on a resale marketplace (StubHub, Vivid Seats, SeatGeek …): real, but marked up;
 *   listing   a city / genre / "this week" listing, a search page or an encyclopedia — not a place to buy.
 *
 * Pure functions.
 */

export type LinkKind = 'ticket' | 'resale' | 'listing';

export interface CheckedLink {
  url: string;
  host: string;
  kind: LinkKind;
}

const RESALE_HOSTS = ['stubhub.com', 'vividseats.com', 'seatgeek.com', 'tickpick.com', 'gametime.co', 'eventticketscenter.com', 'ticketnetwork.com', 'tixel.com', 'viagogo.com', 'megaseats.com', 'ticketsmarter.com', 'rateyourseats.com'];

/** Hosts that are never a place to buy tickets (encyclopedias, social networks, news, aggregators of listings). */
const NEVER_TICKET_HOSTS = [
  'wikipedia.org',
  'reddit.com',
  'instagram.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'youtube.com',
  'songkick.com',
  'jambase.com',
  'bandsintown.com',
  'timeout.com',
  'discoverlosangeles.com',
  'musicfestivalwizard.com',
  'grooveist.com',
  'onestowatch.com',
  'comedycalendar.com',
  'standupdates.com',
];

/** Paths that list many events (a city, a genre, a week, a search) rather than one. */
const LISTING_PATH =
  /\/(?:browse|discover|search|cities|city|metro-areas|genre|genres|guides?|guides-[a-z-]+|calendar|things-to-do|whats-on|this-week|tonight|bundles|collections|d|lp|explore|category|categories|tag|tags|venue|venues|artist|artists|performers?)(?:\/|$|\?)/i;

/** A path segment that introduces one event ("/event/<id or slug>"). */
const EVENT_SEGMENT = /^(?:event|events|e|ev|show|shows|tickets?|performance|performances|concert|concerts|p|purchase|buy|order|listing|production|productions)$/i;

/**
 * One event's page: an event segment followed by an id or a long slug (a digit, or 3+ hyphens: "/events/2505104",
 * "/event/abc123-sample-band-29th-oct-…", "/events/sample-warehouse-night-example-city" — but not "/events/us/examplecity",
 * "/events/example-city-ca" or a day's listing "/events/2026/10/29"); or a long number anywhere ("/…/8121864/t"); or a "-tickets" slug.
 */
function isEventPath(path: string): boolean {
  // "/events/2026/10/29": one day's listing, not an event.
  if (/\/(?:19|20)\d\d\/\d{1,2}(?:\/\d{1,2})?$/.test(path)) return false;
  const segs = path.split('/').filter(Boolean);
  for (let i = 0; i < segs.length - 1; i++) {
    const next = decodeURIComponent(segs[i + 1]!);
    if (EVENT_SEGMENT.test(segs[i]!) && (/\d/.test(next) || (next.match(/-/g)?.length ?? 0) >= 3)) return true;
  }
  return /\/\d{5,}(?:[/?]|$)/.test(path) || /-tickets?(?:-|\/|$)/i.test(path);
}

const hostOf = (u: URL): string => u.hostname.toLowerCase().replace(/^www\./, '');
const onHost = (host: string, list: readonly string[]): boolean => list.some((h) => host === h || host.endsWith(`.${h}`));

/** The comparable form of a URL: https, lowercase host without www., no fragment, no trailing slash, no tracking params. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = hostOf(u);
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return null; // no IP literals, no single labels
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid|mc_|ref$|ref_)/i.test(k)) u.searchParams.delete(k);
  const path = u.pathname.replace(/\/+$/, '') || '';
  const q = u.searchParams.toString();
  return `https://${host}${path}${q ? `?${q}` : ''}`;
}

/** The kind of page a (normalized) URL is. */
export function linkKind(url: string): LinkKind {
  const u = new URL(url);
  const host = hostOf(u);
  if (onHost(host, NEVER_TICKET_HOSTS)) return 'listing';
  const path = u.pathname;
  if (path === '' || path === '/') return 'listing';
  const listing = LISTING_PATH.test(path) && !/\/(?:event|e|tickets?)\/[^/]+/i.test(path);
  if (listing) return 'listing';
  const resale = onHost(host, RESALE_HOSTS);
  // ra.co/events/2505104, dice.fm/event/xegvke-…, eventbrite.com/e/…-1995064286988, livenation.com/event/…
  if (isEventPath(path)) return resale ? 'resale' : 'ticket';
  return 'listing';
}

/** Index of the result pages a search call returned: normalized URL → the URL as returned. */
export function resultIndex(urls: Iterable<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of urls) {
    const n = normalizeUrl(raw);
    if (n && !m.has(n)) m.set(n, raw);
  }
  return m;
}

/** A URL from the model's answer, kept only when a search returned that page; null otherwise. */
export function checkLink(raw: string | null | undefined, results: ReadonlyMap<string, string>): CheckedLink | null {
  if (!raw) return null;
  const n = normalizeUrl(raw);
  if (!n || !results.has(n)) return null;
  const url = normalizeUrl(results.get(n)!)!;
  return { url, host: new URL(url).hostname.replace(/^www\./, ''), kind: linkKind(url) };
}

/** Better link first: an event's own ticket page, then resale, then a listing. */
export const LINK_RANK: Readonly<Record<LinkKind, number>> = { ticket: 2, resale: 1, listing: 0 };
