/**
 * Pure text helpers for extraction: line rendering pieces (links, attachments, reactions), deterministic triage,
 * quote normalization and matching (intelligence §4.5 step 3), fact value normalization + the interest synonym
 * map, string similarity, and the code-side exclusion / sensitivity screens that back up the prompt.
 */
import { isOtpOrMarketing } from '../identity/service';

// ---------------------------------------------------------------------------------------------- rendering

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;

/** Domain of a URL without "www." (lowercase), or null. */
export function linkDomain(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** URLs → `<link:domain>`. */
export function replaceLinks(text: string): string {
  return text.replace(URL_RE, (u) => {
    const d = linkDomain(u.replace(/[.,!?;:]+$/, ''));
    return d ? `<link:${d}>` : '<link>';
  });
}

/** One attachment JSON entry → `<image>`, `<video>`, `<audio>`, `<sticker>` or `<file:ext>`. */
export function attachmentToken(a: unknown): string {
  if (!a || typeof a !== 'object') return '<file>';
  const o = a as Record<string, unknown>;
  if (o.is_sticker === true || o.is_sticker === 1 || o.kind === 'sticker' || o.type === 'sticker') return '<sticker>';
  const mime = String(o.mime ?? o.mimeType ?? o.mime_type ?? '').toLowerCase();
  const kind = String(o.kind ?? o.type ?? '').toLowerCase();
  const uti = String(o.uti ?? '').toLowerCase();
  const probe = `${mime} ${kind} ${uti}`;
  if (/image|photo|jpeg|png|heic|gif/.test(probe)) return '<image>';
  if (/video|movie|mpeg-4|quicktime/.test(probe)) return '<video>';
  if (/audio|voice|ptt|m4a/.test(probe)) return '<audio>';
  const name = typeof o.name === 'string' ? o.name : typeof o.fileName === 'string' ? o.fileName : '';
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? (/\/([a-z0-9]{1,5})$/.exec(mime)?.[1] ?? null);
  return ext ? `<file:${ext}>` : '<file>';
}

export function attachmentTokens(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.map(attachmentToken) : [];
  } catch {
    return [];
  }
}

const REACTION_EMOJI: Record<string, string> = {
  love: '❤',
  loved: '❤',
  heart: '❤',
  like: '👍',
  liked: '👍',
  dislike: '👎',
  disliked: '👎',
  laugh: '😂',
  laughed: '😂',
  haha: '😂',
  emphasize: '‼',
  emphasized: '‼',
  question: '❓',
  questioned: '❓',
};

export function reactionGlyph(type: string, emoji: string | null): string {
  if (emoji && emoji.trim()) return emoji.trim().slice(0, 8);
  return REACTION_EMOJI[type.toLowerCase()] ?? '•';
}

/** One message's text in a window (longer pastes are cut; quotes are checked against exactly what was sent). */
export const MESSAGE_CHARS = 700;

/** One line of message text: newlines flattened, links reduced to their domain, long messages cut. */
export function lineText(text: string | null, maxChars = 1200): string {
  if (!text) return '';
  let t = replaceLinks(text.normalize('NFC'))
    .replace(/[\r\n\u2028\u2029]+/g, ' / ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffc]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars - 1).trimEnd()}…`;
  return t;
}

// ---------------------------------------------------------------------------------------------- triage

const TAPBACK_TEXT = /^(?:loved|liked|disliked|laughed at|emphasized|questioned|reacted [^ ]+ to)\s+[“"«].*[”"»]\s*$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}\u200d\ufe0f\s!?.]+$/u;
const LINK_ONLY = /^\s*(?:<link(?::[^>]*)?>\s*)+$/;
const PLACEHOLDER_ONLY = /^\s*(?:<[a-z]+(?::[^>]*)?>\s*)+$/;

/** Words in a message (letters/digits runs; placeholders don't count). */
export function wordCount(text: string): number {
  return (text.replace(/<[^>]+>/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

export interface TriageMessage {
  kind: string;
  text: string | null;
  attachments: string | null;
}

/**
 * Trivial for extraction: a tapback-as-text, attachment/sticker-only, under 3 words, emoji-only, OTP/marketing,
 * or a bare link (a link preview duplicate). A window whose NEW messages are all trivial is dropped.
 */
export function isTrivialMessage(m: TriageMessage): boolean {
  const raw = (m.text ?? '').trim();
  if (!raw) return true;
  if (m.kind === 'sticker') return true;
  if (TAPBACK_TEXT.test(raw)) return true;
  if (isOtpOrMarketing(raw)) return true;
  const t = lineText(raw);
  if (LINK_ONLY.test(t) || PLACEHOLDER_ONLY.test(t)) return true;
  if (EMOJI_ONLY.test(t)) return true;
  return wordCount(t) < 3;
}

// ---------------------------------------------------------------------------------------------- quotes

const QUOTE_MAP: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '′': "'", '″': '"' };

/** NFKC, lowercase, straight quotes, collapsed whitespace, edge punctuation trimmed. */
export function normQuote(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛“”„‟′″]/g, (c) => QUOTE_MAP[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'.,;:!?…()[\]{}-]+|[\s"'.,;:!?…()[\]{}-]+$/g, '');
}

