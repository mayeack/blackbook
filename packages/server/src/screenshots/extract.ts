/**
 * Contact details in a screenshot's OCR lines (design §3 "Extract"), deterministic and local: nothing here ever
 * reaches an LLM, and nothing is logged.
 *   - phones   libphonenumber findPhoneNumbersInText per line (default region from the owner's time zone, else US),
 *              keyed E.164 through the @yb/shared normalizer; short codes and toll-free business numbers dropped;
 *   - emails   address-shaped runs, normalized (normalizeEmail);
 *   - handles  `@handle` (not an email's '@') and instagram.com/<handle>, as Instagram usernames. On a profile
 *              only the account's own handle counts: the nav-bar username of an Instagram profile, the bare
 *              `@handle` line of an X-style one. @mentions and links in a bio point at other accounts, and
 *              resolving them would link the screenshot to whoever was mentioned;
 *   - the Instagram profile layout: a bare username line in the nav bar plus the posts / followers / following
 *              stats; the follower count is kept (`followers`: met-at ignores profiles with ≥ 5k followers);
 *   - name     the tallest name-like line in the top 45% (2–4 words of letters, no UI words, confidence ≥ 0.5);
 *   - kind     instagram_profile / contact_card (an iOS card, or a business-card-like name + phone/email) /
 *              social_profile / message (a chat) / other.
 * OCR coordinates are normalized 0–1 with the origin at the top-left (the collector's OcrLine contract).
 */
import { normalizeEmail, normalizePhone } from '@yb/shared';
import type { OcrLine } from '@yb/shared/collector/v1';
import { findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js';
import { isTollFree } from '../identity/service';
import { instagramUsername } from '../migration/convert';

export type ShotKind = 'instagram_profile' | 'contact_card' | 'social_profile' | 'message' | 'other';

export interface ExtractedContact {
  kind: ShotKind;
  /** E.164, distinct, in reading order. */
  phones: string[];
  /** Normalized addresses, distinct. */
  emails: string[];
  /** Instagram usernames (lowercase, no '@'), distinct. */
  handles: string[];
  name: string | null;
  /** The Instagram profile's follower count, when the layout shows one. */
  followers: number | null;
}

/** Anything that can become an identity: phone, email or handle. */
export const hasIdentifiers = (e: ExtractedContact): boolean => e.phones.length + e.emails.length + e.handles.length > 0;

// ---------------------------------------------------------------------------------------------- region

const ZONE_REGION: Readonly<Record<string, CountryCode>> = {
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Lisbon': 'PT',
  'Europe/Zurich': 'CH',
  'Europe/Stockholm': 'SE',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Montreal': 'CA',
  'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR',
  'Asia/Tokyo': 'JP',
  'Asia/Singapore': 'SG',
  'Asia/Hong_Kong': 'HK',
  'Asia/Kolkata': 'IN',
  'Asia/Dubai': 'AE',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Pacific/Auckland': 'NZ',
};

/** Default phone region for numbers written without a country code: the owner's zone, else US. */
export function regionForTimeZone(tz: string | null | undefined): CountryCode {
  return (tz && ZONE_REGION[tz]) || 'US';
}

// ---------------------------------------------------------------------------------------------- lines

interface Line {
  text: string;
  lower: string;
  conf: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const prep = (lines: readonly OcrLine[]): Line[] =>
  lines
    .map((l) => {
      const text = l.text.normalize('NFKC').replace(/\s+/g, ' ').trim();
      return { text, lower: text.toLowerCase(), conf: l.confidence, x: l.x, y: l.y, w: l.w, h: l.h };
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

// ---------------------------------------------------------------------------------------------- identifiers

function phonesIn(lines: Line[], region: CountryCode): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (!/\d(?:[\s().\-‐-― /]*\d){6,}/.test(l.text)) continue; // cheap pre-filter: ≥7 digits
    for (const m of findPhoneNumbersInText(l.text, region)) {
      const k = normalizePhone(m.number.number);
      if (k?.kind === 'e164' && !isTollFree(k.key)) out.push(k.key);
    }
  }
  return uniq(out);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function emailsIn(lines: Line[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(EMAIL_RE)) {
      const e = normalizeEmail(m[0].replace(/[.-]+$/, ''));
      if (e) out.push(e);
    }
  }
  return uniq(out);
}

/** Instagram paths that are never profiles. */
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv', 'about', 'legal', 'developer']);
const IG_URL_RE = /(?:^|[^\w.])(?:www\.)?(?:instagram\.com|instagr\.am)\/([A-Za-z0-9._]{1,30})/gi;
// '@' that is not an email's: no address character right before it, and no second '@' / domain right after.
const AT_HANDLE_RE = /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9._]{1,30})(?![A-Za-z0-9._]*@)/g;

