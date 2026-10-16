/**
 * Value conversions for the legacy SwiftData (Core Data) store — architecture.md §5 "Conversions".
 * Pure functions: no database access, nothing logged.
 */
import { parseBuffer, UID } from 'bplist-parser';
import { coreDataSecondsToMs } from '@yb/shared';

/** 16-byte Core Data UUID blob (or an already-formatted UUID string) → lowercase 8-4-4-4-12. */
export function zidToUuid(v: unknown): string | null {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    if (v.length !== 16) return null;
    const hex = Buffer.from(v).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())) {
    return v.trim().toLowerCase();
  }
  return null;
}

/** Core Data TIMESTAMP (seconds since 2001, INTEGER or REAL) → Unix ms; null stays null. */
export function coreDataMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? coreDataSecondsToMs(n) : null;
}

/** First day of the Gregorian calendar (JDN of 1582-10-15). Foundation uses the Julian calendar before it. */
const GREGORIAN_START_JDN = 2_299_161;

function gregorianToJdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function jdnToJulian(jdn: number): { y: number; m: number; d: number } {
  const c = jdn + 32082;
  const d4 = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d4) / 4);
  const m5 = Math.floor((5 * e + 2) / 153);
  return {
    d: e - Math.floor((153 * m5 + 2) / 5) + 1,
    m: m5 + 3 - 12 * Math.floor(m5 / 10),
    y: d4 - 4800 + Math.floor(m5 / 10),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date of `ms` in `timeZone` as Foundation shows it: proleptic Gregorian after 1582-10-15, Julian before. */
export function foundationLocalDate(ms: number, timeZone?: string): { y: number; m: number; d: number } {
  const key = timeZone ?? '';
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, era: 'short', year: 'numeric', month: 'numeric', day: 'numeric' });
    formatters.set(key, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  const yearOfEra = Number(p.year);
  // Intl (like JS Date) is proleptic Gregorian; "1 BC" is astronomical year 0.
  const y = /^B/i.test(p.era ?? '') ? 1 - yearOfEra : yearOfEra;
  const m = Number(p.month);
  const d = Number(p.day);
  const jdn = gregorianToJdn(y, m, d);
  return jdn < GREGORIAN_START_JDN ? jdnToJulian(jdn) : { y, m, d };
}

/** Years Apple uses for "no year": 1604 (CNContact) and 1 (Foundation's default when components lack a year). */
const NO_YEAR_BEFORE = 1700;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Legacy birthday (a Date at local midnight) → "YYYY-MM-DD", or "--MM-DD" when the year is Apple's no-year
 * placeholder. Uses the Mac's time zone unless one is given.
 */
export function legacyBirthday(v: unknown, timeZone?: string): { value: string; noYear: boolean } | null {
  const ms = coreDataMs(v);
  if (ms === null) return null;
  const { y, m, d } = foundationLocalDate(ms, timeZone);
  if (y < NO_YEAR_BEFORE) return { value: `--${pad(m)}-${pad(d)}`, noYear: true };
  if (y > 9999) return null;
  return { value: `${pad(y, 4)}-${pad(m)}-${pad(d)}`, noYear: false };
}

export class PlistShapeError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PlistShapeError';
  }
}

export type PlistEncoding = 'empty' | 'plain' | 'keyed_archive';

const uidOf = (v: unknown): number | null => {
  if (v instanceof UID) return v.UID;
  if (v && typeof v === 'object' && typeof (v as { UID?: unknown }).UID === 'number') return (v as { UID: number }).UID;
  return null;
};

const STRING_ARRAY_CLASSES = new Set(['NSArray', 'NSMutableArray']);
const STRING_CLASSES = new Set(['NSString', 'NSMutableString']);

/**
 * NSKeyedArchiver payload that is exactly an NSArray of strings → string[]. Anything else (other root classes,
 * non-string members, dangling UIDs) throws: the import never guesses at an archive it doesn't understand.
 */
function decodeKeyedStringArray(root: Record<string, unknown>): string[] {
  const objects = root.$objects;
  const top = root.$top as Record<string, unknown> | undefined;
  if (!Array.isArray(objects) || !top) throw new PlistShapeError('keyed archive without $objects/$top');
  const at = (ref: unknown): unknown => {
    const i = uidOf(ref);
    if (i === null || i < 0 || i >= objects.length) throw new PlistShapeError('keyed archive with a dangling UID');
    return objects[i];
  };
  const className = (obj: Record<string, unknown>): string => {
    const cls = at(obj.$class) as Record<string, unknown> | undefined;
    const name = cls?.$classname;
    if (typeof name !== 'string') throw new PlistShapeError('keyed archive object without a class');
    return name;
  };
  const arr = at(top.root);
  if (!arr || typeof arr !== 'object' || Array.isArray(arr)) throw new PlistShapeError('keyed archive root is not an object');
  const rootClass = className(arr as Record<string, unknown>);
  if (!STRING_ARRAY_CLASSES.has(rootClass)) throw new PlistShapeError(`keyed archive root class ${rootClass}`);
  const refs = (arr as Record<string, unknown>)['NS.objects'];
  if (!Array.isArray(refs)) throw new PlistShapeError('keyed archive array without NS.objects');
  return refs.map((ref) => {
    const member = at(ref);
    if (typeof member === 'string') return member;
    if (member && typeof member === 'object' && !Array.isArray(member)) {
      const m = member as Record<string, unknown>;
      if (STRING_CLASSES.has(className(m)) && typeof m['NS.string'] === 'string') return m['NS.string'];
    }
    throw new PlistShapeError('keyed archive array member is not a string');
  });
}

