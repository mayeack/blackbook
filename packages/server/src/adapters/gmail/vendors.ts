/**
 * Ticket vendors the Gmail source trusts as senders (design §1 "Triage"): primary sellers, registration platforms
 * and secondary markets. A sender matches a vendor when its domain is the vendor's domain or a subdomain of it
 * (email.ticketmaster.com). The owner adds senders the list doesn't know with the setting `gmail.extra_senders`
 * (sender domains; their vendor name is the domain itself).
 *   - `secondary`: a resale marketplace. Its order is usually followed by a transfer from the seller, which the
 *     ledger counts once (adapters/gmail/ledger.ts).
 *   - `event`: how the vendor's event pages are addressed; the id becomes the message's `vendorEventId`
 *     (`<vendor>:<id>`), the strongest "same event" key. Vendors without one fall back to EVENT_PATH.
 * Only domains live here (no addresses).
 */

export interface Vendor {
  name: string;
  domains: readonly string[];
  secondary?: boolean;
  /** The event id in a URL path on one of the vendor's domains. */
  event?: RegExp;
}

export const VENDORS: readonly Vendor[] = [
  { name: 'ticketmaster', domains: ['ticketmaster.com', 'ticketmaster.ca', 'ticketmaster.co.uk', 'ticketweb.com'], event: /\/event\/([A-Za-z0-9]{8,24})(?:[/?#]|$)/ },
  { name: 'livenation', domains: ['livenation.com'], event: /\/event\/([A-Za-z0-9]{8,24})(?:[/?#]|$)/ },
  { name: 'axs', domains: ['axs.com'], event: /\/events\/(\d{3,12})(?:[/?#]|$)/ },
  { name: 'eventbrite', domains: ['eventbrite.com', 'eventbrite.co.uk', 'eventbrite.ca'], event: /\/e\/(?:[\w-]*?-)?(\d{6,16})(?:[/?#]|$)/ },
  { name: 'dice', domains: ['dice.fm'], event: /\/event\/([a-z0-9]{4,12})-/ },
  { name: 'resident_advisor', domains: ['ra.co', 'residentadvisor.net'], event: /\/events\/(\d{3,10})(?:[/?#]|$)/ },
  { name: 'seetickets', domains: ['seetickets.us', 'seetickets.com'], event: /\/event\/[\w-]+\/(\d{3,10})(?:[/?#]|$)/ },
  { name: 'etix', domains: ['etix.com'], event: /\/ticket\/p\/(\d{3,12})(?:[/?#]|$)/ },
  { name: 'tixr', domains: ['tixr.com'], event: /\/events\/(?:[\w-]*?-)?(\d{3,10})(?:[/?#]|$)/ },
  { name: 'frontgate', domains: ['frontgatetickets.com'] },
  { name: 'showclix', domains: ['showclix.com'] },
  { name: 'universe', domains: ['universe.com'] },
  { name: 'eventim', domains: ['eventim.de', 'eventim.co.uk'] },
  { name: 'shotgun', domains: ['shotgun.live', 'tickets-shotgun.live'] },
  { name: 'posh', domains: ['posh.vip'], event: /\/e\/([\w-]{3,80})(?:[/?#]|$)/ },
  { name: 'luma', domains: ['lu.ma', 'luma.com', 'luma-mail.com'] },
  { name: 'fever', domains: ['feverup.com'] },
  { name: 'portalys', domains: ['portalys.io'] },
  { name: 'prekindle', domains: ['prekindle.com'] },
  { name: 'boletia', domains: ['boletia.com'] },
  { name: 'telecharge', domains: ['telecharge.com'] },
  { name: 'todaytix', domains: ['todaytix.com'] },
  { name: 'broadway', domains: ['broadway.com'] },
  { name: 'ovationtix', domains: ['ovationtix.com'] },
  { name: 'ticketleap', domains: ['ticketleap.com'] },
  { name: 'brownpaper', domains: ['brownpapertickets.com'] },
  { name: 'mlb', domains: ['tickets.mlb.com'] },
  { name: 'stubhub', domains: ['stubhub.com', 'stubhub.co.uk'], secondary: true, event: /\/event\/(\d{4,12})(?:[/?#]|$)/ },
  { name: 'vividseats', domains: ['vividseats.com'], secondary: true, event: /--(\d{5,12})(?:[/?#]|$)|\/production\/(\d{5,12})/ },
  { name: 'seatgeek', domains: ['seatgeek.com'], secondary: true, event: /\/(\d{5,12})(?:[/?#]|$)/ },
  { name: 'viagogo', domains: ['viagogo.com'], secondary: true, event: /\/E-(\d{5,12})(?:[/?#]|$)/ },
  { name: 'tickpick', domains: ['tickpick.com'], secondary: true },
  { name: 'gametime', domains: ['gametime.co'], secondary: true },
];

/** The generic event path for vendors without their own pattern (and for `gmail.extra_senders`). */
export const EVENT_PATH = /\/(?:events?|e)\/([A-Za-z0-9][\w-]{3,80})(?:[/?#]|$)/;

/** A sender domain the setting may hold: lowercase labels, at least one dot. */
export const SENDER_DOMAIN = /^(?=.{3,100}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const domainMatches = (domain: string, vendorDomain: string) => domain === vendorDomain || domain.endsWith(`.${vendorDomain}`);

/** The vendor a sender domain belongs to (an extra sender is its own vendor), or null. */
export function vendorOf(domain: string | null, extraSenders: readonly string[] = []): Vendor | null {
  if (!domain) return null;
  const d = domain.toLowerCase();
  for (const v of VENDORS) if (v.domains.some((vd) => domainMatches(d, vd))) return v;
  for (const raw of extraSenders) {
    const x = raw.trim().toLowerCase();
    if (x && domainMatches(d, x)) return { name: x, domains: [x] };
  }
  return null;
}

export const vendorByName = (name: string | null): Vendor | null => (name ? (VENDORS.find((v) => v.name === name) ?? null) : null);

/** A secondary marketplace's vendor name (StubHub, Vivid Seats, SeatGeek, viagogo, …). */
export const isSecondaryVendor = (name: string | null): boolean => !!vendorByName(name)?.secondary;

/** The domain of an address in a From header ("Name <a@b.c>" or "a@b.c"), lowercased, or null. */
export function senderDomain(from: string | null): string | null {
  if (!from) return null;
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"'(),;:]+@[^\s<>"'(),;:]+)/.exec(from);
  const addr = m?.[1]?.toLowerCase().replace(/\.+$/, '');
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  const domain = addr.slice(at + 1);
  return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain) ? domain : null;
}

/** The address in a From header (lowercased), for the owner check only — never stored or logged. */
export function senderAddress(from: string | null): string | null {
  if (!from) return null;
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"'(),;:]+@[^\s<>"'(),;:]+)/.exec(from);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * `<vendor>:<id>` for a URL on the vendor's own domain that names one of its events (null otherwise). For an extra
 * sender (or a vendor without a pattern) the generic EVENT_PATH applies.
 */
export function vendorEventIdOf(url: string, vendor: Vendor): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!vendor.domains.some((d) => domainMatches(host, d))) return null;
  const m = (vendor.event ?? EVENT_PATH).exec(u.pathname);
  const id = m?.slice(1).find((g) => !!g);
  return id ? `${vendor.name}:${id.toLowerCase()}` : null;
}
