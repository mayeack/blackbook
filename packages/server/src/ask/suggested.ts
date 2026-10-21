/**
 * Suggested prompts for the empty Ask screen, filled from the owner's own data where it helps (his most common
 * city and interest among visible people). Never a person's name.
 */
import type { DB } from '../db/connection';
import { placeName } from '../intel/placeNames';

const usable = (s: string | null | undefined): string | null => {
  const v = s?.replace(/\s+/g, ' ').trim();
  return v && v.length <= 28 && /^[\p{L}\p{N} .,'’&-]+$/u.test(v) && !/\d{3}/.test(v) ? v : null;
};

function topValue(db: DB, types: string[], now: number): string | null {
  const rows = db
    .prepare(
      `SELECT f.value, count(DISTINCT coalesce(pc.canonical_id, f.person_id)) AS n
       FROM facts f LEFT JOIN person_canon pc ON pc.person_id = f.person_id
       JOIN person_visible pv ON pv.id = coalesce(pc.canonical_id, f.person_id)
       WHERE f.type IN (SELECT value FROM json_each(?)) AND f.status IN ('tentative','confirmed') AND f.sensitive = 0
         AND f.retracted_at IS NULL AND f.superseded_at IS NULL AND (f.valid_to IS NULL OR f.valid_to >= ?)
       GROUP BY lower(f.value) ORDER BY n DESC, f.value LIMIT 5`,
    )
    .all(JSON.stringify(types), now) as { value: string; n: number }[];
  for (const r of rows) if (r.n >= 2 && usable(r.value)) return usable(r.value);
  return null;
}

/** The city most visible people live in, by place name ("LA" and "Los Angeles, CA" are one city). */
function topCity(db: DB, now: number): string | null {
  const rows = db
    .prepare(
      `SELECT DISTINCT f.value, coalesce(pc.canonical_id, f.person_id) AS pid
       FROM facts f LEFT JOIN person_canon pc ON pc.person_id = f.person_id
       JOIN person_visible pv ON pv.id = coalesce(pc.canonical_id, f.person_id)
       WHERE f.type IN ('location_current','home_location') AND f.status IN ('tentative','confirmed') AND f.sensitive = 0
         AND f.retracted_at IS NULL AND f.superseded_at IS NULL AND (f.valid_to IS NULL OR f.valid_to >= ?)`,
    )
    .all(now) as { value: string; pid: string }[];
  const people = new Map<string, Set<string>>();
  for (const r of rows) {
    const city = placeName(r.value)?.city;
    if (city) people.set(city, (people.get(city) ?? new Set()).add(r.pid));
  }
  const [top] = [...people].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  return top && top[1].size >= 2 ? usable(top[0]) : null;
}

export function suggestedPrompts(db: DB, now = Date.now()): string[] {
  const city = topCity(db, now);
  const interest = topValue(db, ['interest', 'activity_pref'], now);
  return [
    city ? `Who do I know in ${city}?` : 'Who are my closest friends right now?',
    'Who haven’t I talked to in a while?',
    interest ? `Who’s into ${interest.toLowerCase()}?` : 'Who did I make plans with recently?',
    'What did I promise people I’d do?',
    'Who was at my last party?',
  ];
}
