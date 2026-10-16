/**
 * Deterministic reply-debt text signals (intelligence §5 "Reply debt" heuristic h, 0–1):
 *   +0.4  a `?` ending a sentence
 *   +0.2  an interrogative opener (who / what / can / are / …) starting a sentence
 *   +0.3  a request or invitation phrase (can you, lmk, are you free, wanna, down to, …)
 *   +0.2  my name is mentioned
 *   +0.1  ≥ 8 words
 *   −0.4  a closer ("lol", "ok", "thanks", "sounds good", …; a whole-message closer is excluded outright, a
 *         leading closer without a question costs 0.4)
 * Plus the reason (question / request / invitation) and urgency the debt carries until an LLM verdict replaces
 * them. Pure functions: message text never leaves this module (only scores do).
 */
import { normalizeNamePart } from '@yb/shared';

/** intelligence §5, verbatim. */
export const CLOSER = /^(lol|lmao|haha+|ok(ay)?|k|thanks?|ty|np|👍|❤️|😂|sounds good|cool|nice|same)[.!]*$/iu;
const CLOSER_WORDS = new Set([
  'lol', 'lmao', 'haha', 'hahaha', 'ha', 'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'you', 'thx', 'ty', 'np', 'cool', 'nice',
  'same', 'sounds', 'good', 'great', 'perfect', 'yep', 'yup', 'yes', 'yeah', 'ya', 'sure', 'awesome', 'love', 'it', 'that',
  'omg', 'bet', 'word', 'true', 'facts', 'gotcha', 'got', 'noted', 'all', 'right', 'alright',
]);
const LEADING_CLOSER = /^(lol|lmao|haha+|ok(ay)?|k|thanks?|ty|np|cool|nice|same|sounds good|got it|gotcha|bet)\b[\s,.!]/i;
const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍️]+$/u;

const QUESTION_END = /\?+(?=\s|$|["')\]”’])/;
// At a sentence start, or after a leading "hey," / "wait," / "Avery,".
const INTERROGATIVE =
  /(?:^|[.!?]\s+|^\s*[\p{L}']+,\s+)(who|what|whats|what's|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|can|could|would|will|should|shall|have|has|had|may|might|any|anyone|r u|u)\b/iu;
const REQUEST =
  /\b(can (you|u)|could (you|u)|lmk|let me know|are (you|u) free|r u free|(you|u) free|wanna|want to (come|join|grab|get|go|hang)|down to|(you|u) down|would (you|u)|(you|u) around|are (you|u) around|join us|come (over|through|by)|send me|call me|text me|thoughts\b)/i;
const INVITATION = /\b(are (you|u) free|r u free|(you|u) free|wanna|want to (come|join|grab|get|go|hang)|down to|(you|u) down|join us|come (over|through|by))\b/i;
const URGENT = /\b(asap|urgent|urgently|emergency|right now|rn|tonight|today|in an hour|in \d+ min(ute)?s?)\b/i;
const WORD = /[\p{L}\p{N}']+/gu;

export type DebtReason = 'question' | 'request' | 'invitation' | 'plan_confirm' | 'emotional' | 'other';
export type Urgency = 'low' | 'normal' | 'high';

export interface MeNames {
  /** Normalized first name, nickname (and canonical nickname forms) of the owner. */
  names: readonly string[];
}

export const words = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

/** A message that is only a pleasantry or reaction ("lol", "ok thanks!", "👍"). */
export function isCloser(text: string | null): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (CLOSER.test(t) || EMOJI_ONLY.test(t)) return true;
  if (/[?]/.test(t)) return false;
  const w = words(t);
  return w.length > 0 && w.length <= 4 && w.every((x) => CLOSER_WORDS.has(x));
}

export const hasQuestion = (text: string): boolean => QUESTION_END.test(text);

/** My first name / nickname as a whole word. */
export function mentionsMe(text: string, me: MeNames): boolean {
  if (!me.names.length) return false;
  const norm = ` ${normalizeNamePart(text).replace(/[^\p{L}\p{N}']+/gu, ' ')} `;
  return me.names.some((n) => n.length >= 2 && norm.includes(` ${n} `));
}

/** "@Name" (or "@" + my name's normalized form). */
export function atMentionsMe(text: string, me: MeNames): boolean {
  const ats = text.match(/@[\p{L}\p{N}._-]+/gu) ?? [];
  return ats.some((a) => me.names.includes(normalizeNamePart(a.slice(1).replace(/[._-]+$/, ''))));
}

export interface HeuristicResult {
  h: number;
  reason: DebtReason | null;
  urgency: Urgency;
  closer: boolean;
  /** It asks or requests something (a question, a request or an invitation): survives my tapback. */
  asks: boolean;
}

/** h, reason and urgency of one inbound message. */
export function scoreMessage(text: string | null, me: MeNames): HeuristicResult {
  const t = (text ?? '').trim();
  if (!t) return { h: 0, reason: null, urgency: 'normal', closer: false, asks: false };
  const closer = isCloser(t);
  const q = hasQuestion(t);
  const interrogative = INTERROGATIVE.test(t);
  const request = REQUEST.test(t);
  let h = 0;
  if (q) h += 0.4;
  if (interrogative) h += 0.2;
  if (request) h += 0.3;
  if (mentionsMe(t, me)) h += 0.2;
  if (words(t).length >= 8) h += 0.1;
  if (closer || (!q && LEADING_CLOSER.test(t))) h -= 0.4;
  h = Math.max(0, Math.min(1, Math.round(h * 100) / 100));
  const reason: DebtReason | null = INVITATION.test(t) ? 'invitation' : request ? 'request' : q || interrogative ? 'question' : null;
  const urgency: Urgency = reason && URGENT.test(t) ? 'high' : 'normal';
  return { h, reason, urgency, closer, asks: reason !== null };
}

/** A URL in the text (for "send" commitments: an outbound link closes them). */
export const hasLink = (text: string | null): boolean => !!text && /(https?:\/\/|www\.)\S+/i.test(text);

/** Name forms the heuristic looks for. */
export function meNames(first: string | null, nickname: string | null, extra: Iterable<string> = []): MeNames {
  const out = new Set<string>();
  for (const raw of [first, nickname, ...extra]) {
    const n = normalizeNamePart(raw);
    if (n && n.length >= 2) out.add(n.split(' ')[0]!);
  }
  return { names: [...out] };
}

// ------------------------------------------------------------------------------------------------- `what` dedup

const STOP = new Set([
  'a', 'an', 'the', 'to', 'for', 'with', 'and', 'or', 'of', 'my', 'your', 'his', 'her', 'their', 'our', 'me', 'you', 'him',
  'them', 'us', 'i', 'we', 'he', 'she', 'they', 'it', 'on', 'at', 'in', 'this', 'that', 'some', 'up', 'will', 'ill', "i'll",
  'be', 'is', 'are', 'get', 'go', 'about', 'over', 'out', 'back', 'later', 'soon', 'next', 'week', 'weekend',
]);

/** Normalized, deduplicated tokens of a commitment's `what` ("Send Sam the gym link" → "gym link send sam"). */
export function whatNorm(what: string): string {
  const toks = new Set<string>();
  for (const w of words(what.normalize('NFKC'))) {
    if (STOP.has(w) || w.length < 2) continue;
    toks.add(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return [...toks].sort().join(' ');
}

/** Jaccard of two whatNorm strings (1 when one contains all the other's tokens and has ≤ 1 more). */
export function whatSimilarity(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const small = Math.min(A.size, B.size);
  if (inter === small && Math.max(A.size, B.size) - small <= 1) return 1;
  return inter / (A.size + B.size - inter);
}
