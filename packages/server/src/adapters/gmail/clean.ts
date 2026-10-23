/**
 * One ticket email (format=full) → what the ticket parse may see, plus what stays local (design §1 "Clean" and the
 * review amendments "What reaches Anthropic"). Deterministic; no LLM.
 *
 *   body       text/plain unless it is a stub (< 200 chars) or a template dump (`map[`), else the HTML as text: head,
 *              style and script dropped, entities decoded, whitespace collapsed.
 *   cut        at the first forward / reply marker ("---------- Forwarded message", "Begin forwarded message:",
 *              an Outlook "From: … / Sent: …" block, "-----Original Message-----", "On … wrote:"). A forwarded
 *              ticket ("Fwd: …" subject) keeps the forwarded mail instead of the forwarder's note: everything before
 *              its forward marker (and the forwarded mail's own header block) is dropped and the cut applies at the
 *              next marker.
 *   headers    From: / To: / Cc: / Bcc: / Reply-To: lines are dropped; Sent: / Date: / Subject: lines only inside a
 *              header block (next to another header line), so an event's own "Date: Sat, Nov 7" line stays.
 *   masking    labelled name lines (Name, Attendee, Ticket holder, Purchaser, Billing / Bill to / Ship to, …; the
 *              specific labels mid-line too) and transfer counterparties become `<person>`, the owner's names
 *              (identity/ownerNames.ts) `<me>`, any other name a greeting addresses ("Hi Rowan," in a forwarded
 *              order) or a subject opens by addressing ("Rowan, your tickets are here") `<person>`, order references
 *              `<order>`. Phones, emails, handles, URLs and digit runs are the
 *              egress scrubber's job (llm/egress.ts), which runs again on the final packet.
 *   ≤ 3,500 chars from the top.
 *
 * Local refs (gmail_messages.refs; never sent): the vendor event id (the most frequent event URL on a vendor
 * domain, JSON-LD reservationFor.url first), the order reference (JSON-LD reservationNumber, else "Order # /
 * Confirmation #" lines), partiful.com/e/<id> links, a deterministic ticket count (JSON-LD numSeats, several
 * EventReservations, wallet passes, seat lines), pass / .ics parts, whether it was forwarded, the weekday named next
 * to each date (the year post-check), and the JSON-LD event — only reservationFor.name / startDate / endDate /
 * location.name / location.address.addressLocality / performer[].name, never underName, ticketToken, ticketNumber,
 * reservationNumber or a URL.
 * Counterparties come from transfer phrasings ("<Name> sent you", "sent to <Name>", "is on its way to <Name>",
 * "<Name> accepted your", "<N> tickets to <Full Name> (<email>)", "<First> transferred"): name, Gmail-folded email
 * key and quantity, for ticket_parties — one per direction (several people in one direction: the most complete one
 * with their total quantity), while every name and address mentioned is masked. The generic phrasings ("sent to
 * <Name>", "tickets from <Name>") count only in a mail that talks about a transfer, and the event's own names
 * (JSON-LD title, venue, performers) never do.
 * JSON-LD dates are kept only when they are ISO dates (they reach the model as STRUCTURED DATA).
 */
import { emailMatchKey } from '@yb/shared';
import type { OwnerName } from '../../identity/ownerNames';
import type { GmailPart } from './api';
import { parseWall } from './dates';
import { VENDORS, vendorEventIdOf, type Vendor } from './vendors';

export const MAX_TEXT_CHARS = 3500;
const STUB_CHARS = 200;
const MAX_FIELD = 200;

export const PERSON_MASK = '<person>';
export const OWNER_MASK = '<me>';
export const ORDER_MASK = '<order>';

/** The JSON-LD EventReservation fields the parse may see. */
export interface JsonLdEvent {
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  performers: string[];
}

export type QtySource = 'json_ld_seats' | 'json_ld_reservations' | 'pkpass' | 'seat_lines';

/** gmail_messages.refs: deterministic facts about one message (local only). */
export interface TicketRefs {
  vendorEventId?: string;
  orderRef?: string;
  partifulIds?: string[];
  qty?: number;
  qtySource?: QtySource;
  jsonLd?: JsonLdEvent;
  pkpass?: number;
  ics?: boolean;
  forwarded?: boolean;
  /** 'MM-DD' → weekday (0 = Sunday) the mail names next to that date. */
  weekdays?: Record<string, number>;
  body?: 'plain' | 'html' | 'none';
}

export interface Counterparty {
  direction: 'sent_to' | 'received_from';
  name: string | null;
  /** emailMatchKey of the address (Gmail dots and +tags folded). */
  emailKey: string | null;
  quantity: number | null;
}

export interface CleanInput {
  subject: string | null;
  payload: GmailPart | null;
  vendor: Vendor | null;
  forwarded: boolean;
  ownerNames: readonly OwnerName[];
  /** An emailMatchKey of the owner's (never a counterparty). */
  isOwnerEmail?: (emailKey: string) => boolean;
}

