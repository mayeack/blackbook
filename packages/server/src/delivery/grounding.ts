/**
 * The digest composer's grounding validator (PLAN "Digest"; intelligence §5 "Digest composer"). LLM copy for an
 * item is used only when ALL of these hold; any violation sends that item back to template copy:
 *   - cites ⊆ the item's packet ref ids, and an item with openers cites ≥1 id;
 *   - headline 1–90 chars, body ≤240, ≤2 openers each 1–160 chars (the API doesn't enforce bounds);
 *   - every capitalized token, number and date in the copy appears in the packet text the model saw, or in the
 *     whitelist (weekday/month names and common sentence words) — so invented names, places and dates fail;
 *   - no URLs, emails, phone numbers, @handles, money amounts, or quotes longer than 6 words in headline/body.
 * Pure; exported for tests.
 */

export interface ComposerItemOut {
  n: number;
  headline: string;
  body: string | null;
  openers: string[];
  cites: string[];
}

export interface GroundingPacket {
  /** Exactly the (pseudonymized) text the model was given for the whole digest. */
  text: string;
  /** Ref ids the model may cite for this item. */
  refIds: ReadonlySet<string>;
}

export const LIMITS = { headline: 90, body: 240, openers: 2, opener: 160, quoteWords: 6 } as const;

