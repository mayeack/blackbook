/**
 * Citation ids and answer post-processing for Ask (intelligence §7 "Citations").
 *
 * Ids the model sees and cites:
 *   m:<base36 messages.id>   F<base36 facts.seq>   E<base36 ask_fts_docs.n>   P<token> (egress pseudonym; ME = owner)
 * Numbers are base36 so no id ever reads as a digit run the egress scrubber would replace (≥6 digits → <num>) or a
 * phone number the scanner would block (10–11 digits). Only ids a tool returned in the session are valid; every
 * other id is stripped server-side and counted as a violation.
 */
import { secondPerson } from '../llm/secondPerson';

export const b36 = (n: number): string => n.toString(36);

export function parseB36(s: string): number | null {
  if (!/^[0-9a-z]{1,10}$/.test(s)) return null;
  const n = parseInt(s, 36);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const messageRef = (id: number): string => `m:${b36(id)}`;
export const factRef = (seq: number): string => `F${b36(seq)}`;
export const eventRef = (n: number): string => `E${b36(n)}`;

export type RefKind = 'message' | 'fact' | 'event' | 'person';

export function refKind(ref: string): RefKind | null {
  if (/^m:[0-9a-z]{1,10}$/.test(ref)) return 'message';
  if (/^F[0-9a-z]{1,10}$/.test(ref)) return 'fact';
  if (/^E[0-9a-z]{1,10}$/.test(ref)) return 'event';
  if (/^P[0-9a-z]{1,10}$/.test(ref)) return 'person';
  return null;
}

export function decodeRef(ref: string): { kind: 'message' | 'fact' | 'event'; n: number } | { kind: 'person'; token: string } | null {
  const kind = refKind(ref);
  if (!kind) return null;
  if (kind === 'person') return { kind, token: ref };
  const n = parseB36(kind === 'message' ? ref.slice(2) : ref.slice(1));
  return n === null ? null : { kind, n };
}

const ID = String.raw`(?:m:[0-9a-z]{1,10}|[FEP][0-9a-z]{1,10})`;
/** `[F1a]`, `[m:2n9c, F3]`, `[E4; P1a]` (with the space before it, so a stripped group leaves no double space). */
const GROUP_RE = new RegExp(String.raw`( ?)\[(${ID}(?:\s*[,;]\s*${ID})*)\]`, 'g');
const SINGLE_RE = new RegExp(String.raw`\[(${ID})\]`, 'g');
/** A bare person token in prose (P1a, P1a's). */
const TOKEN_RE = /\b(P[0-9a-z]{1,10})\b/g;

export interface ProcessOptions {
  /** Citation ids valid in this session (returned by a tool this turn or earlier in the conversation). */
  citable: ReadonlySet<string>;
  /** Display string for a person token ('P1a' → 'Sam Rivera'), or null when it isn't a visible person. */
  personName: (token: string) => string | null;
  /** First name for a person token (used to fold "Sam R. (P1a)" into the token). */
  personFirst?: (token: string) => string | null;
  /** What ME reads as ("you"). */
  me?: string;
}

export interface ProcessedAnswer {
  /** Display text: valid citations only, person tokens replaced by names. */
  text: string;
  /** Same validation, tokens intact (stored as model_answer; replayed in follow-ups). */
  modelText: string;
  /** Valid cited ids, in order of first appearance. */
  cited: string[];
  /** Person tokens mentioned (bare or cited), in order of first appearance. */
  personTokens: string[];
  /** Ids the model cited that no tool returned (stripped). */
  violations: number;
}

/** An id the model wrote that is clearly meant as an id (has a digit, or uses the m: prefix). */
const looksLikeId = (id: string) => id.startsWith('m:') || /\d/.test(id);

/**
 * Step 1+2 of answer processing: fold "Name (P1a)" / "P1a (Name)" into the token, normalize citation groups to
 * `[id][id]`, and strip ids not in `citable`. Bracketed words that only look like ids ("[Pizza]") are left alone.
 */
export function validateCitations(raw: string, o: Pick<ProcessOptions, 'citable' | 'personFirst'>): { text: string; cited: string[]; violations: number } {
  let text = raw;
  if (o.personFirst) {
    const first = o.personFirst;
    text = text
      .replace(/\b([\p{Lu}][\p{L}'’-]*(?:\s[\p{Lu}][\p{L}'’-]*)?(?:\s[\p{Lu}]\.)?)\s*\((P[0-9a-z]{1,10})\)/gu, (m, name: string, tok: string) =>
        sameFirst(first(tok), name) ? tok : m,
      )
      .replace(/\b(P[0-9a-z]{1,10})\s*\(([\p{Lu}][\p{L}'’-]*(?:\s[\p{Lu}][\p{L}'’.-]*)*)\)/gu, (m, tok: string, name: string) =>
        sameFirst(first(tok), name) ? tok : m,
      );
  }
  const cited: string[] = [];
  let violations = 0;
  text = text.replace(GROUP_RE, (whole, space: string, inner: string) => {
    const ids = inner.split(/\s*[,;]\s*/);
    const valid = ids.filter((id) => o.citable.has(id));
    const invalid = ids.filter((id) => !o.citable.has(id));
    if (!valid.length && !invalid.some(looksLikeId)) return whole; // a bracketed word, not a citation
    violations += invalid.filter(looksLikeId).length;
    for (const id of valid) if (!cited.includes(id)) cited.push(id);
    return valid.length ? `${space}${valid.map((id) => `[${id}]`).join('')}` : '';
  });
  return { text, cited, violations };
}