const igHandle = (raw: string): string | null => {
  const u = instagramUsername(raw.replace(/\.+$/, ''));
  return u && /[a-z]/.test(u) && !IG_RESERVED.has(u) ? u : null;
};

function handlesIn(lines: Line[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(IG_URL_RE)) {
      const h = igHandle(m[1]!);
      if (h) out.push(h);
    }
    const withoutEmails = l.text.replace(EMAIL_RE, ' ');
    for (const m of withoutEmails.matchAll(AT_HANDLE_RE)) {
      const h = igHandle(m[1]!);
      if (h) out.push(h);
    }
  }
  return uniq(out);
}

const OWN_HANDLE_LINE = /^@([A-Za-z0-9._]{1,30})$/;

/** Handles standing alone on their line (an X / TikTok profile's own `@handle` under the name), not in running text. */
function ownLineHandles(lines: Line[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = OWN_HANDLE_LINE.exec(l.text.replace(BADGES, ''));
    const h = m ? igHandle(m[1]!) : null;
    if (h) out.push(h);
  }
  return uniq(out);
}

// ---------------------------------------------------------------------------------------------- layout

const STAT_LABEL = /^(?:([\d][\d.,\s]*[KkMmBb]?)\s+)?(posts?|followers?|following)$/i;

/** "12,345" / "4.5K" / "1.2M" / "1 234" → a count. */
export function parseCount(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, '');
  const m = /^(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)([KkMmBb])?$/.exec(s);
  if (!m) return null;
  const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'b'] : 1;
  const base = m[2] || !/[,.]\d{3}/.test(m[1]!) ? Number(m[1]!.replace(/,/g, '')) : Number(m[1]!.replace(/[,.]/g, ''));
  return Number.isFinite(base) ? Math.round(base * mult) : null;
}

interface Stats {
  labels: Set<string>;
  followers: number | null;
}

/** The posts / followers / following block in the top 60%, and the follower count next to (or above) its label. */
function statsIn(lines: Line[]): Stats {
  const labels = new Set<string>();
  let followers: number | null = null;
  for (const l of lines) {
    if (l.y > 0.6) continue;
    const m = STAT_LABEL.exec(l.text);
    if (!m) continue;
    const word = m[2]!.toLowerCase();
    const key = word.startsWith('post') ? 'posts' : word.startsWith('follower') ? 'followers' : 'following';
    labels.add(key);
    if (key !== 'followers' || followers !== null) continue;
    if (m[1]) {
      followers = parseCount(m[1]);
      continue;
    }
    // The number sits on its own line just above the label, horizontally overlapping it.
    const cx = l.x + l.w / 2;
    const above = lines
      .filter((o) => o !== l && o.y < l.y && l.y - o.y <= 0.08 && Math.abs(o.x + o.w / 2 - cx) <= Math.max(l.w, o.w, 0.05))
      .map((o) => parseCount(o.text))
      .filter((n): n is number => n !== null);
    followers = above.length ? above[above.length - 1]! : null;
  }
  return { labels, followers };
}

const BADGES = /[\s⌄˅∨▾▿⌵✓✔☑︎️•·]+$/u;
const USERNAME_LINE = /^[a-z0-9._]{2,30}$/;

