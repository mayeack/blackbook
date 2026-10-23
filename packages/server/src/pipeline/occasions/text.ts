/**
 * Text helpers for calendar occasions: cleaning Google descriptions, Partiful links, venue keys, distinctive
 * tokens for message cross-referencing, ticket counts and the people the owner wrote into a title or notes
 * ("Drinks w/ Sam", "Sam & Alex", "Jo has my ticket"). Pure functions; nothing here touches the database.
 */
import { normalizeNamePart } from '@yb/shared';

/** Google descriptions are HTML-ish: tags, entities, <br>. Returns plain text, at most `max` chars. */
export function plainText(raw: string | null | undefined, max = 2000): string {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .slice(0, max)
    .trim();
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
export const withoutUrls = (s: string): string => s.replace(URL_RE, ' ');

const PARTIFUL_LINK = /partiful\.com\/e\/([A-Za-z0-9_-]{6,64})/gi;
const PARTIFUL_UID = /^(?:partiful[-_:])?([A-Za-z0-9_-]{6,64})@(?:[a-z0-9-]+\.)*partiful\.com$/i;

/** Every partiful.com/e/<id> in the given strings (first-seen order, unique). */
export function partifulIdsIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) if (t) for (const m of t.matchAll(PARTIFUL_LINK)) out.add(m[1]!);
  return [...out];
}

/** The Partiful event id inside a subscribed-feed iCal UID ("<id>@partiful.com"), if it is one. */
export function partifulIdFromUid(uid: string | null | undefined): string | null {
  const m = uid ? PARTIFUL_UID.exec(uid.trim()) : null;
  return m ? m[1]! : null;
}

// ------------------------------------------------------------------------------------------------ venues

const RESERVATION = /^\s*(?:your\s+)?(?:reservation|reservations|booking|table)\s+(?:at|for|@)\s+(.+?)\s*$/i;
const RESERVATION_TAIL = /\s*(?:[-–—|,(]|\bfor\s+\d|\bon\s+\w+day\b|\bat\s+\d).*$/i;

/** "Reservation at <venue>" (Gmail / OpenTable / Resy style). Returns the venue, or null. */
export function reservationVenue(title: string | null | undefined): string | null {
  const m = title ? RESERVATION.exec(title) : null;
  if (!m) return null;
  const v = m[1]!.replace(RESERVATION_TAIL, '').trim();
  return v.length >= 2 ? v : null;
}

const TITLE_VENUE = /(?:\s@\s*|\sat\s+)(\p{Lu}[\p{L}\p{N}'’&.-]*(?:\s+(?:&|of|the|de|la|\p{Lu}[\p{L}\p{N}'’&.-]*)){0,5})/u;

/** A capitalized venue after " at " / " @ " in a title ("Dinner w/ Sam at Lupa" → "Lupa"). */
export function venueFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const r = reservationVenue(title);
  if (r) return r;
  const m = TITLE_VENUE.exec(` ${title}`);
  if (!m) return null;
  const v = m[1]!.trim();
  return /^\d/.test(v) || v.length < 2 ? null : v;
}

/**
 * Normalized venue: the first line/segment of the location (Google puts "Venue, street, city"), diacritics and
 * punctuation folded, a leading "the" dropped, "&" → "and". "" when nothing usable is left.
 */
export function venueKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const first = withoutUrls(raw).split(/[\n,;|]/)[0] ?? '';
  return normalizeNamePart(first)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