export interface CleanedMessage {
  /** Masked subject. */
  subject: string;
  /** Masked excerpt (≤ MAX_TEXT_CHARS). */
  text: string;
  refs: TicketRefs;
  parties: Counterparty[];
}

// ---------------------------------------------------------------------------------------------- MIME

interface Bodies {
  plain: string[];
  html: string[];
  pkpass: number;
  ics: boolean;
}

const decodeB64 = (data: string): string => Buffer.from(data, 'base64url').toString('utf8');

function walk(part: GmailPart | null | undefined, out: Bodies, depth = 0): void {
  if (!part || depth > 20) return;
  const mime = (part.mimeType ?? '').toLowerCase();
  const filename = (part.filename ?? '').toLowerCase();
  if (filename.endsWith('.pkpass') || mime === 'application/vnd.apple.pkpass') out.pkpass++;
  else if (filename.endsWith('.ics') || mime === 'text/calendar' || mime === 'application/ics') out.ics = true;
  else if (!filename && part.body?.data) {
    if (mime === 'text/plain') out.plain.push(decodeB64(part.body.data));
    else if (mime === 'text/html') out.html.push(decodeB64(part.body.data));
  }
  for (const p of part.parts ?? []) walk(p, out, depth + 1);
}

// ---------------------------------------------------------------------------------------------- HTML → text

const NAMED: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  oacute: 'ó',
  iacute: 'í',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  zwnj: '',
  zwj: '',
  shy: '',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Zero-width and preheader padding characters email templates use. */
const INVISIBLE = /[​-‍⁠﻿͏­᠎]/g;

/** Collapses runs of spaces per line and drops empty lines. */
export function tidy(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t \f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** HTML → plain text: head, style, script dropped; block ends become line breaks; entities decoded. */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|tbody|section|article|blockquote|ul|ol|header|footer|center)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return tidy(decodeEntities(s));
}

/** href targets and bare URLs in the raw HTML / text (for event ids; never sent). */
function urlsIn(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/href\s*=\s*["']([^"']{8,2000})["']/gi)) out.push(decodeEntities(m[1]!));
  for (const m of raw.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]{4,2000}/gi)) out.push(decodeEntities(m[0]));
  return out;
}

// ---------------------------------------------------------------------------------------------- JSON-LD

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const typesOf = (o: Json): string[] => asArray(o['@type']).filter((t): t is string => typeof t === 'string');
const str = (v: unknown, max = MAX_FIELD): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = tidy(decodeEntities(String(v))).replace(/\n/g, ' ').slice(0, max).trim();
  return s || null;
};

interface LdFindings {
  event: JsonLdEvent | null;
  urls: string[];
  reservationNumber: string | null;
  reservations: number;
  seats: number | null;
}

/** Every object in a JSON-LD document (arrays and @graph flattened). */
function ldObjects(doc: unknown, out: Json[] = [], depth = 0): Json[] {
  if (depth > 6) return out;
  for (const o of asArray(doc)) {
    if (!isObj(o)) continue;
    out.push(o);
    if (o['@graph']) ldObjects(o['@graph'], out, depth + 1);
  }
  return out;
}

export function extractJsonLd(html: string): LdFindings {
  const found: LdFindings = { event: null, urls: [], reservationNumber: null, reservations: 0, seats: null };
  const objects: Json[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      ldObjects(JSON.parse(m[1]!.trim()), objects);
    } catch {
      // malformed JSON-LD: ignored
    }
  }
  const reservations = objects.filter((o) => typesOf(o).some((t) => /Reservation$/.test(t)) && isObj(o.reservationFor));
  const events = reservations.length ? reservations.map((r) => r.reservationFor as Json) : objects.filter((o) => typesOf(o).some((t) => /Event$/.test(t)));
  if (!events.length) return found;
  const ev = events[0]!;
  const loc = asArray(ev.location).find(isObj) as Json | undefined;
  const address = loc ? (isObj(loc.address) ? str((loc.address as Json).addressLocality, 80) : null) : null;
  // Dates travel to the model as STRUCTURED DATA: only ISO date / date-time strings, never free text.
  const isoDate = (v: unknown) => {
    const s = str(v, 40);
    return s && parseWall(s) ? s : null;
  };
  found.event = {
    name: str(ev.name),
    startDate: isoDate(ev.startDate),
    endDate: isoDate(ev.endDate),
    venue: loc ? str(loc.name) : null,
    city: address,
    performers: asArray(ev.performer)
      .map((p) => (isObj(p) ? str(p.name, 120) : str(p, 120)))
      .filter((p): p is string => !!p)
      .slice(0, 12),
  };
  for (const r of reservations) {
    for (const u of [r.url, (r.reservationFor as Json).url]) if (typeof u === 'string') found.urls.push(u);
    found.reservationNumber ??= str(r.reservationNumber, 40);
    const n = Number(r.numSeats);
    if (Number.isInteger(n) && n > 0 && n < 100) found.seats = (found.seats ?? 0) + n;
  }
  if (!reservations.length && typeof ev.url === 'string') found.urls.push(ev.url);
  found.reservations = reservations.length;
  return found;
}