/** Instagram's nav-bar username: a bare lowercase handle line at the very top (the status bar time excluded). */
function igUsernameLine(lines: Line[]): string | null {
  for (const limit of [0.15, 0.25]) {
    for (const l of lines) {
      if (l.y > limit) break;
      const t = l.text.replace(BADGES, '');
      if (!USERNAME_LINE.test(t) || !/[a-z]/.test(t) || UI_WORDS.has(t)) continue;
      const h = igHandle(t);
      if (h) return h;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- name

const UI_WORDS = new Set([
  'edit', 'contact', 'contacts', 'message', 'messages', 'call', 'video', 'mail', 'facetime', 'pay', 'share', 'add',
  'favorites', 'emergency', 'block', 'caller', 'follow', 'following', 'followers', 'follower', 'posts', 'post', 'profile',
  'mobile', 'home', 'work', 'iphone', 'main', 'phone', 'email', 'notes', 'cancel', 'done', 'back', 'today', 'yesterday',
  'delivered', 'read', 'imessage', 'text', 'search', 'send', 'new', 'open', 'settings', 'story', 'highlights', 'reels',
  'tagged', 'suggested', 'more', 'info', 'details', 'ringtone', 'birthday', 'address', 'photo', 'poster', 'recent',
  'recents', 'voicemail', 'keypad', 'chats', 'online', 'typing', 'unknown', 'spam', 'report', 'mute', 'notifications',
  'accounts', 'linkedin', 'instagram', 'whatsapp', 'tiktok', 'threads', 'connect', 'connections', 'messenger', 'likes',
  'joined', 'mutual', 'about', 'location', 'website', 'directions', 'audio', 'sms', 'other', 'school',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april',
  'june', 'july', 'august', 'september', 'october', 'november', 'december', 'am', 'pm', 'menu', 'view', 'all', 'see',
  'translation', 'professional', 'dashboard', 'insights', 'subscribe', 'verified', 'private', 'account', 'the', 'and',
]);

const NAME_WORD = /^\p{L}[\p{L}\p{M}'’.-]*$/u;

/** 2–4 words of letters, none a UI word, ≤ 40 chars. */
function nameLike(text: string): boolean {
  if (text.length > 40) return false;
  const words = text.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => NAME_WORD.test(w) && !UI_WORDS.has(w.toLowerCase().replace(/[.'’-]+$/, '')));
}

function nameIn(lines: Line[]): string | null {
  let best: Line | null = null;
  for (const l of lines) {
    if (l.y > 0.45 || l.conf < 0.5 || !nameLike(l.text)) continue;
    if (!best || l.h > best.h) best = l;
  }
  return best?.text ?? null;
}

// ---------------------------------------------------------------------------------------------- kind

const CARD_CUES = new Set([
  'mobile', 'home', 'work', 'iphone', 'main', 'phone', 'email', 'home email', 'work email', 'message', 'call', 'video',
  'mail', 'facetime', 'pay', 'share contact', 'add to favorites', 'add to emergency contacts', 'block caller',
  'block this caller', 'contact photo & poster', 'notes', 'send message', 'share my location', 'birthday', 'address',
  'ringtone', 'text tone', 'edit', 'school', 'other',
]);
const CHAT_CUE = /^(imessage|text message|sms|sms\/mms|delivered|read(?: \d.*)?|typing…?|typing\.\.\.|online|last seen.*|type a message|send a message|write a message|message…|message\.\.\.|imessage…)$/i;
const TIMESTAMP = /^(?:(?:today|yesterday|mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?$/i;
const SOCIAL_CUE = /^(?:followers?|following|likes|connections?|connect|follow|follow back|subscribe|joined .+|.* mutual.*|linkedin|tiktok|threads|x\.com.*|threads\.net.*)$/i;

function kindOf(lines: Line[], found: { phones: number; emails: number; handles: number; name: boolean }, ig: boolean, stats: Stats): ShotKind {
  if (ig) return 'instagram_profile';
  const ids = found.phones + found.emails;
  const cardCues = lines.filter((l) => CARD_CUES.has(l.lower)).length;
  if (cardCues >= 2 && ids > 0) return 'contact_card';
  // The status bar clock sits at the very top; a timestamp below it is a chat's.
  const chat = lines.some((l) => CHAT_CUE.test(l.text) || (l.y > 0.06 && TIMESTAMP.test(l.text)));
  if (chat) return 'message';
  const social = stats.labels.size > 0 || lines.some((l) => SOCIAL_CUE.test(l.text));
  if (social && (found.handles > 0 || found.name)) return 'social_profile';
  if (found.name && ids > 0) return 'contact_card'; // a business card or a card-like screen
  return 'other';
}

// ---------------------------------------------------------------------------------------------- entry point

export function extractContact(ocrLines: readonly OcrLine[], o: { region?: CountryCode } = {}): ExtractedContact {
  const lines = prep(ocrLines);
  const region = o.region ?? 'US';
  const phones = phonesIn(lines, region);
  const emails = emailsIn(lines);
  const handles = handlesIn(lines);
  const stats = statsIn(lines);
  // Instagram renders the username bare in the nav bar; X / TikTok / Threads show '@handle'.
  const username = stats.labels.has('posts') && (stats.labels.has('followers') || stats.labels.has('following')) ? igUsernameLine(lines) : null;
  const ig = username !== null;
  const name = nameIn(lines);
  const kind = kindOf(lines, { phones: phones.length, emails: emails.length, handles: handles.length, name: name !== null }, ig, stats);
  // A profile's identifier is its own handle; a bio's @mentions and links are other accounts.
  const own = ig ? [username] : kind === 'social_profile' ? ownLineHandles(lines) : handles;
  return { kind, phones, emails, handles: own, name, followers: ig || kind === 'social_profile' ? stats.followers : null };
}
