/**
 * Synthetic social fixtures for the ties / graph / circles tests. Every name is invented; phones are in the
 * fictional 555-01xx range and emails use example.com. Nothing here resembles real data.
 */
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
/** "Now" for these tests: noon UTC, 2026-10-14. */
export const NOW = T0;

export interface SocialWorld {
  db: DB;
  me: string;
  person(first: string, last: string | null, extra?: Record<string, unknown>): string;
  /** The person's phone identity id. */
  identity(personId: string): string;
  dm(personId: string, source?: string): string;
  group(title: string | null, memberIds: string[], o?: { memberCount?: number; source?: string }): string;
  msg(conversationId: string, at: number, from: string | 'me', text?: string, o?: { replyTo?: number; kind?: string }): number;
  /** One derived 1:1 session interaction on a given day. */
  dmTouch(personId: string, at: number, o?: { me?: number; them?: number; mine?: boolean; conversationId?: string }): void;
  groupTouch(personId: string, conversationId: string, at: number, o?: { me?: number; them?: number }): void;
  interaction(personId: string, kind: string, at: number, extra?: Record<string, unknown>): void;
}

export function socialWorld(): SocialWorld {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Owner Example', first_name: 'Owner', last_name: 'Example' });
  const identities = new Map<string, string>();
  let n = 0;
  const person = (first: string, last: string | null, extra: Record<string, unknown> = {}) => {
    const id = seedPerson(db, { first_name: first, last_name: last, display_name: [first, last].filter(Boolean).join(' '), ...extra });
    n++;
    const key = n < 100 ? `+120255501${String(n).padStart(2, '0')}` : `p${n}@example.com`;
    identities.set(id, seedIdentity(db, id, n < 100 ? 'phone' : 'email', key));
    return id;
  };
  const identity = (personId: string) => identities.get(personId)!;
  const conv = (kind: 'direct' | 'group', title: string | null, members: string[], memberCount: number | null, source: string) => {
    const id = uuidv7();
    db.prepare(
      `INSERT INTO conversations (id, source, source_conv_id, kind, title, member_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, source, id, kind, title, memberCount, T0, T0);
    const ins = db.prepare(
      `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
    );
    for (const m of members) ins.run(id, identity(m), T0, T0);
    return id;
  };
  const msg = (conversationId: string, at: number, from: string | 'me', text = 'hello there', o: { replyTo?: number; kind?: string } = {}) =>
    Number(
      db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, reply_to_msg_id,
             ingested_at, updated_at) VALUES ('imessage', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uuidv7(), conversationId, from === 'me' ? null : identity(from), from === 'me' ? 1 : 0, at, o.kind ?? 'text', text, o.replyTo ?? null, T0, T0)
        .lastInsertRowid,
    );
  const insertInteraction = (row: Record<string, unknown>) => {
    const full = { id: uuidv7(), origin: 'derived', created_at: T0, updated_at: T0, session_id: uuidv7(), ...row };
    const cols = Object.keys(full);
    db.prepare(`INSERT INTO interactions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => full[c as keyof typeof full] as never));
  };
  return {
    db,
    me,
    person,
    identity,
    dm: (personId, source = 'imessage') => conv('direct', null, [personId], 2, source),
    group: (title, memberIds, o = {}) => conv('group', title, memberIds, o.memberCount ?? memberIds.length + 1, o.source ?? 'imessage'),
    msg,
    dmTouch(personId, at, o = {}) {
      insertInteraction({
        person_id: personId,
        kind: 'dm_session',
        channel: 'imessage',
        conversation_id: o.conversationId ?? null,
        started_at: at,
        ended_at: at + 10 * 60_000,
        msgs_from_me: o.me ?? 1,
        msgs_from_them: o.them ?? 1,
        initiated_by_me: o.mine === false ? 0 : 1,
      });
    },
    groupTouch(personId, conversationId, at, o = {}) {
      insertInteraction({
        person_id: personId,
        kind: 'group_session',
        channel: 'imessage',
        conversation_id: conversationId,
        started_at: at,
        ended_at: at + 10 * 60_000,
        msgs_from_me: o.me ?? 1,
        msgs_from_them: o.them ?? 1,
        initiated_by_me: 0,
      });
    },
    interaction(personId, kind, at, extra = {}) {
      insertInteraction({ person_id: personId, kind, started_at: at, session_id: null, event_id: uuidv7(), ...extra });
    },
  };
}

/** Merges `loser` into `survivor` directly (pointer + canon), outside the journal: seed state only. */
export function pointerMerge(db: DB, loser: string, survivor: string): void {
  db.prepare(`UPDATE people SET merged_into_id = ?, status = 'merged' WHERE id = ?`).run(survivor, loser);
  rebuildPersonCanon(db);
}
