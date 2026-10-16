/**
 * Small helpers shared by the samplers, the renderer and the metrics: a seeded PRNG and stratified quota
 * allocation, canon / visibility lookups, text normalization for matching and the independent quote check.
 */
import type { DB } from '../db/connection';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------- randomness

/** mulberry32: a tiny deterministic PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface Stratum {
  key: string;
  weight: number;
  available: number;
}

/**
 * Splits `total` across strata in proportion to their weights (D'Hondt), never giving a stratum more than it has:
 * a short stratum's share flows to the others, so the set still reaches its size when the data allows.
 */
export function allocate(total: number, strata: readonly Stratum[]): Map<string, number> {
  const out = new Map<string, number>(strata.map((s) => [s.key, 0]));
  const live = strata.filter((s) => s.weight > 0 && s.available > 0);
  for (let i = 0; i < total; i++) {
    let best: Stratum | null = null;
    let bestQ = -1;
    for (const s of live) {
      const n = out.get(s.key)!;
      if (n >= s.available) continue;
      const q = s.weight / (n + 1);
      if (q > bestQ) {
        bestQ = q;
        best = s;
      }
    }
    if (!best) break;
    out.set(best.key, out.get(best.key)! + 1);
  }
  return out;
}

/** Round-robin across groups (keeps a fresh labeling page mixed across strata). */
export function interleave<T>(groups: readonly T[][]): T[] {
  const out: T[] = [];
  const max = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < max; i++) for (const g of groups) if (i < g.length) out.push(g[i]!);
  return out;
}

// ---------------------------------------------------------------------------------------------- people

/** Canonical id (person_canon), memoized per call site. */
export function canonFn(db: DB): (id: string) => string {
  const stmt = db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck();
  const cache = new Map<string, string>();
  return (id) => {
    let c = cache.get(id);
    if (c === undefined) {
      c = (stmt.get(id) as string | undefined) ?? id;
      cache.set(id, c);
    }
    return c;
  };
}

export interface PersonInfo {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
}

/** Visible (person_visible) people by canonical id, memoized; null = hidden, merged away, service, ME or unknown. */
export function visibleFn(db: DB): (id: string | null | undefined) => PersonInfo | null {
  const canon = canonFn(db);
  const stmt = db.prepare('SELECT id, display_name, first_name, last_name FROM person_visible WHERE id = ?');
  const cache = new Map<string, PersonInfo | null>();
  return (id) => {
    if (!id) return null;
    const c = canon(id);
    if (!cache.has(c)) {
      const r = stmt.get(c) as { id: string; display_name: string; first_name: string | null; last_name: string | null } | undefined;
      cache.set(c, r ? { id: r.id, displayName: r.display_name, firstName: r.first_name, lastName: r.last_name } : null);
    }
    return cache.get(c)!;
  };
}

export function meId(db: DB): string | null {
  return (
    (db.prepare(`SELECT id FROM people WHERE kind = 'me' AND merged_into_id IS NULL ORDER BY created_at LIMIT 1`).pluck().get() as string | undefined) ?? null
  );
}

/** "Sam R." */
export function shortName(p: PersonInfo): string {
  const first = p.firstName?.trim() || p.displayName.trim().split(/\s+/)[0] || p.displayName;
  const last = p.lastName?.trim();
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
}

// ---------------------------------------------------------------------------------------------- text

/** iMessage / WhatsApp / Instagram (the G1 source strata). */
export function sourceGroup(source: string): 'imessage' | 'whatsapp' | 'instagram' {
  if (source.startsWith('instagram') || source === 'beeper') return 'instagram';
  if (source === 'whatsapp') return 'whatsapp';
  return 'imessage';
}

export const SOURCE_LABEL: Record<string, string> = { imessage: 'iMessage', whatsapp: 'WhatsApp', instagram: 'Instagram' };

/** Local "Oct 12" (or "Oct 12, 2025" outside the current year). */
export function shortDate(ms: number, tz: string, now: number): string {
  const sameYear = new Date(ms).toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }) === new Date(now).toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' });
  return new Date(ms).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Local YYYY-MM-DD. */
export function localDate(ms: number, tz: string): string {
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: tz });
}

const QUOTES: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"' };

/** NFKC, lowercase, straight quotes, collapsed whitespace, edge punctuation trimmed. */
export function normText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛“”„‟]/g, (c) => QUOTES[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'.,;:!?…()[\]{}-]+|[\s"'.,;:!?…()[\]{}-]+$/g, '');
}

/**
 * The eval's own groundedness check, deliberately stricter than (and independent of) the extraction validator:
 * the normalized quote must appear verbatim in the normalized text of the cited message as it was sent.
 */
export function quoteGrounded(quote: string, body: string): boolean {
  const q = normText(quote);
  return q.length >= 3 && normText(body).includes(q);
}

export function tokens(s: string): Set<string> {
  return new Set(
    normText(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2),
  );
}

/** |A∩B| / |A∪B| over word tokens. */
export function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export const round = (x: number, digits = 4): number => Math.round(x * 10 ** digits) / 10 ** digits;

export function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}
