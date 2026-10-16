/**
 * Synthetic fixtures for the suggestions stage tests. Every name is invented; phones are in the fictional
 * 555-01xx range. Times are around T0 (2026-10-14 12:00 UTC); the `tz` setting is pinned to UTC.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../../src/db/connection';
import type { Candidate, CandidateGenerator } from '../../../src/pipeline/suggestions/types';
import { memDb, seedIdentity, seedPerson, T0 } from '../../helpers';

export { T0 };
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

let phoneSeq = 0;

export function suggestionsDb(): DB {
  const db = memDb();
  db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('tz', '"UTC"', 0, 0)`).run();
  phoneSeq = 0;
  return db;
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, 0, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

export interface Friend {
  id: string;
  phoneId: string;
  dm: string;
}

/** A visible person with a phone identity and a 1:1 conversation. */
export function friend(db: DB, first: string, last: string | null, extra: Record<string, unknown> = {}): Friend {
  const id = seedPerson(db, { first_name: first, last_name: last, display_name: [first, last].filter(Boolean).join(' '), ...extra });
  phoneSeq++;
  const phoneId = seedIdentity(db, id, 'phone', `+1212555${String(100 + (phoneSeq % 100)).slice(-3).padStart(4, '0')}`);
  const dm = conversation(db, 'direct', [phoneId]);
  return { id, phoneId, dm };
}

export function conversation(db: DB, kind: 'direct' | 'group', identityIds: string[], title: string | null = null): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, title, member_count, created_at, updated_at) VALUES (?, 'imessage', ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, kind, title, identityIds.length + 1, T0, T0);
  const ins = db.prepare(
    `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
  );
  for (const m of identityIds) ins.run(id, m, T0, T0);
  return id;
}

/** A message; `from` null = sent by me. */
export function message(db: DB, conv: string, at: number, from: string | null, text = 'hello there'): number {
  return Number(
    db
      .prepare(
        `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
         VALUES ('imessage', ?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
      )
      .run(uuidv7(), conv, from, from ? 0 : 1, at, text, at, at).lastInsertRowid,
  );
}

export interface StatsInput {
  state?: 'strong' | 'steady' | 'cooling' | 'fading' | 'dormant' | 'new' | null;
  tie?: number | null;
  historical?: number | null;
  silenceD?: number | null;
  expectedGapD?: number | null;
  fadingRatio?: number | null;
  momentum?: number | null;
  lastAt?: number | null;
  fadingSuppressed?: boolean;
}

export function stats(db: DB, personId: string, s: StatsInput): void {
  db.prepare(
    `INSERT INTO person_stats (person_id, state, tie_strength, historical_strength, silence_d, expected_gap_d, fading_ratio, momentum, last_at,
       fading_suppressed, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET state = excluded.state, tie_strength = excluded.tie_strength,
       historical_strength = excluded.historical_strength, silence_d = excluded.silence_d, expected_gap_d = excluded.expected_gap_d,
       fading_ratio = excluded.fading_ratio, momentum = excluded.momentum, last_at = excluded.last_at,
       fading_suppressed = excluded.fading_suppressed`,
  ).run(
    personId,
    s.state ?? null,
    s.tie ?? null,
    s.historical ?? null,
    s.silenceD ?? null,
    s.expectedGapD ?? null,
    s.fadingRatio ?? null,
    s.momentum ?? null,
    s.lastAt ?? null,
    s.fadingSuppressed ? 1 : 0,
    T0,
  );
}

/** A fading friend: H 80, quiet 60 days against a 10-day cadence. */
export function fadingFriend(db: DB, first: string, last: string, extra: StatsInput = {}): Friend {
  const f = friend(db, first, last);
  stats(db, f.id, { state: 'fading', tie: 35, historical: 80, silenceD: 60, expectedGapD: 10, fadingRatio: 6, ...extra });
  return f;
}

export function replyDebt(db: DB, f: Friend, askedAt: number, extra: Record<string, unknown> = {}): { id: string; msgId: number } {
  const msgId = message(db, f.dm, askedAt, f.phoneId, 'are you free saturday?');
  const id = uuidv7();
  const row: Record<string, unknown> = {
    id,
    conversation_id: f.dm,
    person_id: f.id,
    last_inbound_msg: msgId,
    asked_at: askedAt,
    urgency: 'normal',
    classifier: 'llm',
    confidence: 0.9,
    status: 'open',
    created_at: askedAt,
    updated_at: askedAt,
    ...extra,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO reply_debts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] as never));
  return { id, msgId };
}

export function commitment(db: DB, personId: string, extra: Record<string, unknown> = {}): string {
  const id = uuidv7();
  const row: Record<string, unknown> = {
    id,
    person_id: personId,
    owner: 'me',
    kind: 'send',
    what: 'send the trail map',
    due_end: T0 - DAY,
    due_precision: 'date',
    confidence: 0.9,
    status: 'open',
    created_at: T0 - 10 * DAY,
    updated_at: T0 - 10 * DAY,
    ...extra,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO commitments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] as never));
  return id;
}

export function circle(db: DB, name: string, members: string[]): string {
  const id = uuidv7();
  db.prepare(`INSERT INTO circles (id, name, kind, created_at, updated_at) VALUES (?, ?, 'auto', ?, ?)`).run(id, name, T0, T0);
  const ins = db.prepare(`INSERT INTO circle_members (circle_id, person_id, origin, created_at, updated_at) VALUES (?, ?, 'auto', ?, ?)`);
  for (const m of members) ins.run(id, m, T0, T0);
  return id;
}

/** A social occasion with counted attendees. */
export function occasion(db: DB, startsAt: number, attendees: string[], extra: Record<string, unknown> = {}): string {
  const id = uuidv7();
  const row: Record<string, unknown> = { id, kind: 'social', title: 'Rooftop picnic', starts_at: startsAt, is_social: 1, status: 'active', created_at: T0, updated_at: T0, ...extra };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO occasions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] as never));
  const ins = db.prepare(
    `INSERT INTO event_attendees (id, occasion_id, person_id, status, source, confidence, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'inference', 0.9, ?, ?)`,
  );
  for (const p of attendees) ins.run(uuidv7(), id, p, T0, T0);
  return id;
}

/** A logged interaction ("log: …" / call / occasion). */
export function interaction(db: DB, personId: string, kind: string, at: number): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO interactions (id, person_id, kind, started_at, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', ?, ?)`,
  ).run(id, personId, kind, at, at, at);
  return id;
}

/** A generator that emits whatever `make` returns (for stage / simulation tests). */
export function fixedGenerator(kind: Candidate['kind'], make: (now: number) => Candidate[]): CandidateGenerator {
  return { kind, generate: (ctx) => make(ctx.now) };
}

export function suggestionRow(db: DB, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Record<string, unknown>;
}