// ------------------------------------------------------------------------------------------------ tokens

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have i in is it its me my of on or our so that the their them then there
  they this to up us was we were will with w you your yours im ill ive dont cant just get got go going gonna lets let
  see u ur yes no ok okay yeah yep lol haha omg pls please thanks thank hi hey hello all any some more very really
  what when where who why how which than too also can could would should do does did done not now new one two
  am pm today tonight tomorrow tmrw week weekend night day time`.split(/\s+/),
);

/** Words that say what kind of event it is, never which one. */
const EVENT_WORDS = new Set(
  `dinner lunch brunch breakfast drinks drink coffee cocktails happy hour party bday birthday concert show gig tickets
  ticket tix reservation reservations booking table event meetup hang hangout catch catchup date celebration
  festival game match movie night out evening afternoon morning trip visit plans plan rsvp invite invited partiful
  venue restaurant bar cafe club pub house home apt apartment place downtown nyc sf la`.split(/\s+/),
);

/** Words in venue names that say what kind of place it is, never which one. */
export const VENUE_WORDS = new Set(
  `hall room rooms park center centre theater theatre house club bar cafe kitchen grill tavern lounge garden gardens studio
  arena stadium field plaza square street ave avenue road building loft gallery museum church library school hotel inn pub
  brewery winery market space venue restaurant bistro diner pizzeria bakery coffee tea social terrace rooftop hotel
  ballroom auditorium amphitheater bowl pavilion warehouse station pier beach court courts`.split(/\s+/),
);

/**
 * Words that appear in titles and venues but say nothing about which event a message means: days and months ("Taco
 * Tuesday" vs. "free tuesday?"), chat words ("Sounds at the Orchard" vs. "sounds good"), and address parts (a message
 * with "Los Angeles" in it is not about a party on a street there). Measured by `yb eval attendance`: these made
 * almost every "mention" clue.
 */
const GENERIC_TOKENS = new Set(
  `monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun mondays
  tuesdays wednesdays thursdays fridays saturdays sundays january february march april june july august september
  october november december jan feb mar apr jun jul aug sep sept oct nov dec weekly monthly annual
  sounds sound good great fun best big little after down back out off live love free open special first last next
  late early friends presents present feat featuring vol part official edition series session sessions
  los angeles hollywood santa monica san francisco york brooklyn manhattan city county downtown midtown uptown
  north south east west street ave avenue blvd boulevard road drive lane way place court suite unit floor`.split(/\s+/),
);

/** Lowercased word tokens (letters/digits), diacritics folded. */
export function words(text: string): string[] {
  return normalizeNamePart(withoutUrls(text))
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Distinctive tokens of an occasion (title, venue): no stopwords, no event-kind words, no digits-only tokens, no
 * names of the people in it (a message saying "Sam" is not about the dinner). At most `max`, longest first.
 */
export function distinctiveTokens(texts: (string | null | undefined)[], exclude: Iterable<string> = [], max = 8): string[] {
  const skip = new Set([...exclude].flatMap((e) => words(e)));
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of words(t)) {
      if (w.length < 3 || /^\d+$/.test(w) || STOPWORDS.has(w) || EVENT_WORDS.has(w) || GENERIC_TOKENS.has(w) || skip.has(w)) continue;
      out.add(w);
    }
  }
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, max);
}

/** Words that say what kind of get-together something is ("dinner tmrw?", "thanks for having us for brunch"). */
const KIND_WORDS = new Set(
  'dinner lunch brunch breakfast drinks drink coffee cocktails party bday birthday concert show gig tickets tix game match movie festival date'.split(' '),
);

/** The kind words in these texts. */
export function kindWordsOf(...texts: (string | null | undefined)[]): Set<string> {
  return new Set(words(texts.filter(Boolean).join(' ')).filter((w) => KIND_WORDS.has(w)));
}

/**
 * Capitalized words of a title that could be someone's name ("Spotlight for Nico", "Ari's Lakeside
 * Birthday"), normalized. Kind-of-event, venue, day and filler words are never names here.
 */
export function titleNameWords(title: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const raw of withoutUrls(title ?? '').split(/[^\p{L}'’-]+/u)) {
    const w = raw.replace(/['’]s$/u, '').replace(/^['’-]+|['’-]+$/gu, '');
    if (w.length < 3 || !/^\p{Lu}/u.test(w)) continue;
    const norm = normalizeNamePart(w);
    if (!norm || STOPWORDS.has(norm) || EVENT_WORDS.has(norm) || GENERIC_TOKENS.has(norm) || VENUE_WORDS.has(norm) || GENERIC_MENTIONS.has(norm)) continue;
    out.add(norm);
  }
  return [...out];
}

/**
 * The venue's own name for token matching: the first segment of a location, unless that segment is a street address
 * ("100 Example St, Springfield" has no name, and its street and city words are not about any one event).
 */
export function venueName(raw: string | null | undefined): string {
  const first =
    withoutUrls(raw ?? '')
      .split(/[\n,;|]/)[0]
      ?.trim() ?? '';
  return /^\d/.test(first) ? '' : first;
}

// ------------------------------------------------------------------------------------------------ tickets

const TICKET_COUNT = /\b(\d{1,2})\s*(?:x\s*)?(?:ga\s+|vip\s+|general admission\s+)?(?:tix|tickets?|seats?)\b|\b(?:tix|tickets?)\s*(?:x|×)\s*(\d{1,2})\b/i;
const QUANTITY = /\b(?:qty|quantity)\s*:?\s*(\d{1,2})\b/i;
const WORD_COUNTS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, pair: 2 };
const WORD_TICKETS = /\b(two|three|four|five|six|pair of)\s+(?:ga\s+)?(?:tix|tickets?)\b/i;

/** "4 tickets", "tix x3", "two tickets", "Quantity: 2" (only next to the word ticket). 1–20, else null. */
export function ticketCount(...texts: (string | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const raw of texts) {
    if (!raw) continue;
    const t = withoutUrls(raw);
    const m = TICKET_COUNT.exec(t);
    const w = WORD_TICKETS.exec(t);
    const q = /ticket|tix/i.test(t) ? QUANTITY.exec(t) : null;
    const n = m ? Number(m[1] ?? m[2]) : w ? WORD_COUNTS[w[1]!.toLowerCase().replace(' of', '')]! : q ? Number(q[1]) : null;
    if (n !== null && n >= 1 && n <= 20) best = Math.max(best ?? 0, n);
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ people mentions

export type MentionPattern = 'with' | 'pair' | 'ticket' | 'list';
export interface Mention {
  /** As written (trimmed, possessive dropped). */
  surface: string;
  /** normalizeNamePart(surface) */
  norm: string;
  where: 'title' | 'notes';
  pattern: MentionPattern;
  role: 'companion' | 'ticket_holder';
  /** Every word starts with a capital letter. */
  capitalized: boolean;
}

/** Never people: pronouns, collectives, filler. (Relations like "mom" stay mentions; they just rarely resolve.) */
export const GENERIC_MENTIONS = new Set(
  `me myself you him her them us everyone everybody all friends friend family fam team crew gang group squad folks
  people guys girls boys kids others tbd tba someone somebody anyone company coworkers colleagues work office
  roommates neighbors`.split(/\s+/),
);

const isGeneric = (norm: string) => {
  const bare = norm.replace(/^(?:the|my|our|a) /, '');
  return GENERIC_MENTIONS.has(bare) || bare === 'plus one' || bare === '+1' || bare.split(' ').every((w) => GENERIC_MENTIONS.has(w) || EVENT_WORDS.has(w));
};

const WITH = /(?:^|[\s(])(?:w\/\s*|w\.\s+|with\s+)(.+)$/iu;
/** Where a "w/" list ends: venue, time, separators. */
const WITH_END =
  /\s+(?:at|in|on|for|to|from|tonight|today|tomorrow|tmrw|this|next|after|before)\b.*$|\s*[@\-–—|:;()[\]!?].*$|\s+\d{1,2}(?::\d\d)?\s*(?:am|pm)?\b.*$/iu;
const LIST_SPLIT = /\s*(?:,|&|\+|\/|\band\b|\bn\b)\s*/iu;
const NAME_WORD = /^[\p{L}][\p{L}'’.-]*$/u;
const CAPITAL = /^\p{Lu}/u;

const PAIR = /(?:^|[\s(:,])(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)\s*(?:&|\+|\band\b)\s*(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)(?=$|[\s,.!?:;)'’])/gu;
// No /i flag: under it \p{Lu} would match lowercase too, so the keywords spell out their capitals.
const TIX = '(?:[Tt]ix|[Tt]ickets?)';
const NAME = String.raw`(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)`;
const TICKET_HOLDER = [
  new RegExp(String.raw`${NAME}\s+(?:has|have|got|bought|holds?|is holding)\s+(?:my|the|our|a|his|her|their)?\s*(?:extra\s+)?${TIX}\b`, 'gu'),
  new RegExp(String.raw`${TIX}\s+(?:for|from|via|with)\s+${NAME}`, 'gu'),
  new RegExp(String.raw`(\p{Lu}[\p{L}-]+)['’]s\s+${TIX}\b`, 'gu'),
];

