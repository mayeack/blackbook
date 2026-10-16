/**
 * Derived interactions: one row per (person, session). 1:1 sessions count for the chat's counterpart even when
 * only I wrote; group sessions count for each person who posted. msgs_from_me / msgs_from_them feed reciprocity.
 * Class (D): never journaled, idempotent through the partial unique index on dedupe_key (origin = 'derived'),
 * and pruned when a session disappears or its person becomes a service sender or is suppressed.
 * person_id is the pre-canon person (merges are pointers; reads join person_canon).
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { sessionizeConversation, type ComputedSession, type SessionRules } from './sessionize';

/** People that can have interactions: real persons that aren't service senders or suppressed by an undo. */
const PERSON_OK = `p.kind = 'person' AND p.status NOT IN ('service','suppressed')`;

export interface DeriveResult {
  upserted: number;
  deleted: number;
}

/** Writes the interactions of the given sessions of one conversation and drops those of removed sessions. */
export function deriveInteractions(
  db: DB,
  conv: { id: string; kind: 'direct' | 'group'; source: string },
  sessions: readonly ComputedSession[],
  removedSessionIds: readonly string[],
  now: number,
): DeriveResult {
  return tx(db, () => {
    const out: DeriveResult = { upserted: 0, deleted: 0 };
    const delSession = db.prepare(`DELETE FROM interactions WHERE origin = 'derived' AND session_id = ?`);
    for (const id of removedSessionIds) out.deleted += delSession.run(id).changes;
    if (!sessions.length) return out;

    const personOf = db.prepare(
      `SELECT i.person_id FROM identities i JOIN people p ON p.id = i.person_id WHERE i.id = ? AND i.status = 'active' AND ${PERSON_OK}`,
    ).pluck();
    const cache = new Map<string, string | null>();
    const person = (identityId: string): string | null => {
      if (!cache.has(identityId)) cache.set(identityId, (personOf.get(identityId) as string | undefined) ?? null);
      return cache.get(identityId)!;
    };
    const counterparts =
      conv.kind === 'direct'
        ? [
            ...new Set(
              (db.prepare('SELECT identity_id FROM conversation_members WHERE conversation_id = ?').pluck().all(conv.id) as string[])
                .map(person)
                .filter((p): p is string => p !== null),
            ),
          ]
        : [];

    const upsert = db.prepare(
      `INSERT INTO interactions (id, person_id, kind, channel, conversation_id, session_id, started_at, ended_at, msgs_from_me,
         msgs_from_them, initiated_by_me, origin, created_at, updated_at)
       VALUES (@id, @person_id, @kind, @channel, @conversation_id, @session_id, @started_at, @ended_at, @msgs_from_me,
         @msgs_from_them, @initiated_by_me, 'derived', @now, @now)
       ON CONFLICT (dedupe_key) WHERE origin = 'derived' DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at,
         msgs_from_me = excluded.msgs_from_me, msgs_from_them = excluded.msgs_from_them, initiated_by_me = excluded.initiated_by_me,
         conversation_id = excluded.conversation_id, retracted_at = NULL, updated_at = excluded.updated_at
       WHERE started_at IS NOT excluded.started_at OR ended_at IS NOT excluded.ended_at OR msgs_from_me IS NOT excluded.msgs_from_me
         OR msgs_from_them IS NOT excluded.msgs_from_them OR initiated_by_me IS NOT excluded.initiated_by_me
         OR conversation_id IS NOT excluded.conversation_id OR retracted_at IS NOT NULL`,
    );
    const existing = db.prepare(`SELECT person_id FROM interactions WHERE origin = 'derived' AND session_id = ?`).pluck();
    const delOne = db.prepare(`DELETE FROM interactions WHERE origin = 'derived' AND session_id = ? AND person_id = ?`);
    const kind = conv.kind === 'direct' ? 'dm_session' : 'group_session';

    for (const s of sessions) {
      let fromMe = 0;
      const theirs = new Map<string, number>(counterparts.map((p) => [p, 0]));
      for (const m of s.messages) {
        if (m.is_from_me) {
          fromMe++;
          continue;
        }
        const p = m.sender_identity_id ? person(m.sender_identity_id) : null;
        if (p) theirs.set(p, (theirs.get(p) ?? 0) + 1);
      }
      for (const [personId, n] of theirs) {
        out.upserted += upsert.run({
          id: uuidv7(now),
          person_id: personId,
          kind,
          channel: conv.source,
          conversation_id: conv.id,
          session_id: s.id,
          started_at: s.started_at,
          ended_at: s.ended_at,
          msgs_from_me: fromMe,
          msgs_from_them: n,
          initiated_by_me: s.initiated_by_me,
          now,
        }).changes;
      }
      for (const p of existing.all(s.id) as string[]) if (!theirs.has(p)) out.deleted += delOne.run(s.id, p).changes;
    }
    return out;
  });
}

export interface RefreshResult {
  conversations: number;
  sessionsChanged: number;
  sessionsRemoved: number;
  interactionsUpserted: number;
  interactionsDeleted: number;
}

/**
 * Re-sessionizes the touched conversations (from their earliest touched message; null = whole conversation) and
 * re-derives the interactions of every recomputed session. Each conversation commits on its own.
 */
export function refreshConversations(
  db: DB,
  touched: ReadonlyMap<string, number | null>,
  o: { now?: number; rules?: SessionRules } = {},
): RefreshResult {
  const now = o.now ?? Date.now();
  const out: RefreshResult = { conversations: 0, sessionsChanged: 0, sessionsRemoved: 0, interactionsUpserted: 0, interactionsDeleted: 0 };
  const source = db.prepare('SELECT source FROM conversations WHERE id = ?').pluck();
  for (const [conversationId, fromSentAt] of touched) {
    tx(db, () => {
      const r = sessionizeConversation(db, conversationId, { fromSentAt, rules: o.rules });
      const d = r.kind
        ? deriveInteractions(db, { id: conversationId, kind: r.kind, source: source.get(conversationId) as string }, r.sessions, r.removed, now)
        : deriveInteractions(db, { id: conversationId, kind: 'direct', source: '' }, [], r.removed, now);
      out.conversations++;
      out.sessionsChanged += r.changed.length;
      out.sessionsRemoved += r.removed.length;
      out.interactionsUpserted += d.upserted;
      out.interactionsDeleted += d.deleted;
    });
  }
  return out;
}

/** Drops derived interactions of people that became service senders or were suppressed (undo of create_person). */
export function pruneDerivedInteractions(db: DB): number {
  return db
    .prepare(
      `DELETE FROM interactions WHERE origin = 'derived' AND person_id IN
         (SELECT id FROM people WHERE kind <> 'person' OR status IN ('service','suppressed'))`,
    )
    .run().changes;
}