/**
 * ZEMAILS / ZPHONES / ZADDRESSES / ZINTERESTS → string[]. Accepts a plain `bplist00` string array or an
 * NSKeyedArchiver whose root is an NSArray of strings (what SwiftData writes for [String]); throws
 * PlistShapeError for any other shape.
 */
export function decodeStringArray(v: unknown): { values: string[]; encoding: PlistEncoding } {
  if (v === null || v === undefined) return { values: [], encoding: 'empty' };
  if (!Buffer.isBuffer(v)) throw new PlistShapeError(`expected a blob, got ${typeof v}`);
  if (v.length === 0) return { values: [], encoding: 'empty' };
  if (v.subarray(0, 8).toString('latin1') !== 'bplist00') throw new PlistShapeError('not a bplist00 blob');
  let parsed: unknown;
  try {
    [parsed] = parseBuffer(v);
  } catch {
    throw new PlistShapeError('unparseable bplist');
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every((x) => typeof x === 'string')) throw new PlistShapeError('plain array member is not a string');
    return { values: parsed as string[], encoding: 'plain' };
  }
  if (parsed && typeof parsed === 'object' && '$archiver' in parsed) {
    if ((parsed as { $archiver: unknown }).$archiver !== 'NSKeyedArchiver') throw new PlistShapeError('unknown $archiver');
    return { values: decodeKeyedStringArray(parsed as Record<string, unknown>), encoding: 'keyed_archive' };
  }
  throw new PlistShapeError('bplist root is not an array');
}

/** Trimmed, de-duplicated, non-empty values (order kept). */
export function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Custom fields the old app wrote for its own bookkeeping; not user data. */
const INTERNAL_CUSTOM_FIELDS = new Set(['lastEnriched']);

/** ZCUSTOMFIELDS (JSON text, possibly in a blob) → string map without internal keys; null when empty. */
export function parseCustomFields(v: unknown): Record<string, string> | null {
  if (v === null || v === undefined) return null;
  const text = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  if (!text.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new PlistShapeError('custom fields are not JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new PlistShapeError('custom fields are not a JSON object');
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (INTERNAL_CUSTOM_FIELDS.has(k) || val === null || val === undefined) continue;
    out[k] = String(val);
  }
  return Object.keys(out).length ? out : null;
}

/** "@Handle", "instagram.com/handle?x" → "handle" (null unless it fits Instagram's username rules). */
export function instagramUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^(www\.)?instagram\.com\//, '').replace(/^@/, '');
  s = s.split(/[/?#]/)[0] ?? '';
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : null;
}

/** "@Handle", "x.com/handle", "twitter.com/handle" → "handle" (null unless it fits X's username rules). */
export function xUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^(www\.|mobile\.)?(twitter|x)\.com\//, '').replace(/^@/, '');
  s = s.split(/[/?#]/)[0] ?? '';
  return /^[a-z0-9_]{1,15}$/.test(s) ? s : null;
}

/** LinkedIn profile URL → "https://www.linkedin.com/in/<slug>" when it has that shape, else the trimmed URL. */
export function linkedinUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();
  const m = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/(in|pub)\/([^/?#\s]+)/i.exec(s);
  if (m) return `https://www.linkedin.com/${m[1]!.toLowerCase()}/${decodeURIComponent(m[2]!).toLowerCase()}`;
  return s.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** Normalized form for fact dedupe: NFKC, lowercased, whitespace collapsed. */
export const normText = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const STATE_ZIP = /^([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/;
const CITY = /^[A-Za-z][A-Za-z .'-]{1,40}$/;
const CITY_STATE_ZIP = /^([A-Za-z][A-Za-z .'-]{1,40}?)\s+([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$/;

/** "City, ST" from a US-style postal address ("…, Springfield, IL 62701"), or null. */
export function cityFromAddress(address: string): string | null {
  const segments = address
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    const sz = STATE_ZIP.exec(seg);
    if (sz && i >= 1 && CITY.test(segments[i - 1]!) && !/\d/.test(segments[i - 1]!)) {
      return `${segments[i - 1]}, ${sz[1]!.toUpperCase()}`;
    }
    const csz = CITY_STATE_ZIP.exec(seg);
    if (csz) return `${csz[1]!.trim()}, ${csz[2]!.toUpperCase()}`;
  }
  return null;
}

/** Legacy tapback interactions ("Loved “…”"): reactions, never messages. */
export const TAPBACK_SUMMARY =
  /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Reacted .{1,16} to|Removed an? .{1,24} from) [“"]/u;
