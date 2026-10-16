/**
 * Name handling for identity matching (intelligence §1.1 "Name compatibility"): a person's comparable name, its
 * first/last agreement levels, and the IG-username-contains-name test. Names are normalized with the @yb/shared
 * rules (NFKD, no diacritics/emoji, lowercase) and reduced to a first token and a last token.
 */
import { canonicalFirstNames, firstNameScore, jaroWinkler, normalizeNamePart } from '@yb/shared';

/** Normalized first and last name tokens; '' when missing. */
export interface PersonName {
  first: string;
  last: string;
}

/** Labels that placeholder display names use (identity/external.ts externalMaskedHandle, resolver maskedHandle). */
const GENERIC = new Set([
  '(unknown)',
  '(unnamed)',
  'me',
  'instagram user',
  'whatsapp user',
  'partiful guest',
  'partiful',
  'beeper user',
  'contacts card',
  'business chat',
]);

/** A display name that isn't a name: a masked handle, an @username, a bare number or email, a generic label. */
export function isDerivedName(s: string | null | undefined): boolean {
  const t = s?.trim() ?? '';
  if (!t) return true;
  if (t.includes('•') || t.includes('@') || /^short code /i.test(t)) return true;
  if (/^[\d\s()+.-]+$/.test(t)) return true;
  return GENERIC.has(t.toLowerCase());
}

/** Letter tokens (hyphenated parts kept together); parentheticals and bracketed notes dropped. */
export function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return normalizeNamePart(raw.replace(/\([^)]*\)|\[[^\]]*\]/g, ' '))
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

/** "Jake Miller" → {jake, miller}; one token → first only. Null when nothing is left. */
export function parseName(raw: string | null | undefined): PersonName | null {
  const t = nameTokens(raw);
  if (!t.length) return null;
  return { first: t[0]!, last: t.length > 1 ? t[t.length - 1]! : '' };
}

/** From separate fields (a Contacts card, people.first_name/last_name). Null when both are empty. */
export function fieldsName(first: string | null | undefined, last: string | null | undefined): PersonName | null {
  const f = nameTokens(first);
  const l = nameTokens(last);
  if (!f.length && !l.length) return null;
  return { first: f[0] ?? '', last: l.length ? l[l.length - 1]! : '' };
}

export interface NamedRow {
  display_name: string;
  first_name: string | null;
  last_name: string | null;
}

/** The comparable name of a people row: its name fields, else its display name unless that is a placeholder. */
export function personName(p: NamedRow): PersonName | null {
  return fieldsName(p.first_name, p.last_name) ?? (isDerivedName(p.display_name) ? null : parseName(p.display_name));
}

export type LastAgreement = 'agree' | 'partial' | 'initial' | 'missing' | 'conflict';

/** Last names: JW ≥0.92 agree, 0.85–0.92 partial, an initial against its own letter, else a conflict. */
export function compareLast(a: string, b: string): LastAgreement {
  if (!a || !b) return 'missing';
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 'initial' : 'conflict';
  const jw = jaroWinkler(a, b);
  return jw >= 0.92 ? 'agree' : jw >= 0.85 ? 'partial' : 'conflict';
}

/** First names: 1 canonical/nickname match, 0.9 JW ≥0.92, 0.5 initial-only, 0 otherwise (or missing). */
export const compareFirst = (a: string, b: string): number => (a && b ? firstNameScore(a, b) : 0);

/**
 * G5 / shared-identity compatibility: first-name score ≥0.5 (when both have one) and no last-name conflict.
 * A missing name is compatible with anything; two names with only one side's first name compare by last.
 */
export function namesCompatible(a: PersonName | null, b: PersonName | null): boolean {
  if (!a || !b) return true;
  if (a.first && b.first && compareFirst(a.first, b.first) < 0.5) return false;
  return compareLast(a.last, b.last) !== 'conflict';
}

/** Canonical first-name set (nickname table): "sam" → {samuel, samantha}. */
export const firstCanon = (first: string): string[] => (first ? [...canonicalFirstNames(first)] : []);

const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** The username contains first+last (each ≥2 letters), or first (≥3) immediately followed by the last initial. */
export function handleContainsName(username: string, n: PersonName | null): boolean {
  if (!n) return false;
  const u = letters(username);
  const f = letters(n.first);
  const l = letters(n.last);
  if (f.length < 2 || l.length < 2) return false;
  if (u.includes(f) && u.includes(l)) return true;
  return f.length >= 3 && u.includes(f + l[0]);
}
