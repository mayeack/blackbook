/**
 * Text helpers for everything yeackbot sends the owner: names (first name + last initial; the full last name when
 * that would read as the owner or as someone else in the same brief), safe fragments
 * (no URLs, phones, emails, long digit runs), length caps, the digest date header and stable client refs.
 * Pure functions; no database.
 */
import { createHash } from 'node:crypto';
import { collisionAware } from '../identity/ownerNames';
import { BOT_MARKER } from './types';

export { BOT_MARKER };

/** The digest's main lines (ordinal included) are at most this long. */
export const MAX_MAIN_LINE = 70;
/** Secondary lines (body, opener) in the iMessage text. */
export const MAX_SUB_LINE = 110;
/** The one link a digest carries (no scheme: link previews of Access-protected pages are ugly). */
export const TODAY_LINK = 'yeackbot.com/today';
export const SOURCES_LINK = 'yeackbot.com/sources';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "2026-10-14" → "Wed Oct 14". */
export function headerDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAY[dt.getUTCDay()]} ${MONTH[m - 1]} ${d}`;
}

/** Short local date/time words for templates: "Sat", "Oct 18", "7pm". */
export function shortDay(ms: number, timeZone: string, now: number): string {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const days = Math.round((ms - now) / 86_400_000);
  if (days >= 0 && days < 6) return parts.weekday ?? '';
  return `${parts.month} ${parts.day}`;
}

export function shortTime(ms: number, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const min = parts.minute === '00' ? '' : `:${parts.minute}`;
  return `${parts.hour}${min}${(parts.dayPeriod ?? '').toLowerCase()}`;
}

/** A span of days in words: "1 day", "5 days", "3 weeks", "4 months", "over a year", "3 years". */
export function humanDuration(d: number | null | undefined): string | null {
  if (d === null || d === undefined || !Number.isFinite(d) || d < 0) return null;
  const n = Math.max(1, Math.round(d));
  if (n < 14) return n === 1 ? '1 day' : `${n} days`;
  if (n < 60) return `${Math.round(n / 7)} weeks`;
  if (n < 365) return `${Math.round(n / 30)} months`;
  const y = Math.floor(n / 365);
  return y === 1 ? 'over a year' : `${y} years`;
}

/** A usual gap in words: "almost every day", "about once a week", "about once a month". */
export function humanEvery(gapD: number | null | undefined): string | null {
  if (gapD === null || gapD === undefined || !Number.isFinite(gapD) || gapD <= 0) return null;
  if (gapD <= 1.5) return 'almost every day';
  if (gapD <= 4.5) return 'every few days';
  if (gapD <= 10) return 'about once a week';
  if (gapD <= 21) return 'every couple of weeks';
  if (gapD <= 45) return 'about once a month';
  if (gapD <= 100) return 'every couple of months';
  return 'a few times a year';
}

/** "Sam R.", "Sam R. and Priya S.", "Sam R., Priya S. and 2 others" (for sentences, not headers). */
export function peopleList(names: string[], max = 2): string {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] ?? '';
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length <= max) return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  const rest = n.length - max;
  return `${n.slice(0, max).join(', ')} and ${rest === 1 ? '1 other' : `${rest} others`}`;
}

/** "today at 7pm", "tomorrow at 11am", "Sat at 7pm", "Oct 28 at 7pm" in the owner's zone. */
export function whenPhrase(ms: number, timeZone: string, now: number): string {
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const d = day(ms);
  const at = ` at ${shortTime(ms, timeZone)}`;
  if (d === day(now)) return `today${at}`;
  if (d === day(now + 86_400_000)) return `tomorrow${at}`;
  return `${shortDay(ms, timeZone, now)}${at}`;
}

/** "8am", "6:30pm" from "08:00" / "18:30". */
export function clockWords(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** Ends a sentence with a period unless it already ends in punctuation ("… with Sam R." stays one period). */
export const endSentence = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** Whole days as "41d". */
export const days = (d: number | null | undefined): string | null =>
  d === null || d === undefined || !Number.isFinite(d) || d < 0 ? null : `${Math.round(d)}d`;

/** Truncates to `max` chars at a word boundary, with an ellipsis. */
export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:·—-]+$/, '')}…`;
}

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|app|me|ly|gl|us|uk|ca|de|fr|ai|dev|xyz|info|biz|link)(?:\/\S*)?/gi;
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_LIKE = /(?:\+\d[\d\s().-]{6,18}\d)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)/g;
const LONG_DIGITS = /\d{5,}/g;
/** Control, zero-width, line/paragraph separator and bidi-override characters. */
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
const HANDLE_LIKE = /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9._]{2,30}\b/g;
const MONEY = /(?:[$€£¥]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:dollars|usd|bucks|eur|gbp)\b)/gi;

/**
 * A dynamic string (title, commitment text, city) made safe for an outbound text: URLs, emails, phones, @handles,
 * money amounts and digit runs ≥5 removed, whitespace collapsed, truncated. Null when nothing useful is left.
 */