function cleanSurface(raw: string): string {
  return raw
    .replace(/['’]s$/u, '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.!?,]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Event words around a name in Title Case ("Sam & Alex Dinner") are not part of it. */
function trimEventWords(surface: string): string {
  const parts = surface.split(' ');
  const filler = (w: string) => EVENT_WORDS.has(w.toLowerCase()) || STOPWORDS.has(w.toLowerCase());
  while (parts.length > 1 && filler(parts[0]!) && !/^(the|my|our)$/i.test(parts[0]!)) parts.shift();
  while (parts.length > 1 && filler(parts[parts.length - 1]!)) parts.pop();
  return parts.join(' ');
}

function toMention(raw: string, where: Mention['where'], pattern: MentionPattern, role: Mention['role']): Mention | null {
  const surface = trimEventWords(cleanSurface(raw));
  const parts = surface.split(' ');
  if (!surface || surface.length > 40 || parts.length > 4) return null;
  // "the climbing crew" may be a group nickname: articles allowed there, but every other word must be a word.
  const body = parts[0]!.toLowerCase() === 'the' || parts[0]!.toLowerCase() === 'my' ? parts.slice(1) : parts;
  if (!body.length || !body.every((p) => NAME_WORD.test(p))) return null;
  const norm = normalizeNamePart(surface);
  if (!norm) return null;
  return { surface, norm, where, pattern, role, capitalized: body.every((p) => CAPITAL.test(p)) };
}

function withList(text: string, where: Mention['where']): Mention[] {
  const m = WITH.exec(text);
  if (!m) return [];
  const list = m[1]!.replace(WITH_END, '');
  return list
    .split(LIST_SPLIT)
    .map((s) => toMention(s, where, 'with', 'companion'))
    .filter((x): x is Mention => x !== null);
}

/**
 * People named in a title or notes. Title: "w/ A, B & C" lists and "A & B" pairs. Notes: the same per line, plus
 * ticket holders ("Jo has my ticket") and lines that are only a comma list of capitalized names. Generic words
 * ("w/ friends") are dropped; possible group nicknames ("w/ the Climbing Crew") are kept for group matching.
 */
export function parseMentions(title: string | null | undefined, notes: string | null | undefined): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const add = (m: Mention | null) => {
    if (!m || seen.has(`${m.norm}|${m.role}`)) return;
    if (isGeneric(m.norm) && m.pattern !== 'with') return;
    seen.add(`${m.norm}|${m.role}`);
    out.push(m);
  };
  const scan = (text: string, where: Mention['where']) => {
    for (const re of TICKET_HOLDER) for (const m of text.matchAll(re)) add(toMention(m[1]!, where, 'ticket', 'ticket_holder'));
    withList(text, where).forEach(add);
    for (const m of text.matchAll(PAIR)) {
      add(toMention(m[1]!, where, 'pair', 'companion'));
      add(toMention(m[2]!, where, 'pair', 'companion'));
    }
  };
  if (title) scan(withoutUrls(title), 'title');
  for (const line of plainText(notes).split('\n')) {
    const l = withoutUrls(line).trim();
    if (!l) continue;
    scan(l, 'notes');
    const items = l.split(/\s*,\s*/);
    if (items.length >= 2 && items.every((i) => /^\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?$/u.test(i))) {
      for (const i of items) add(toMention(i, 'notes', 'list', 'companion'));
    }
  }
  // A generic "with" item ("w/ friends", "w/ my fam") is noise; "w/ the crew" stays, it may be a group chat's name.
  return out.filter((m) => !(m.pattern === 'with' && isGeneric(m.norm) && !/^the /.test(m.norm)));
}

/** Normalized group-chat / circle title for nickname matching: no emoji, punctuation, leading "the"/"my". */
export function groupKey(raw: string | null | undefined): string {
  return normalizeNamePart(raw)
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|my|our) /, '');
}
