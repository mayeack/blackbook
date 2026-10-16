/**
 * Text helpers shared by the Beeper (Instagram network) ingest and the DYI importer: the normalized-text hash that
 * matches the same message across both (intelligence §1.1: ±2 s and the same text hash), and the mojibake fix for
 * DYI exports, whose JSON writes each UTF-8 byte as its own \u00XX escape.
 */
import crypto from 'node:crypto';

/** Same message seen by Beeper and in a DYI export: timestamps within this window. */
export const MATCH_WINDOW_MS = 2_000;

export const normalizeText = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** sha256 (base64url, 22 chars) of the normalized text; null for empty text. */
export function textHash(s: string | null | undefined): string | null {
  const n = s ? normalizeText(s) : '';
  return n ? crypto.createHash('sha256').update(n).digest('base64url').slice(0, 22) : null;
}

const NON_LATIN1 = /[^\u0000-ÿ]/;
const HIGH_LATIN1 = /[\u0080-ÿ]/;

/**
 * Undoes Instagram's latin1 mojibake: "â\u009d¤" (three code units) → "❤". Strings that already hold
 * characters above U+00FF, plain ASCII, or bytes that aren't valid UTF-8 are returned unchanged.
 */
export function fixMojibake(s: string): string {
  if (!HIGH_LATIN1.test(s) || NON_LATIN1.test(s)) return s;
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  return fixed.includes('�') ? s : fixed;
}

/** JSON.parse with fixMojibake applied to every string (keys and values). */
export function parseDyiJson(text: string): unknown {
  const fixed = (v: unknown) => (typeof v === 'string' ? fixMojibake(v) : v);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fixMojibake(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [fixed(k), walk(x)]));
    return v;
  };
  return walk(JSON.parse(text));
}