// ---------------------------------------------------------------------------------------------- refs

const ORDER_RE =
  /\b(?:order|confirmation|booking|reservation|transaction|reference)(?:[ \t]*(?:#|(?:no|number|num|id|code|ref)\b\.?))?[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9/-]{3,29})(?![A-Za-z0-9])/gi;

/**
 * "Order #12-34567/NY" → "12-34567/NY" (must hold a digit; never a bare year). A rejected candidate is searched
 * again from its own start, so the word after a keyword never swallows the reference behind it ("Order
 * Confirmation #12345678", "Booking reference ABC123").
 */
export function orderRefsIn(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(ORDER_RE.source, ORDER_RE.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const ref = m[1]!.replace(/[/-]+$/, '').toUpperCase();
    if (ref.length < 4 || !/\d/.test(ref) || /^(19|20)\d\d$/.test(ref)) {
      re.lastIndex = m.index + m[0].length - m[1]!.length;
      continue;
    }
    out.push(ref);
  }
  return out;
}

const mostFrequent = (xs: string[]): string | null => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, c] of n) if (best === null || c > n.get(best)!) best = k;
  return best;
};

function vendorEventIdFrom(urls: string[], vendor: Vendor | null): string | null {
  const vendors = vendor ? [vendor, ...VENDORS.filter((v) => v.name !== vendor.name)] : VENDORS;
  for (const v of vendors) {
    const ids = urls.map((u) => vendorEventIdOf(u, v)).filter((x): x is string => !!x);
    const best = mostFrequent(ids);
    if (best) return best;
  }
  return null;
}

