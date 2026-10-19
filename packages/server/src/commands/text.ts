/**
 * Reply text helpers for the self-thread (PLAN "Two-way texting", delivery §3 "Acks and answers"):
 * every reply starts with the 🅨 marker, names are first name + last initial, links are yeackbot.com only, and no
 * phone number or email ever goes out (the sender refuses those; we scrub first so a reply still goes out).
 */
import { createHash } from 'node:crypto';
import { BOT_MARKER, checkOutboundText, MAX_OUTBOUND_CHARS, OUTBOUND_URL_ALLOWLIST, stripDisallowedLinks } from '../delivery/types';

export { BOT_MARKER };

/** A deterministic RFC 9562 (version 8) UUID for an outbound clientRef: the same command never texts twice. */
export function stableRef(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface NameParts {
  first_name: string | null;
  last_name: string | null;
  display_name: string;
}

/** "Sam R." (first name + last initial), else the display name's first two words. */
export function shortName(p: NameParts): string {
  const first = p.first_name?.trim();
  const last = p.last_name?.trim();
  if (first) return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
  const words = p.display_name.trim().split(/\s+/);
  if (words.length >= 2 && words[0]) return `${words[0]} ${words[1]![0]!.toUpperCase()}.`;
  return p.display_name.trim() || 'someone';
}

/** "Oct 28" in the owner's zone; with the weekday: "Thu Oct 23". */
export function formatDay(ms: number, timeZone: string, weekday = false): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(weekday ? { weekday: 'short' as const } : {}),
  })
    .format(new Date(ms))
    .replace(',', '');
}

/** "today" / "yesterday" / "Oct 14" relative to `now` (local days). */
export function relativeDay(dateLocal: string, nowLocal: string, ms: number, timeZone: string): string {
  if (dateLocal === nowLocal) return 'today';
  const d = Date.UTC(+dateLocal.slice(0, 4), +dateLocal.slice(5, 7) - 1, +dateLocal.slice(8, 10));
  const n = Date.UTC(+nowLocal.slice(0, 4), +nowLocal.slice(5, 7) - 1, +nowLocal.slice(8, 10));
  if (n - d === 86_400_000) return 'yesterday';
  return formatDay(ms, timeZone);
}

const URL_RE = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+\d[\d\s().-]{6,18}\d)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|\b\d{10,11}\b/g;

/**
 * Makes free text (answers, drafts, quoted notes) safe to text to self: emails and phone-shaped runs become "…",
 * links to anything but yeackbot.com are dropped. Never adds the marker.
 */
export function scrub(text: string): string {
  return stripDisallowedLinks(text.replace(EMAIL_RE, '…'))
    .replace(PHONE_RE, '…')
    .replace(URL_RE, (m, host: string) => (OUTBOUND_URL_ALLOWLIST.some((ok) => host.toLowerCase() === ok || host.toLowerCase().endsWith(`.${ok}`)) ? m.replace(/^https?:\/\//i, '') : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Cuts at a word boundary with "…" so the result is ≤ max chars. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * The final reply: marker + body, scrubbed, within `max` chars. Returns null if it still breaks an outbound rule
 * (the caller records that instead of sending).
 */
export function finalizeReply(body: string, max = MAX_OUTBOUND_CHARS): string | null {
  const clean = scrub(body.startsWith(BOT_MARKER) ? body.slice(BOT_MARKER.length) : body);
  const text = truncate(`${BOT_MARKER} ${clean}`, max);
  return checkOutboundText(text).length ? null : text;
}

/** "1, 2 and 3" */
export function listJoin(items: string[], conj = 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
}

/** Help text: the whole grammar, one command per line. */
export const HELP_TEXT = [
  "Here's what you can text me:",
  '',
  'About a suggestion (use its number, or reply right to its text):',
  '• done 2: you did it',
  '• snooze 2 2w: bring it back in 2 weeks',
  '• skip 2: not useful',
  '• wrong 2: something in it is wrong',
  '• why 2: why I suggested it',
  '• draft 2: a message you could send',
  '• more: one more suggestion',
  '',
  'Anytime:',
  '• log: coffee with Sam, moving to Denver',
  '• ? who do I know in Austin',
  '• undo, pause 1w, resume, status',
  '',
  'If it’s been a while since my last text, start with "yb".',
].join('\n');