const sameFirst = (first: string | null, name: string) => {
  if (!first) return false;
  const a = first.trim().toLowerCase();
  const b = name.trim().split(/\s+/)[0]!.toLowerCase();
  return a.length > 0 && a === b;
};

/** Placeholders the egress scrubber puts into text (the model may echo them). */
function scrubPlaceholders(text: string): string {
  return text
    .replace(/<phone(?::[^>]{0,20})?>/g, 'a phone number')
    .replace(/<email>/g, 'an email')
    .replace(/<addr>/g, 'an address')
    .replace(/<ig:(P[0-9a-z]{1,10})>/g, '$1’s Instagram')
    .replace(/<handle>/g, 'a handle')
    .replace(/<num>/g, '…')
    .replace(/<link:([a-z0-9.-]{1,80})>/gi, '$1');
}

/** Replaces bare person tokens (outside citation brackets) and ME with display names. */
export function detokenize(text: string, personName: (token: string) => string | null, me = 'you'): string {
  // Split on single citation markers so `[P1a]` keeps its id (the web renders it as a chip).
  const parts = text.split(/(\[(?:m:[0-9a-z]{1,10}|[FEP][0-9a-z]{1,10})\])/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const out = scrubPlaceholders(part)
        .replace(TOKEN_RE, (tok: string) => personName(tok) ?? tok)
        .replace(/\bME\b/g, me);
      return me === 'you' ? secondPerson(out) : out;
    })
    .join('');
}

/** Person tokens in text: bare ones and [P..] citations, first appearance first. */
export function personTokensIn(text: string, isPerson: (token: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(P[0-9a-z]{1,10})\b/g)) {
    const t = m[1]!;
    if (!out.includes(t) && isPerson(t)) out.push(t);
  }
  return out;
}

/** The whole pipeline: validate citations, then de-tokenize for display. */
export function processAnswer(raw: string, o: ProcessOptions): ProcessedAnswer {
  const v = validateCitations(raw.trim(), o);
  const personTokens = personTokensIn(v.text, (t) => o.personName(t) !== null);
  const text = tidy(detokenize(v.text, o.personName, o.me));
  return { text, modelText: tidy(v.text), cited: v.cited, personTokens, violations: v.violations };
}

/** Collapses whitespace left by stripped citations ("Austin ." → "Austin."). */
export function tidy(s: string): string {
  return s
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Ids of single citation markers in a text, in order. */
export function citationIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SINGLE_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}