const SEAT_LINE = /\bseats?\b[ \t]*[:#]?[ \t]*([A-Z]{0,2}\d{1,4}[A-Z]?)(?:[ \t]*(?:-|–|to|thru|through)[ \t]*([A-Z]{0,2}\d{1,4}[A-Z]?))?((?:[ \t]*,[ \t]*[A-Z]{0,2}\d{1,4}[A-Z]?)*)/gi;

/** Seats listed in the mail ("Sec 101, Row F, Seat 7", "Seats 7-10", "Seats 7, 8"), counted once each. */
export function seatCount(text: string): number {
  const seats = new Set<string>();
  for (const line of text.split('\n')) {
    const row = /\brow\b[ \t]*[:#]?[ \t]*([A-Z0-9]{1,4})/i.exec(line)?.[1] ?? '';
    const sec = /\b(?:sec(?:tion)?)\b\.?[ \t]*[:#]?[ \t]*([A-Z0-9]{1,6})/i.exec(line)?.[1] ?? '';
    for (const m of line.matchAll(SEAT_LINE)) {
      const a = m[1]!;
      const b = m[2];
      const list = (m[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const na = Number(a.replace(/\D/g, ''));
      const nb = b ? Number(b.replace(/\D/g, '')) : NaN;
      if (b && Number.isFinite(nb) && nb >= na && nb - na < 20) for (let s = na; s <= nb; s++) seats.add(`${sec}|${row}|${s}`);
      else seats.add(`${sec}|${row}|${a.toUpperCase()}`);
      for (const x of list) seats.add(`${sec}|${row}|${x.toUpperCase()}`);
    }
  }
  return seats.size;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4,
  thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const WD = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\\.?';
const MON = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?';
const WD_MON_DAY = new RegExp(`\\b${WD},?\\s+${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)`, 'gi');
const WD_DAY_MON = new RegExp(`\\b${WD},?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}(?![a-z])`, 'gi');
const WD_NUMERIC = new RegExp(`\\b${WD},?\\s+(\\d{1,2})\\/(\\d{1,2})(?:\\/\\d{2,4})?(?![\\d/])`, 'gi');

const mmdd = (m: number, d: number) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** 'MM-DD' → the weekday the text names right next to that date ("Sat, Nov 7", "Saturday 7 November", "Sat 11/7"). */
export function weekdayHints(text: string): Record<string, number> {
  const out = new Map<string, number | null>();
  const add = (wd: string, m: number | undefined, d: number) => {
    const dow = WEEKDAYS[wd.toLowerCase()];
    if (dow === undefined || !m || m < 1 || m > 12 || d < 1 || d > 31) return;
    const k = mmdd(m, d);
    const prev = out.get(k);
    out.set(k, prev === undefined || prev === dow ? dow : null);
  };
  for (const m of text.matchAll(WD_MON_DAY)) add(m[1]!, MONTHS[m[2]!.toLowerCase()], Number(m[3]));
  for (const m of text.matchAll(WD_DAY_MON)) add(m[1]!, MONTHS[m[3]!.toLowerCase()], Number(m[2]));
  for (const m of text.matchAll(WD_NUMERIC)) add(m[1]!, Number(m[2]), Number(m[3]));
  return Object.fromEntries([...out].filter((e): e is [string, number] => e[1] !== null));
}

// ---------------------------------------------------------------------------------------------- cut & drop

/**
 * Forward markers: Gmail's and Apple Mail's separators, and an Outlook header block ("From: …" directly followed by
 * "Sent: …"), which is how Outlook both forwards and quotes.
 */
const FORWARD_MARKER = /^[ \t>]*(?:-{2,}[ \t]*Forwarded message[ \t]*-{2,}|Begin forwarded message:|From:[^\n]*\n[ \t>]*Sent:)/im;
const REPLY_MARKER = /^[ \t>]*(?:-{2,}[ \t]*Original Message[ \t]*-{2,}|On\b[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:[ \t]*$)/im;

const ALWAYS_DROP = /^[ \t>*]*(?:from|to|cc|bcc|reply-to)[ \t]*:/i;
const BLOCK_DROP = /^[ \t>*]*(?:sent|date|subject)[ \t]*:/i;

/** Drops the header lines (and blank lines) a forwarded mail starts with. */
function skipHeaderBlock(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (!lines[i]!.trim() || ALWAYS_DROP.test(lines[i]!) || BLOCK_DROP.test(lines[i]!))) i++;
  return lines.slice(i).join('\n');
}

/** The mail without quoted history (see the header for forwarded tickets). */
export function cutQuoted(text: string, forwarded: boolean): string {
  const fwd = FORWARD_MARKER.exec(text);
  const rep = REPLY_MARKER.exec(text);
  const first = [fwd, rep].filter((m): m is RegExpExecArray => !!m).sort((a, b) => a.index - b.index)[0];
  if (!first) return text;
  if (forwarded && first === fwd) {
    // The forwarded mail itself: past the marker line and its own header block, cut at the next marker.
    const rest = text.slice(first.index + first[0].length).replace(/^[^\n]*\n?/, '');
    return cutQuoted(skipHeaderBlock(rest), false);
  }
  return text.slice(0, first.index);
}

/** Header-style lines (who wrote to whom) — see the header. */
export function dropHeaderLines(text: string): string {
  const lines = text.split('\n');
  const header = (l: string | undefined) => !!l && (ALWAYS_DROP.test(l) || BLOCK_DROP.test(l));
  return lines.filter((l, i) => !(ALWAYS_DROP.test(l) || (BLOCK_DROP.test(l) && (header(lines[i - 1]) || header(lines[i + 1]))))).join('\n');
}

const LABELS =
  '(?:full name|name|attendee(?: name)?|ticket ?holder(?: name)?|purchaser(?: name)?|purchased by|billing(?: name| address| contact| information| info)?|bill(?:ed)? to|ship(?:ped)? to|deliver(?:ed)? to|guest(?: name)?|registrant(?: name)?|order(?:ed)? by|customer(?: name)?|holder(?: name)?|recipient(?: name)?|account holder|card ?holder(?: name)?)';
const LABEL_LINE = new RegExp(`^([ \\t>*]*${LABELS}[ \\t]*[:：–-][ \\t]*)\\S.*$`, 'i');
const LABEL_ONLY = new RegExp(`^[ \\t>*]*${LABELS}[ \\t]*[:：]?[ \\t]*$`, 'i');

/** Labels specific enough to mask after mid-line too ("… Order #: 1234. Purchaser: Jane Doe"); never a bare "name". */
const INLINE_LABELS =
  '(?:full name|attendee(?: name)?|ticket ?holder(?: name)?|purchaser(?: name)?|purchased by|billing name|bill(?:ed)? to|ship(?:ped)? to|guest name|registrant(?: name)?|order(?:ed)? by|customer name|recipient(?: name)?|account holder|card ?holder(?: name)?)';
const INLINE_LABEL = new RegExp(`(^|[\\s.;,|·•(])(${INLINE_LABELS})([ \\t]*[:：][ \\t]*)([^\\n]{1,80})`, 'gi');
const LEADING_NAME = /^\p{Lu}[\p{L}'’.-]*(?:[ \t]+\p{Lu}[\p{L}'’.-]*){0,3}/u;

/**
 * "Ticket holder: Jane Doe" → "Ticket holder: <person>"; a label alone on its line masks the next line; the specific
 * labels also mid-line (the capitalized words right after them).
 */
export function maskLabelledNames(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const m = LABEL_LINE.exec(l);
    if (m) lines[i] = `${m[1]}${PERSON_MASK}`;
    else if (LABEL_ONLY.test(l) && i + 1 < lines.length && lines[i + 1]!.trim()) lines[++i] = PERSON_MASK;
    else
      lines[i] = l.replace(INLINE_LABEL, (all, pre: string, label: string, sep: string, rest: string) => {
        const name = LEADING_NAME.exec(rest);
        return name ? `${pre}${label}${sep}${PERSON_MASK}${rest.slice(name[0].length)}` : all;
      });
  }
  return lines.join('\n');
}

const GREETING = /(^|\n)([ \t]*(?:hi|hello|hey|dear|congrats|congratulations|thanks|thank you)[ \t,]+)(\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]+)?)(?=[ \t]*[,!:.—–-])/giu;

/** "Hi Rowan," → "Hi <person>," (a forwarded order greets whoever bought it). Run after the owner's names are masked. */
export function maskGreetings(text: string): string {
  return text.replace(GREETING, (_m, nl: string, hi: string, name: string) => `${nl}${hi}${/^\p{Lu}/u.test(name) ? PERSON_MASK : name}`);
}

/** A subject that opens by addressing someone: "Rowan, your tickets are here", "Fwd: Rowan Quill, you're going!". */
const VOCATIVE = /^((?:[ \t]*(?:[Ff][Ww][Dd]?|[Rr][Ee])[ \t]*:)*[ \t]*)(\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]+)?)([ \t]*[,!][ \t]*)(\p{L}[\p{L}'’]*)/u;
const ADDRESSED = new Set(['you', 'your', 'you’re', "you're", 'youre', 'you’ve', "you've", 'here', 'here’s', "here's", 'thanks', 'thank', 'we', 'it’s', "it's", 'get', 'enjoy', 'welcome', 'don’t', "don't", 'check', 'see', 'let’s', "let's", 'this', 'time']);

/** Masks the name a subject opens by addressing (see VOCATIVE); never a weekday, month or a word NOT_NAME knows. */
export function maskVocative(subject: string): string {
  const m = VOCATIVE.exec(subject);
  if (!m || !ADDRESSED.has(m[4]!.toLowerCase())) return subject;
  const first = m[2]!.split(/[ \t]+/)[0]!.toLowerCase();
  if (NOT_NAME.has(first) || MONTH_OR_DAY.has(first)) return subject;
  return `${m[1]}${PERSON_MASK}${subject.slice(m[1]!.length + m[2]!.length)}`;
}

// ---------------------------------------------------------------------------------------------- counterparties

/** Capitalized words that end a captured name (or reject it when they start it). */
const NOT_NAME = new Set(
  (
    'you your yours we us our the a an tickets ticket order orders transfer transfers transferred hi hello hey dear for to from at on in of ' +
    'and or has have had just is are was were sent send accepted claimed congrats congratulations great good news someone friend guest ' +
    'mobile event events show concert festival ticketmaster axs stubhub eventbrite dice live nation livenation seatgeek vivid viagogo ' +
    'please thanks thank reminder important update your’s it this that these those they he she his her their my me i ' +
    'heads ready final last oops sorry attention hooray yay surprise today tonight tomorrow welcome'
  ).split(' '),
);
const MONTH_OR_DAY = new Set([...Object.keys(MONTHS), ...Object.keys(WEEKDAYS)]);

/** A captured run of capitalized words → the name in it: leading non-name words skipped, cut at the next one. */
function cleanName(raw: string): string | null {
  const words: string[] = [];
  for (const w of raw.split(/\s+/)) {
    const k = w.toLowerCase().replace(/[.'’,;:]+$/, '');
    const stop = !k || NOT_NAME.has(k) || MONTH_OR_DAY.has(k);
    if (stop && words.length) break;
    // A sentence's full stop is not part of the name ("… from Dana Reyes."); an initial's is ("Dana R.").
    if (!stop) words.push(w.replace(/[,;:]+$/, '').replace(/(\p{L}{2,})\.$/u, '$1'));
  }
  const name = words.join(' ').trim();
  return name.length >= 2 && /\p{L}{2}/u.test(name) ? name.slice(0, 80) : null;
}

const NAME = String.raw`(\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]*\.?){0,3})`;
const EMAIL = String.raw`([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})`;

interface PartyPattern {
  re: RegExp;
  direction: Counterparty['direction'];
  /** Capture groups: name, email, quantity (0 = absent). */
  name: number;
  email: number;
  qty: number;
  /** Generic phrasing ("tickets from …", "sent to …"): counts only in a mail that talks about a transfer. */
  gated?: boolean;
}

const pattern = (src: string, direction: Counterparty['direction'], name: number, email: number, qty: number, gated = false): PartyPattern => ({
  re: new RegExp(src, 'gu'),
  direction,
  name,
  email,
  qty,
  gated,
});

/** A mail about moving tickets between people (the gate for the generic phrasings). */
const TRANSFER_CONTEXT =
  /\btransfer|\bsent you\b|\byou sent\b|\bsent \d{1,2} tickets?\b|\bon (?:its|their) way to\b|\baccept|\bclaim|\bgift|\bforwarded you\b|\bwants to (?:send|transfer|give)\b/i;

const PARTY_PATTERNS: readonly PartyPattern[] = [
  // "2 tickets to Dana Reyes (dana@…)"
  pattern(String.raw`(?<![\d])(\d{1,2})[ \t]+tickets?[ \t]+to[ \t]+${NAME}[ \t]*\(${EMAIL}\)`, 'sent_to', 2, 3, 1),
  // "You sent 2 tickets to Dana Reyes", "transferred your tickets to Dana"
  pattern(String.raw`\b(?:[Ss]ent|[Tt]ransferred|[Ff]orwarded|[Gg]ave)[ \t]+(?:(\d{1,2})[ \t]+)?(?:the[ \t]+|your[ \t]+)?tickets?[ \t]+to[ \t]+${NAME}(?:[ \t]*\(${EMAIL}\))?`, 'sent_to', 2, 3, 1),
  // "sent to Dana Reyes", "transferred to Dana"
  pattern(String.raw`\b(?:[Ss]ent|[Tt]ransferred)[ \t]+to[ \t]+${NAME}`, 'sent_to', 1, 0, 0, true),
  // "is on its way to Dana"
  pattern(String.raw`\bon[ \t]+(?:its|their)[ \t]+way[ \t]+to[ \t]+${NAME}`, 'sent_to', 1, 0, 0),
  // "Dana Reyes accepted your transfer", "Dana claimed your tickets"
  pattern(String.raw`${NAME}[ \t]+(?:has[ \t]+|just[ \t]+)?(?:[Aa]ccepted|[Cc]laimed)[ \t]+(?:[Yy]our|[Tt]he)[ \t]+(?:[Tt]ickets?[ \t]+)?(?:[Tt]ransfer|[Tt]ickets?|[Oo]ffer)`, 'sent_to', 1, 0, 0),
  // "tickets to dana@…" with no name
  pattern(String.raw`\b(?:[Ss]ent|[Tt]ransferred)(?:[ \t]+(\d{1,2}))?[ \t]+tickets?[ \t]+to[ \t]+${EMAIL}`, 'sent_to', 0, 2, 1),
  // "Dana Reyes sent you 2 tickets"
  pattern(
    String.raw`${NAME}[ \t]+(?:has[ \t]+|just[ \t]+)?(?:[Ss]ent|[Tt]ransferred|[Ff]orwarded|[Gg]ifted)[ \t]+[Yy]ou[ \t]+(?:(\d{1,2})[ \t]+)?(?:a[ \t]+|your[ \t]+|the[ \t]+)?[Tt]ickets?`,
    'received_from',
    1,
    0,
    2,
  ),
  // "Dana wants to send you tickets"
  pattern(String.raw`${NAME}[ \t]+(?:wants|is trying|would like)[ \t]+to[ \t]+(?:send|transfer|give)[ \t]+you`, 'received_from', 1, 0, 0),
  // "tickets from Dana Reyes", "a transfer from Dana"
  pattern(String.raw`\b(?:[Tt]ickets?|[Tt]ransfer|[Oo]ffer)[ \t]+from[ \t]+${NAME}`, 'received_from', 1, 0, 0, true),
  // "Dana transferred"
  pattern(String.raw`${NAME}[ \t]+(?:has[ \t]+)?transferred\b`, 'received_from', 1, 0, 0),
];

/** A captured name that is one of the owner's own ("tickets from Sam Owner" in his own transfer mail). */
function isOwnerName(name: string, owner: readonly OwnerName[]): boolean {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  const first = n.split(' ')[0]!;
  return owner.some((o) => {
    const full = [o.firstName, o.lastName].filter(Boolean).join(' ').toLowerCase();
    const display = o.displayName.toLowerCase().trim();
    if (n === full || (display && n === display)) return true;
    // A first name alone (or with the owner's surname) is his when it is his first name or nickname.
    const firsts = [o.firstName, o.nickname].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    const rest = n.split(' ').slice(1).join(' ');
    return firsts.includes(first) && (!rest || rest === (o.lastName ?? '').toLowerCase());
  });
}

interface CounterpartyOptions {
  ownerNames?: readonly OwnerName[];
  isOwnerEmail?: (emailKey: string) => boolean;
  notNames?: readonly string[];
}

/** Transfer counterparties named in the subject or the (cut) text: one per direction (pickCounterparties). */
export function extractCounterparties(subject: string, text: string, o: CounterpartyOptions = {}): Counterparty[] {
  return pickCounterparties(counterpartyMentions(subject, text, o));
}

/** Every counterparty mention in the subject or the (cut) text — all of them are masked, not only the stored one. */
export function counterpartyMentions(subject: string, text: string, o: CounterpartyOptions = {}): Counterparty[] {
  const found: Counterparty[] = [];
  const transferish = TRANSFER_CONTEXT.test(subject) || TRANSFER_CONTEXT.test(text);
  // The event's own names (JSON-LD title, venue, performers) are never a counterparty ("tickets from The Copper Hall").
  const notNames = new Set((o.notNames ?? []).map((n) => n.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^the /, '')));
  for (const source of [subject, text]) {
    for (const p of PARTY_PATTERNS) {
      if (p.gated && !transferish) continue;
      for (const m of source.matchAll(p.re)) {
        let name = p.name ? cleanName(m[p.name] ?? '') : null;
        if (name && notNames.has(name.toLowerCase().replace(/^the /, ''))) name = null;
        let emailKey = p.email && m[p.email] ? emailMatchKey(m[p.email]!) : null;
        // The owner is never his own counterparty ("tickets from <owner>" in his outgoing transfer).
        if (name && o.ownerNames && isOwnerName(name, o.ownerNames)) name = null;
        if (emailKey && o.isOwnerEmail?.(emailKey)) emailKey = null;
        if (!name && !emailKey) continue;
        const q = p.qty && m[p.qty] ? Number(m[p.qty]) : null;
        found.push({ direction: p.direction, name, emailKey, quantity: q && q > 0 && q < 50 ? q : null });
      }
    }
  }
  return found;
}

const firstWord = (name: string) => name.toLowerCase().split(/\s+/)[0]!;
/**
 * Two mentions of one person unless they are told apart: the same address, else names that match (one a prefix of the
 * other, or the same first name); a mention without a name differs only by its address ("sent to Dana Reyes" and
 * "2 tickets to <her address>" are one).
 */
function samePerson(a: Counterparty, b: Counterparty): boolean {
  if (a.emailKey && a.emailKey === b.emailKey) return true;
  if (a.name && b.name) return a.name.startsWith(b.name) || b.name.startsWith(a.name) || firstWord(a.name) === firstWord(b.name);
  return !(a.emailKey && b.emailKey);
}

/**
 * One party per direction: the most complete person, merged with what other mentions of them add (a quantity in one
 * sentence, the address in another). When the mail names several people in one direction, the quantity is the
 * direction's total (null unless each of them says how many), since it stands for the whole message's tickets.
 */
export function pickCounterparties(found: readonly Counterparty[]): Counterparty[] {
  const score = (c: Counterparty) => (c.emailKey ? 4 : 0) + (c.name && c.name.includes(' ') ? 2 : c.name ? 1 : 0) + (c.quantity ? 1 : 0);
  const out: Counterparty[] = [];
  for (const dir of ['sent_to', 'received_from'] as const) {
    const all = found.filter((c) => c.direction === dir);
    if (!all.length) continue;
    const people: Counterparty[][] = [];
    for (const c of all) {
      const p = people.find((g) => g.some((x) => samePerson(x, c)));
      if (p) p.push(c);
      else people.push([c]);
    }
    const best = people.reduce((a, b) => (Math.max(...b.map(score)) > Math.max(...a.map(score)) ? b : a));
    const each = people.map((g) => g.find((c) => c.quantity)?.quantity ?? null);
    let quantity = each[0] ?? null;
    if (people.length > 1) quantity = each.every((q): q is number => q !== null) ? Math.min(49, each.reduce((n, q) => n + q, 0)) : null;
    out.push({
      direction: dir,
      name: best.map((c) => c.name).filter((n): n is string => !!n).sort((a, b) => b.length - a.length)[0] ?? null,
      emailKey: best.find((c) => c.emailKey)?.emailKey ?? null,
      quantity,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- masking

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Single words never masked on their own: month and weekday names (a name "May" would turn "May 3" into a mask). */
const UNMASKABLE = new Set([...Object.keys(MONTHS), ...Object.keys(WEEKDAYS)]);

/** Replaces each name (longest first): multi-word names case-insensitively, single words only capitalized. */
export function maskNames(text: string, names: Iterable<string>, mask: string): string {
  const list = [...new Set([...names].map((n) => n.normalize('NFC').replace(/\s+/g, ' ').trim()).filter((n) => [...n].length >= 2))].sort((a, b) => b.length - a.length);
  let out = text.normalize('NFC');
  for (const n of list) {
    const multi = /\s/.test(n);
    if (!multi && UNMASKABLE.has(n.toLowerCase())) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, multi ? 'giu' : 'gu');
    out = out.replace(re, mask);
  }
  return out;
}

/** Every form of a name worth masking: the full name and each word of two letters or more. */
function nameForms(name: string | null | undefined): string[] {
  const n = (name ?? '').replace(/[()"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return [];
  const words = n.split(' ').filter((w) => [...w.replace(/[.'’-]/g, '')].length >= 2);
  return [n, ...words];
}

export function ownerNameForms(owner: readonly OwnerName[]): string[] {
  const out: string[] = [];
  for (const o of owner) {
    out.push(...nameForms(o.displayName), ...nameForms([o.firstName, o.lastName].filter(Boolean).join(' ')), ...nameForms(o.nickname));
  }
  return out;
}

const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return text.slice(0, cut > max * 0.6 ? cut : max).trimEnd();
};

// ---------------------------------------------------------------------------------------------- the whole step

export function cleanMessage(i: CleanInput): CleanedMessage {
  const bodies: Bodies = { plain: [], html: [], pkpass: 0, ics: false };
  walk(i.payload, bodies);
  const rawHtml = bodies.html.join('\n');
  const plain = tidy(bodies.plain.join('\n'));
  const useHtml = bodies.html.length > 0 && (plain.length < STUB_CHARS || plain.includes('map['));
  const full = useHtml ? htmlToText(rawHtml) : plain || htmlToText(rawHtml);
  const subject = tidy(i.subject ?? '').replace(/\n/g, ' ');

  const ld = extractJsonLd(rawHtml);
  const urls = [...ld.urls, ...urlsIn(rawHtml), ...urlsIn(bodies.plain.join('\n'))];

  // ---- local refs (from the whole mail, unmasked)
  const refs: TicketRefs = { body: useHtml ? 'html' : plain ? 'plain' : rawHtml ? 'html' : 'none' };
  const vendorEventId = vendorEventIdFrom(urls, i.vendor);
  if (vendorEventId) refs.vendorEventId = vendorEventId;
  const orderRef = (ld.reservationNumber ? ld.reservationNumber.toUpperCase() : null) ?? orderRefsIn(`${subject}\n${full}`)[0] ?? null;
  if (orderRef) refs.orderRef = orderRef;
  const partiful = [...new Set(urls.concat(full).flatMap((u) => [...u.matchAll(/partiful\.com\/e\/([A-Za-z0-9]{6,40})/g)].map((m) => m[1]!)))];
  if (partiful.length) refs.partifulIds = partiful.slice(0, 10);
  if (bodies.pkpass) refs.pkpass = bodies.pkpass;
  if (bodies.ics) refs.ics = true;
  if (i.forwarded) refs.forwarded = true;
  const weekdays = weekdayHints(`${subject}\n${full}`);
  if (Object.keys(weekdays).length) refs.weekdays = weekdays;

  // ---- what the model may see
  const cut = dropHeaderLines(cutQuoted(full, i.forwarded));
  const seats = seatCount(cut);
  if (ld.seats) Object.assign(refs, { qty: ld.seats, qtySource: 'json_ld_seats' });
  else if (ld.reservations >= 2) Object.assign(refs, { qty: ld.reservations, qtySource: 'json_ld_reservations' });
  else if (bodies.pkpass) Object.assign(refs, { qty: bodies.pkpass, qtySource: 'pkpass' });
  else if (seats) Object.assign(refs, { qty: seats, qtySource: 'seat_lines' });

  const eventNames = ld.event ? [ld.event.name, ld.event.venue, ...ld.event.performers].filter((n): n is string => !!n) : [];
  // Every counterparty the mail names is masked; one per direction is kept (ticket_parties).
  const mentions = counterpartyMentions(subject, cut, { ownerNames: i.ownerNames, isOwnerEmail: i.isOwnerEmail, notNames: eventNames });
  const parties = pickCounterparties(mentions);
  const partyNames = mentions.flatMap((p) => nameForms(p.name));
  const partyKeys = new Set(mentions.map((p) => p.emailKey).filter((k): k is string => !!k));
  const partyEmails = partyKeys.size ? [...`${subject}\n${cut}`.matchAll(new RegExp(EMAIL, 'g'))].map((m) => m[1]!).filter((e) => partyKeys.has(emailMatchKey(e) ?? '')) : [];
  const owner = ownerNameForms(i.ownerNames);
  const orderRefs = [...new Set([...(orderRef ? [orderRef] : []), ...orderRefsIn(`${subject}\n${full}`)])];

  const mask = (s: string): string => {
    let t = s;
    for (const e of partyEmails) t = t.split(e).join(PERSON_MASK);
    t = maskNames(t, partyNames, PERSON_MASK);
    t = maskNames(t, owner, OWNER_MASK);
    for (const r of orderRefs) t = t.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(r)}(?![A-Za-z0-9])`, 'gi'), ORDER_MASK);
    return t;
  };

  if (ld.event) {
    const e = ld.event;
    refs.jsonLd = {
      name: e.name ? mask(e.name) : null,
      startDate: e.startDate,
      endDate: e.endDate,
      venue: e.venue ? mask(e.venue) : null,
      city: e.city,
      performers: e.performers.map(mask),
    };
  }
  return { subject: maskVocative(maskGreetings(mask(subject))), text: clip(maskGreetings(mask(maskLabelledNames(cut))), MAX_TEXT_CHARS), refs, parties };
}
