/**
 * Synthetic world for delivery tests: invented people (no real names), 555-01xx handles, example.com emails, and a
 * day's ranked digest (digests + digest_items + suggestions rows) as the suggestions stage would write them.
 */
import { localParts, uuidv7 } from '@yb/shared';
import type { DB } from '../../src/db/connection';
import { writeSettings } from '../../src/settings/registry';
import { memDb, seedPerson } from '../helpers';

export const TZ = 'America/Los_Angeles';
export const DAY_DATE = '2026-10-14';
export const SELF_PHONE = '+1 (202) 555-0123';
export const SELF_E164 = '+12025550123';
export const SELF_EMAIL = 'owner@example.com';

/** Unix ms of a local wall-clock time in TZ (DST-safe: two passes). */
export function zoned(date: string, hhmm: string, tz = TZ): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, min] = hhmm.split(':').map(Number) as [number, number];
  let ms = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = localParts(ms, tz);
    const [py, pm, pd] = p.date.split('-').map(Number) as [number, number, number];
    const [ph, pmin] = p.hhmm.split(':').map(Number) as [number, number];
    const diff = Date.UTC(y, m - 1, d, h, min) - Date.UTC(py, pm - 1, pd, ph, pmin);
    ms += diff;
  }
  return ms;
}

export const DAY = 86_400_000;

export interface World {
  db: DB;
  ava: string;
  ben: string;
  cleo: string;
  dora: string;
}

/** A migrated DB with tz, self handles and four visible people. */
export function buildWorld(o: { enabled?: boolean; selfHandles?: string[] } = {}): World {
  const db = memDb();
  writeSettings(db, { tz: TZ, self_handles: o.selfHandles ?? [SELF_EMAIL, SELF_PHONE], ...(o.enabled ? { 'digest.enabled': true } : {}) }, {
    actor: 'system',
    allowInternal: true,
    now: zoned(DAY_DATE, '01:00'),
  });
  const T = zoned('2026-01-05', '12:00');
  const ava = seedPerson(db, { display_name: 'Ava Quillfeather', first_name: 'Ava', last_name: 'Quillfeather', created_at: T, updated_at: T });
  const ben = seedPerson(db, { display_name: 'Ben Ostrander', first_name: 'Ben', last_name: 'Ostrander', created_at: T, updated_at: T });
  const cleo = seedPerson(db, { display_name: 'Cleo Marsh', first_name: 'Cleo', last_name: 'Marsh', created_at: T, updated_at: T });
  const dora = seedPerson(db, { display_name: 'Dora Vantwerp', first_name: 'Dora', last_name: 'Vantwerp', created_at: T, updated_at: T });
  return { db, ava, ben, cleo, dora };
}

export function setSettings(db: DB, values: Record<string, unknown>): void {
  writeSettings(db, values, { actor: 'user', allowInternal: true });
}

export function personStats(db: DB, personId: string, s: { silenceD: number; expectedGapD: number; state?: string }): void {
  db.prepare(
    `INSERT INTO person_stats (person_id, silence_d, expected_gap_d, contact_days_365, state, computed_at) VALUES (?, ?, ?, 20, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET silence_d = excluded.silence_d, expected_gap_d = excluded.expected_gap_d, state = excluded.state`,
  ).run(personId, s.silenceD, s.expectedGapD, s.state ?? 'fading', zoned(DAY_DATE, '06:55'));
}

export interface SuggestionSeed {
  kind: string;
  personId?: string | null;
  relatedPersonId?: string | null;
  signals?: Record<string, unknown>;
  sensitive?: boolean;
  isWildcard?: boolean;
  wildcardGenerator?: string | null;
  status?: string;
  circleId?: string | null;
  occasionId?: string | null;
  commitmentId?: string | null;
  replyDebtId?: string | null;
}

export function seedSuggestion(db: DB, s: SuggestionSeed): string {
  const id = uuidv7();
  const now = zoned(DAY_DATE, '07:16');
  db.prepare(
    `INSERT INTO suggestions (id, kind, wildcard_generator, person_id, related_person_id, circle_id, occasion_id, commitment_id, reply_debt_id,
       dedupe_key, base_score, score, signals, sensitive, is_wildcard, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.5, 0.5, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    s.kind,
    s.wildcardGenerator ?? null,
    s.personId ?? null,
    s.relatedPersonId ?? null,
    s.circleId ?? null,
    s.occasionId ?? null,
    s.commitmentId ?? null,
    s.replyDebtId ?? null,
    `${s.kind}:${id}`,
    JSON.stringify(s.signals ?? {}),
    s.sensitive ? 1 : 0,
    s.isWildcard ? 1 : 0,
    s.status ?? 'selected',
    now,
    now,
  );
  return id;
}

/** The day's digest row with its items in order (what the ranker writes at 07:16). */
export function seedDigest(db: DB, localDate: string, suggestionIds: string[], status = 'composing'): string {
  const id = uuidv7();
  db.prepare(`INSERT INTO digests (id, local_date, status, item_cap, rng_seed) VALUES (?, ?, ?, 4, 7)`).run(id, localDate, status);
  suggestionIds.forEach((sid, i) => db.prepare('INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, ?, ?)').run(id, i + 1, sid));
  return id;
}

/** A typical four-item day: fading Ava, reply debt Ben, intro Cleo ↔ Dora, a sensitive one about Ben. */
export function typicalDay(w: World, localDate = DAY_DATE): { digestId: string; ids: string[] } {
  personStats(w.db, w.ava, { silenceD: 41, expectedGapD: 9 });
  const ids = [
    seedSuggestion(w.db, { kind: 'fading', personId: w.ava, signals: { payload: { silenceD: 41, expectedGapD: 9 }, evidenceIds: [] } }),
    seedSuggestion(w.db, { kind: 'reply_debt', personId: w.ben, signals: { ageD: 2 } }),
    seedSuggestion(w.db, { kind: 'intro', personId: w.cleo, relatedPersonId: w.dora, signals: {} }),
    seedSuggestion(w.db, { kind: 'commitment_due', personId: w.ben, sensitive: true, signals: {} }),
  ];
  return { digestId: seedDigest(w.db, localDate, ids), ids };
}