const tokens = (s: string): string[] => normQuote(s).split(/[^\p{L}\p{N}<>:'-]+/u).filter(Boolean);

/** Token-set ratio in [0,1] (|A∩B| / |A|, A = quote tokens): how much of the quote the message contains. */
export function tokenSetRatio(quote: string, text: string): number {
  const a = new Set(tokens(quote));
  if (!a.size) return 0;
  const b = new Set(tokens(text));
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

export type QuoteCheck = 'ok' | 'too_short' | 'too_long' | 'not_found';

/** Quote length 3–200 chars; substring after normalization, or (≥30 chars) a token-set ratio ≥0.9. */
export function checkQuote(quote: string, messageText: string): QuoteCheck {
  const q = normQuote(quote);
  if (q.length < 3) return 'too_short';
  if (quote.trim().length > 200) return 'too_long';
  const t = normQuote(messageText);
  if (t.includes(q)) return 'ok';
  if (q.length >= 30 && tokenSetRatio(q, t) >= 0.9) return 'ok';
  return 'not_found';
}

// ---------------------------------------------------------------------------------------------- values

/** Synonyms folded before dedup (interest_vocab). Keys and values are normalized forms. */
export const INTEREST_VOCAB: Readonly<Record<string, string>> = {
  'rock climbing': 'climbing',
  'indoor climbing': 'climbing',
  'bouldering': 'climbing',
  'hikes': 'hiking',
  'hike': 'hiking',
  'trail running': 'running',
  'long distance running': 'running',
  'marathons': 'running',
  'runs': 'running',
  'jogging': 'running',
  'yoga classes': 'yoga',
  'hot yoga': 'yoga',
  'board games': 'board games',
  'boardgames': 'board games',
  'tabletop games': 'board games',
  'video gaming': 'video games',
  'gaming': 'video games',
  'f1': 'formula 1',
  'formula one': 'formula 1',
  'ceramics': 'pottery',
  'wheel throwing': 'pottery',
  'skiing and snowboarding': 'skiing',
  'downhill skiing': 'skiing',
  'live music': 'concerts',
  'gigs': 'concerts',
  'cooking at home': 'cooking',
  'baking': 'baking',
  'road cycling': 'cycling',
  'biking': 'cycling',
  'bike riding': 'cycling',
  'photography': 'photography',
  'film photography': 'photography',
  'movies': 'film',
  'cinema': 'film',
  'watching movies': 'film',
  'natural wine': 'wine',
  'wine tasting': 'wine',
  'craft beer': 'beer',
  'reading': 'books',
  'reading books': 'books',
  'book club': 'books',
};

/** Normalized fact value: NFKC, lowercase, punctuation stripped, whitespace collapsed, synonyms folded. */
export function normValue(value: string, cat?: string): string {
  let v = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' &+-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '');
  if (cat === undefined || cat === 'interest' || cat === 'activity_pref' || cat === 'food_drink') {
    v = INTEREST_VOCAB[v] ?? v;
  }
  return v.slice(0, 200);
}

/** Jaro–Winkler similarity in [0,1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ---------------------------------------------------------------------------------------------- screens

/** Life events are never facts (PLAN: life events & birthday detection is not built). */
const LIFE_EVENT =
  /\b(?:birth ?days?|bday|b-day|anniversar(?:y|ies)|pregnan\w*|expecting a baby|due date|newborn|gave birth|baby shower|passed away|died|death|funeral|memorial|obituary|diagnos\w*|cancer|chemo\w*|tumou?r|surgery|miscarr\w*|engaged|engagement|wedding|married|divorc\w*|turn(?:s|ed|ing)? \d{2}|\d{1,3} years? old|age \d{1,3})\b/i;

export const isLifeEventText = (s: string): boolean => LIFE_EVENT.test(s);

/** Health, sex, money, breakup and similar topics: any fact that touches them is flagged sensitive. */
const SENSITIVE =
  /\b(?:therap\w*|depress\w*|anxiety|adhd|autis\w*|medicat\w*|rehab|sober|sobriety|addict\w*|hiv|std|sti|ivf|fertility|sexual\w*|gay|lesbian|bisexual|queer|trans(?:gender)?|dating app|hookup|break ?up|broke up|separated|debt|bankrupt\w*|loan|salary|evict\w*|lawsuit|arrest\w*|court case|immigration|visa status|religio\w*|church|mosque|synagogue|politic\w*|democrat|republican|disabilit\w*|illness|sick|hospital\w*|injur\w*)\b/i;

export const isSensitiveText = (s: string): boolean => SENSITIVE.test(s);

/** Something that looks like an identifier slipped into a value (placeholders, digit runs, at-signs). */
export const looksLikeIdentifier = (s: string): boolean => /<(?:phone|email|handle|addr|num)\b|@|\d{6,}/i.test(s);

/** Truncates at the last sentence end within `max` chars (else a word boundary). */
export function truncateAtSentence(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= max * 0.5) return cut.slice(0, end + 1);
  const sp = cut.lastIndexOf(' ');
  return `${cut.slice(0, sp > 0 ? sp : max).trimEnd()}…`;
}
