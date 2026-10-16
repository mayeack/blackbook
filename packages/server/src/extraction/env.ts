/**
 * The per-run environment extraction reads everything through: settings (tz, exclusions), the owner's person,
 * cached identity → canonical person lookups (with the visibility facts windows need), and local-time helpers.
 * One Env per job run; cheap to build.
 */
import { localParts } from '@yb/shared';
import { canonicalId } from '../db/canon';
import type { DB } from '../db/connection';
import { settingsSnapshot } from '../settings/registry';

export const DAY_MS = 86_400_000;

export interface PersonInfo {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  kind: string;
  status: string;
  hidden: boolean;
  priority: boolean;
}

export interface Env {
  db: DB;
  now: number;
  tz: string;
  meId: string | null;
  meFirstName: string | null;
  excludedPeople: ReadonlySet<string>;
  excludedConversations: ReadonlySet<string>;
  /** Canonical person behind an identity (null for unknown identities). */
  personOfIdentity(identityId: string | null): string | null;
  person(personId: string): PersonInfo | null;
  canonical(personId: string): string;
  /** Whether a (canonical) person may appear in a window: a real, visible, non-excluded person (not ME). */
  usable(personId: string | null): boolean;
}

export function buildEnv(db: DB, now: number): Env {
  const s = settingsSnapshot(db);
  const me =
    (db
      .prepare(`SELECT id, first_name FROM people WHERE kind = 'me' AND merged_into_id IS NULL AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`)
      .get() as { id: string; first_name: string | null } | undefined) ?? null;
  const identStmt = db.prepare('SELECT person_id FROM identities WHERE id = ?');
  const personStmt = db.prepare(
    'SELECT id, first_name, last_name, display_name, kind, status, is_hidden, is_priority, merged_into_id FROM people WHERE id = ?',
  );
  const canonCache = new Map<string, string>();
  const identCache = new Map<string, string | null>();
  const personCache = new Map<string, PersonInfo | null>();
  const excludedPeople = new Set<string>();
  const canonical = (id: string): string => {
    let c = canonCache.get(id);
    if (!c) {
      try {
        c = canonicalId(db, id);
      } catch {
        c = id;
      }
      canonCache.set(id, c);
    }
    return c;
  };
  for (const id of s['llm.excluded_person_ids']) excludedPeople.add(canonical(id));
  const env: Env = {
    db,
    now,
    tz: s.tz,
    meId: me ? canonical(me.id) : null,
    meFirstName: me?.first_name ?? null,
    excludedPeople,
    excludedConversations: new Set(s['llm.excluded_conversation_ids']),
    canonical,
    personOfIdentity(identityId) {
      if (!identityId) return null;
      if (identCache.has(identityId)) return identCache.get(identityId)!;
      const pid = identStmt.pluck().get(identityId) as string | undefined;
      const out = pid ? canonical(pid) : null;
      identCache.set(identityId, out);
      return out;
    },
    person(personId) {
      const id = canonical(personId);
      if (personCache.has(id)) return personCache.get(id)!;
      const r = personStmt.get(id) as
        | {
            id: string;
            first_name: string | null;
            last_name: string | null;
            display_name: string;
            kind: string;
            status: string;
            is_hidden: number;
            is_priority: number;
          }
        | undefined;
      const info: PersonInfo | null = r
        ? {
            id: r.id,
            firstName: r.first_name,
            lastName: r.last_name,
            displayName: r.display_name,
            kind: r.kind,
            status: r.status,
            hidden: r.is_hidden === 1,
            priority: r.is_priority === 1,
          }
        : null;
      personCache.set(id, info);
      return info;
    },
    usable(personId) {
      if (!personId) return false;
      if (personId === env.meId) return false;
      if (excludedPeople.has(personId)) return false;
      const p = env.person(personId);
      return !!p && p.kind === 'person' && (p.status === 'active' || p.status === 'provisional') && !p.hidden;
    },
  };
  return env;
}

/** First name for cards: the first_name, else the first word of a display name that isn't a masked handle. */
export function cardFirstName(p: PersonInfo): string | null {
  if (p.firstName?.trim()) return p.firstName.trim();
  const d = p.displayName.trim();
  if (!d || /[\d@+•*]/.test(d)) return null;
  return d.split(/\s+/)[0] ?? null;
}

/** "YYYY-MM-DD HH:MM" local. */
export function localStamp(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.date} ${p.hhmm}`;
}

/** UTC offset (minutes, local − UTC) of `tz` at instant `ms`. */
export function tzOffsetMinutes(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of a YYYY-MM-DD date in `tz` (ms), or null for anything that isn't a real date. */
export function localDateToMs(date: string | null | undefined, tz: string): number | null {
  if (!date) return null;
  const m = DATE_RE.exec(date.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1970 || y > 2200) return null;
  const guess = Date.UTC(y, mo - 1, d);
  if (new Date(guess).getUTCDate() !== d) return null;
  let ms = guess - tzOffsetMinutes(guess, tz) * 60_000;
  ms = guess - tzOffsetMinutes(ms, tz) * 60_000; // second pass settles DST edges
  return ms;
}

/** End of a local day (23:59:59.999) for a YYYY-MM-DD date. */
export function localDateEndMs(date: string | null | undefined, tz: string): number | null {
  if (!date) return null;
  const m = DATE_RE.exec(date.trim());
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
  const start = localDateToMs(next, tz);
  return start === null ? null : start - 1;
}

/** Local "YYYY-MM" month key. */
export const localMonth = (ms: number, tz: string): string => localParts(ms, tz).date.slice(0, 7);

export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
