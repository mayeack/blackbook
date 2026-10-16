/**
 * Synthetic world for the obligations tests: invented names, 555-01xx numbers and example.com addresses only.
 * Times are relative to NOW (2026-10-14 12:00 UTC); the tz setting is UTC so local dates are predictable.
 */
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../../src/db/canon';
import type { DB } from '../../../src/db/connection';
import { memDb, seedIdentity, seedPerson, T0 } from '../../helpers';

export const NOW = T0;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ago = (ms: number) => NOW - ms;

/** Fictional NANP numbers: +1 212 555 0100 … 0199. */
let phone = 0;
const nextPhone = () => `+1212555${String(100 + (phone++ % 100)).padStart(4, '0')}`;

export interface World {
  db: DB;
  me: string;
  person(
    first: string,
    o?: { last?: string; hidden?: boolean; priority?: boolean; status?: string; tie?: number | null; identityKind?: 'phone' | 'email' },
  ): { id: string; identity: string };
  identity(personId: string, kind?: string): string;
  dm(identityId: string, source?: string): string;
  group(identityIds: string[], o?: { source?: string; title?: string }): string;
  msg(
    conv: string,
    from: string | 'me',
    at: number,
    text: string | null,
    o?: { kind?: string; replyTo?: number; attachments?: unknown[]; bot?: boolean },
  ): number;
  react(msgId: number, at?: number): void;
  interaction(personId: string, kind: string, at: number, origin?: string): string;
}

export function world(): World {
  const db = memDb();
  db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('tz', '"UTC"', ?, ?)`).run(NOW, NOW);
  const me = seedPerson(db, { kind: 'me', display_name: 'Avery Example', first_name: 'Avery', last_name: 'Example' });
  const identity = (personId: string, kind = 'phone') => seedIdentity(db, personId, kind, kind === 'phone' ? nextPhone() : `${uuidv7()}@example.com`);
  const w: World = {
    db,
    me,
    person(first, o = {}) {
      const id = seedPerson(db, {
        display_name: `${first} ${o.last ?? 'Sample'}`,
        first_name: first,
        last_name: o.last ?? 'Sample',
        is_hidden: o.hidden ? 1 : 0,
        is_priority: o.priority ? 1 : 0,
        status: o.status ?? 'active',
      });
      if (o.tie !== undefined && o.tie !== null) {
        db.prepare(`INSERT INTO person_stats (person_id, tie_strength, state, computed_at) VALUES (?, ?, 'steady', ?)`).run(id, o.tie, NOW);
      }
      return { id, identity: identity(id, o.identityKind ?? 'phone') };
    },
    identity,
    dm(identityId, source = 'imessage') {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, ?, ?, 'direct', ?, ?)`,
      ).run(id, source, id, NOW - 400 * DAY, NOW);
      db.prepare(
        `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
      ).run(id, identityId, NOW - 400 * DAY, NOW);
      return id;
    },
    group(identityIds, o = {}) {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO conversations (id, source, source_conv_id, kind, title, created_at, updated_at) VALUES (?, ?, ?, 'group', ?, ?, ?)`,
      ).run(id, o.source ?? 'imessage', id, o.title ?? 'Trail crew', NOW - 400 * DAY, NOW);
      for (const i of identityIds) {
        db.prepare(
          `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
        ).run(id, i, NOW - 400 * DAY, NOW);
      }
      return id;
    },
    msg(conv, from, at, text, o = {}) {
      const id = Number(
        db
          .prepare(
            `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, reply_to_msg_id,
               attachments, is_bot, ingested_at, updated_at)
             VALUES ((SELECT source FROM conversations WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            conv,
            uuidv7(),
            conv,
            from === 'me' ? null : from,
            from === 'me' ? 1 : 0,
            at,
            o.kind ?? 'text',
            text,
            o.replyTo ?? null,
            o.attachments ? JSON.stringify(o.attachments) : null,
            o.bot ? 1 : 0,
            at,
            at,
          ).lastInsertRowid,
      );
      db.prepare('UPDATE conversations SET last_message_at = max(coalesce(last_message_at, 0), ?), first_message_at = min(coalesce(first_message_at, ?), ?) WHERE id = ?').run(at, at, at, conv);
      return id;
    },
    react(msgId, at = NOW - HOUR) {
      db.prepare(`INSERT INTO message_reactions (source_reaction_id, message_id, is_from_me, type, at) VALUES (?, ?, 1, 'love', ?)`).run(uuidv7(), msgId, at);
    },
    interaction(personId, kind, at, origin = 'user') {
      const id = uuidv7();
      db.prepare(
        `INSERT INTO interactions (id, person_id, kind, started_at, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, personId, kind, at, origin, at, at);
      return id;
    },
  };
  rebuildPersonCanon(db);
  return w;
}

export const debts = (db: DB) => db.prepare('SELECT * FROM reply_debts ORDER BY created_at, id').all() as Record<string, unknown>[];
export const commitments = (db: DB) => db.prepare('SELECT * FROM commitments ORDER BY created_at, id').all() as Record<string, unknown>[];
export const batchCount = (db: DB) => db.prepare('SELECT count(*) FROM change_batches').pluck().get() as number;
