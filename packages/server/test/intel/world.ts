/**
 * Synthetic fixtures for the intel tests (trips, intros, briefs, follow-ups). Every name, place, venue and id is
 * invented; phones are in the fictional 555-01xx range and emails use example.com.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../src/db/connection';
import { memDb, seedIdentity, seedPerson } from '../helpers';
import { calEvent, chat, type CalInput, type Chat } from '../pipeline/occasions/world';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** 2026-10-14 12:00 UTC (the world runs in UTC). */
export const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
export const TZ = 'UTC';
/** `h:m` UTC on 2026-10-(14 + days). */
export const at = (days: number, h = 19, m = 0) => Date.UTC(2026, 9, 14 + days, h, m, 0);

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value), NOW, NOW);
}

export interface IntelWorld {
  db: DB;
  me: string;
  person(first: string, last: string, o?: { tie?: number; historical?: number; state?: string; expectedGap?: number; extra?: Record<string, unknown> }): string;
  phone(personId: string): string;
  dm(personId: string): Chat;
  fact(personId: string, type: string, value: string, o?: { conf?: number; validFrom?: number | null; validTo?: number | null; source?: string; sensitive?: boolean; recordedAt?: number }): string;
  cal(e: CalInput): string;
  partiful(o: { title: string; start: number; end?: number; location?: string | null; myRsvp?: string; myRole?: string | null }): string;
  guest(eventId: string, personId: string, status?: string, role?: string | null): string;
  attendee(occasionId: string, personId: string, o?: { status?: string; role?: string | null; source?: string; confidence?: number }): string;
  edge(a: string, b: string, strength: number): void;
  interaction(personId: string, kind: string, startedAt: number): void;
}

export function intelWorld(): IntelWorld {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Owner Example', first_name: 'Owner', last_name: 'Example' });
  seedIdentity(db, me, 'email', 'owner@example.com');
  setSetting(db, 'tz', TZ);
  const phones = new Map<string, string>();
  let n = 0;
  const person: IntelWorld['person'] = (first, last, o = {}) => {
    const id = seedPerson(db, { first_name: first, last_name: last, display_name: `${first} ${last}`, ...(o.extra ?? {}) });
    n++;
    phones.set(id, seedIdentity(db, id, 'phone', `+120255501${String(n).padStart(2, '0')}`));
    if (o.tie !== undefined || o.historical !== undefined || o.state !== undefined) {
      db.prepare(
        `INSERT INTO person_stats (person_id, tie_strength, historical_strength, state, expected_gap_d, last_at, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, o.tie ?? null, o.historical ?? null, o.state ?? null, o.expectedGap ?? null, NOW - 5 * DAY, NOW);
    }
    return id;
  };
  return {
    db,
    me,
    person,
    phone: (id) => phones.get(id)!,
    dm: (id) => chat(db, 'direct', [phones.get(id)!]),
    fact(personId, type, value, o = {}) {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO facts (id, person_id, type, value, value_norm, sensitive, confidence, support, status, valid_from, valid_to, recorded_at, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'confirmed', ?, ?, ?, ?, ?, ?)`,
      ).run(id, personId, type, value, value.toLowerCase(), o.sensitive ? 1 : 0, o.conf ?? 0.9, o.validFrom ?? null, o.validTo ?? null, o.recordedAt ?? NOW - 30 * DAY, o.source ?? 'llm', NOW, NOW);
      return id;
    },
    cal: (e) => calEvent(db, e),
    partiful(o) {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO events (id, source, source_event_id, title, starts_at, ends_at, location_text, my_rsvp, my_role, created_at, updated_at)
         VALUES (?, 'partiful', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, `Pty${id.slice(-8)}`, o.title, o.start, o.end ?? o.start + 3 * HOUR, o.location ?? null, o.myRsvp ?? 'GOING', o.myRole ?? null, NOW, NOW);
      return id;
    },
    guest(eventId, personId, status = 'going', role = 'guest') {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO event_attendees (id, event_id, person_id, status, role, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'partiful', 1, ?, ?)`,
      ).run(id, eventId, personId, status, role, NOW, NOW);
      return id;
    },
    attendee(occasionId, personId, o = {}) {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO event_attendees (id, occasion_id, person_id, status, role, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, occasionId, personId, o.status ?? 'going', o.role ?? 'companion', o.source ?? 'inferred', o.confidence ?? 0.9, NOW, NOW);
      return id;
    },
    edge(a, b, strength) {
      const [x, y] = a < b ? [a, b] : [b, a];
      db.prepare(
        `INSERT INTO edge_stats (a_id, b_id, weight, strength, tier, evidence_count, computed_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).run(x, y, -2 * Math.log(1 - Math.min(0.999, strength)), strength, strength >= 0.75 ? 'close' : strength >= 0.4 ? 'know' : strength >= 0.15 ? 'acquainted' : 'faint', NOW);
    },
    interaction(personId, kind, startedAt) {
      db.prepare(
        `INSERT INTO interactions (id, person_id, kind, started_at, origin, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'derived', ?, ?, ?)`,
      ).run(uuidv7(), personId, kind, startedAt, uuidv7(), NOW, NOW);
    },
  };
}

/** A social occasion row inserted directly (for brief / follow-up tests that don't need the calendar pipeline). */
export function occasion(db: DB, o: { title: string; start: number; end?: number; venue?: string | null; eventId?: string | null; kind?: string; sensitive?: boolean; status?: string }): string {
  const id = uuidv7();
  const social = (o.kind ?? 'social') === 'social';
  db.prepare(
    `INSERT INTO occasions (id, kind, title, starts_at, ends_at, all_day, venue_text, event_id, is_social, sensitive, corroborated, classified_by, status,
       calendar_treatment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, 'rule', ?, 'attending', ?, ?)`,
  ).run(id, o.kind ?? 'social', o.title, o.start, o.end ?? o.start + 2 * HOUR, o.venue ?? null, o.eventId ?? null, social ? 1 : 0, o.sensitive ? 1 : 0, o.status ?? 'active', NOW, NOW);
  return id;
}