const WEEKDAYS = ['mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'weds', 'wednesday', 'thu', 'thur', 'thurs', 'thursday', 'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday'];
const MONTHS = ['jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december'];

/** Words that may be capitalized without appearing in the packet (sentence starts, greetings, plain nouns). */
const COMMON = `
a about after again ago all also am an and any anything are around as ask asked at away back be been before best
big brief but busy by call can catch catching check checked checking coffee come congrats congratulations could
day days did dinner do does doing done drink drinks easy every fancy few finally follow for free fresh friday from
fun get give glad go going good got grab great had happy has have haven't he heads hello her hey hi his hope how
however i if in intro introduce is it its it's just keep last let let's like long look looking lots love lunch
made make maybe me meet miss missed more morning most much my need new next nice no not now of oh ok okay on once
one or our out over own ping plan plans quick quiet reach reconnect remember reminder reply say saw see send
share she should since so some soon sorry still sure take talk text thank thanks that the their them then there
these they thing things think this those thought time to today tomorrow tonight too touch trip try two up us very
want was way we week weekend well were what when where which while who why will wish with would yes yesterday
yet you your yours it'd i'd i'll i'm i've you're you'd you'll we're they're that's what's how's here's there's
evening afternoon brunch breakfast drinks walk hang hangout chat call ages overdue promise promised said owe
owed waiting wait waited follow-up update news ready
`
  .split(/\s+/)
  .filter(Boolean);

export const DEFAULT_WHITELIST: ReadonlySet<string> = new Set([...WEEKDAYS, ...MONTHS, ...COMMON, 'ok', 'tbd', 'fyi', 'asap', 'btw']);

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+\d[\d\s().-]{6,18}\d)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|\b\d{7,}\b/;
const HANDLE_RE = /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9._]{2,30}\b/;
const MONEY_RE = /[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:dollars|usd|bucks|eur|gbp|k)\b/i;
const QUOTE_RE = /["“”]([^"“”]+)["“”]/g;
/**
 * Topics a brief never brings up (health, money trouble, pregnancy, deaths, breakups, …). A coarse screen on top
 * of the prompt rule and the sensitive-fact filter: a hit sends the item back to template copy, and message lines
 * that hit never enter the packet.
 */
export const SENSITIVE_RE =
  /\b(?:cancer|chemo\w*|diagnos\w*|surgery|hospital\w*|illness|sick|therap\w*|rehab|pregnan\w*|miscarr\w*|funeral|died|passed away|death|divorc\w*|break ?up|broke up|separat(?:ed|ion)|debt|loan|bankrupt\w*|salary|laid off|fired|arrest\w*|lawsuit|abortion|depress\w*|anxiety|suicid\w*|overdose|sex\w*)\b/i;

/** Words of a text: letters/digits with inner apostrophes/hyphens. */
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/** Word sets of the packet: exact words, and digit groups. */
export function packetVocabulary(text: string): { words: Set<string>; numbers: Set<string> } {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const w of text.match(WORD_RE) ?? []) {
    words.add(w);
    words.add(w.replace(/['’]s$/u, ''));
  }
  for (const n of text.match(/\d+/g) ?? []) numbers.add(String(Number(n)));
  return { words, numbers };
}

/** Problems with one copy string (no grounding: identifiers, links, money, long quotes). */
function safetyIssues(field: string, s: string, quotes: boolean): string[] {
  const out: string[] = [];
  if (URL_RE.test(s)) out.push(`${field}: contains a link`);
  if (EMAIL_RE.test(s)) out.push(`${field}: contains an email`);
  if (PHONE_RE.test(s)) out.push(`${field}: contains a phone number`);
  if (HANDLE_RE.test(s)) out.push(`${field}: contains a handle`);
  if (MONEY_RE.test(s)) out.push(`${field}: contains an amount`);
  if (s.includes('\u{1F168}')) out.push(`${field}: contains the bot marker`);
  if (SENSITIVE_RE.test(s)) out.push(`${field}: touches a sensitive topic`);
  if (quotes) {
    for (const m of s.matchAll(QUOTE_RE)) {
      if ((m[1]!.match(WORD_RE) ?? []).length > LIMITS.quoteWords) out.push(`${field}: quote longer than ${LIMITS.quoteWords} words`);
    }
  }
  return out;
}

/** Capitalized tokens and numbers in `s` that the packet doesn't support. */
export function ungroundedTokens(s: string, vocab: { words: Set<string>; numbers: Set<string> }, whitelist: ReadonlySet<string> = DEFAULT_WHITELIST): string[] {
  const bad: string[] = [];
  for (const raw of s.match(WORD_RE) ?? []) {
    const w = raw.replace(/['’]s$/u, '');
    if (/\d/.test(w)) {
      // Capitalized alphanumerics are tokens (P1a) or codes: they must appear verbatim.
      if (/^\p{Lu}/u.test(w)) {
        if (!vocab.words.has(w) && !vocab.words.has(raw)) bad.push(raw);
        continue;
      }
      const groups = w.match(/\d+/g) ?? [];
      if (groups.some((g) => !vocab.numbers.has(String(Number(g))))) bad.push(raw);
      continue;
    }
    if (!/^\p{Lu}/u.test(w)) continue;
    if (vocab.words.has(w) || vocab.words.has(raw)) continue;
    const lower = raw.toLowerCase().replace(/’/g, "'");
    if (whitelist.has(lower) || whitelist.has(w.toLowerCase())) continue;
    bad.push(raw);
  }
  return bad;
}

/** Every reason this item's LLM copy can't be used (empty = grounded). */
export function groundingIssues(out: ComposerItemOut, packet: GroundingPacket, whitelist: ReadonlySet<string> = DEFAULT_WHITELIST): string[] {
  const issues: string[] = [];
  const headline = out.headline.trim();
  if (!headline) issues.push('headline: empty');
  if (headline.length > LIMITS.headline) issues.push(`headline: longer than ${LIMITS.headline}`);
  if (out.body !== null && out.body.length > LIMITS.body) issues.push(`body: longer than ${LIMITS.body}`);
  if (out.openers.length > LIMITS.openers) issues.push(`more than ${LIMITS.openers} openers`);
  out.openers.forEach((o, i) => {
    if (!o.trim()) issues.push(`opener ${i + 1}: empty`);
    if (o.length > LIMITS.opener) issues.push(`opener ${i + 1}: longer than ${LIMITS.opener}`);
  });
  for (const c of out.cites) if (!packet.refIds.has(c)) issues.push(`cite ${c.slice(0, 12)}: not in the packet`);
  if (out.openers.length && !out.cites.length) issues.push('openers without a citation');

  const vocab = packetVocabulary(packet.text);
  const fields: [string, string, boolean][] = [
    ['headline', headline, true],
    ['body', out.body ?? '', true],
    ...out.openers.map((o, i): [string, string, boolean] => [`opener ${i + 1}`, o, false]),
  ];
  for (const [field, s, quotes] of fields) {
    if (!s) continue;
    issues.push(...safetyIssues(field, s, quotes));
    const bad = ungroundedTokens(s, vocab, whitelist);
    if (bad.length) issues.push(`${field}: ungrounded ${bad.length === 1 ? 'token' : 'tokens'} (${bad.length})`);
  }
  return issues;
}