export function safeFragment(s: string | null | undefined, max = 40): string | null {
  if (!s) return null;
  const t = s
    .normalize('NFKC')
    .replace(INVISIBLE, ' ')
    .replace(EMAIL_LIKE, ' ')
    .replace(URL_LIKE, ' ')
    .replace(PHONE_LIKE, ' ')
    .replace(MONEY, ' ')
    .replace(LONG_DIGITS, ' ')
    .replace(HANDLE_LIKE, '')
    .replace(new RegExp(BOT_MARKER, 'gu'), '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || !/[\p{L}]/u.test(t)) return null;
  return truncate(t, max);
}

export interface NameParts {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  nickname?: string | null;
}

const NAME_OK = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
/** Emoji and symbols people decorate names with ("Viv ⚡️", "★ Sam"). */
const EMOJI_SYMBOLS = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{S}‍️⃣]/gu;
/** A note in brackets after a name ("Sam (climbing)"). */
const BRACKET_NOTE = /[([{][^)\]}]*[)\]}]/g;

/** The first name (one word) and last name a short name is made from; null when unusable. */
function nameWords(p: NameParts): { first: string; last: string | null } | null {
  const clean = (s: string | null | undefined) => {
    const t = s?.normalize('NFKC').replace(BRACKET_NOTE, ' ').replace(EMOJI_SYMBOLS, ' ').replace(/\s+/g, ' ').trim() ?? '';
    return t && NAME_OK.test(t) ? t : null;
  };
  let first = clean(p.firstName) ?? clean(p.nickname);
  let last = clean(p.lastName);
  if (!first) {
    const words = clean(p.displayName)?.split(' ') ?? [];
    first = words[0] ?? null;
    if (!last && words.length > 1) last = words[words.length - 1] ?? null;
  }
  return first ? { first: truncate(first.split(' ')[0]!, 18), last } : null;
}

/** "Sam R." from first + last (falls back to the display name's first and last words); null when unusable. */
export function shortName(p: NameParts): string | null {
  const n = nameWords(p);
  if (!n) return null;
  const initial = n.last ? n.last.replace(/[^\p{L}]/gu, '').slice(0, 1).toUpperCase() : '';
  return initial ? `${n.first} ${initial}.` : n.first;
}

/** "Sam Rivera": shortName's first name + the full last name (for a short name that would be ambiguous). */
export function longName(p: NameParts): string | null {
  const n = nameWords(p);
  if (!n) return null;
  return n.last && /\p{L}/u.test(n.last) ? `${n.first} ${truncate(n.last, 24)}` : n.first;
}

const IDENTIFIER = new RegExp(`${PHONE_LIKE.source}|${EMAIL_LIKE.source}|${URL_LIKE.source}|${LONG_DIGITS.source}`, 'i');

/**
 * What the brief calls someone with no usable name (a number the owner never saved): their display name, which the
 * resolver keeps as the masked handle ("(310) •••-••12"), emoji removed. Null when nothing is left or it would
 * show a whole phone number, email or link.
 */
export function nameLabel(p: NameParts): string | null {
  const t = p.displayName?.normalize('NFKC').replace(EMOJI_SYMBOLS, ' ').replace(/\s+/g, ' ').trim() ?? '';
  if (!/[\p{L}\p{N}]/u.test(t) || IDENTIFIER.test(t)) return null;
  return truncate(t, 24);
}

export interface BriefNames {
  /**
   * The name the brief uses: shortName, or longName when the short one is ambiguous (see briefNames); nameLabel for
   * someone with no usable name (firstNameOnly is null for them).
   */
  of(p: NameParts & { id: string }): string | null;
  /**
   * First names that point at nobody in particular here: the owner's own, and those of the people named by their
   * long name. LLM copy names these people by token only (llmComposer), so a bare "Sam" can't stand in for them.
   */
  ambiguousFirstNames: ReadonlySet<string>;
}

/**
 * Names for the people one brief names together (every item's people): "Sam R.", unless that reads the same as
 * the owner's own short name or another person's in the brief; then "Sam Rivera" (identity/ownerNames.ts).
 */
export function briefNames(people: readonly (NameParts & { id: string })[], owner: readonly NameParts[]): BriefNames {
  const names = collisionAware(people, owner.map(shortName), { short: shortName, long: longName });
  const firsts = new Set<string>();
  for (const p of [...owner, ...people.filter((x) => names.colliding.has(x.id))]) {
    const first = nameWords(p)?.first;
    if (first) firsts.add(first);
  }
  return { of: (p) => names.of(p) ?? nameLabel(p), ambiguousFirstNames: firsts };
}

/** First name only (push bodies with names turned on). */
export function firstNameOnly(p: NameParts): string | null {
  return shortName(p)?.split(' ')[0] ?? null;
}

/** "Sam R.", "Sam R. & Priya S.", "Sam R., Priya S. +2". */
export function nameList(names: string[], max = 2): string {
  const n = names.filter(Boolean);
  if (n.length <= max) return n.length === 2 ? `${n[0]} & ${n[1]}` : (n[0] ?? '');
  return `${n.slice(0, max).join(', ')} +${n.length - max}`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * A deterministic RFC 9562 version-8 UUID from a name (e.g. `digest:<id>`): the outbound idempotency key, so a
 * crash between "sent" and "recorded" re-sends with the same client_ref and the collector dedupes it.
 */
export function stableUuid(name: string): string {
  const h = createHash('sha256').update(`yeackbot:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
