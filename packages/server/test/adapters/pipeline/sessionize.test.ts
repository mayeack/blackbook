import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { pruneDerivedInteractions, refreshConversations } from '../../../src/pipeline/interactions';
import { DEFAULT_SESSION_RULES, splitSessions } from '../../../src/pipeline/sessionize';
import { memDb, seedIdentity, seedPerson, T0 } from '../../helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const times = (...offsets: number[]) => offsets.map((o) => ({ sent_at: T0 + o }));
const sizes = (groups: unknown[][]) => groups.map((g) => g.length);

describe('splitSessions', () => {
  it('splits on gaps strictly longer than 2 h (1:1) or 1 h (group)', () => {
    expect(sizes(splitSessions(times(0, 2 * HOUR, 4 * HOUR + 1), DEFAULT_SESSION_RULES.dmGapMs))).toEqual([2, 1]);
    expect(sizes(splitSessions(times(0, HOUR, 2 * HOUR + 1), DEFAULT_SESSION_RULES.groupGapMs))).toEqual([2, 1]);
    expect(splitSessions([], DEFAULT_SESSION_RULES.dmGapMs)).toEqual([]);
  });

  it('hard-splits at 400 messages and at a 12 h span', () => {
    const steady = Array.from({ length: 401 }, (_, i) => i * MIN);
    expect(sizes(splitSessions(times(...steady), DEFAULT_SESSION_RULES.dmGapMs))).toEqual([400, 1]);
    // Every 100 min (under the 2 h gap) for 15 h: the 9th message is more than 12 h after the first.
    const slow = Array.from({ length: 10 }, (_, i) => i * 100 * MIN);
    expect(sizes(splitSessions(times(...slow), DEFAULT_SESSION_RULES.dmGapMs))).toEqual([8, 2]);
  });
});

function world() {
  const db = memDb();
  const alex = seedPerson(db, { status: 'provisional', display_name: 'Alex' });
  const alexIdent = seedIdentity(db, alex, 'phone', '+15125550101');
  const blair = seedPerson(db, { status: 'provisional', display_name: 'Blair' });
  const blairIdent = seedIdentity(db, blair, 'phone', '+15125550102');
  const conv = (kind: 'direct' | 'group' | 'self', members: string[]) => {
    const id = uuidv7();
    db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'imessage', ?, ?, ?, ?)`).run(
      id,
      id,
      kind,
      T0,
      T0,
    );
    for (const m of members) {
      db.prepare(
        `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
      ).run(id, m, T0, T0);
    }
    return id;
  };
  const msg = (convId: string, at: number, from: string | 'me', o: { kind?: string; isBot?: boolean } = {}) =>
    Number(
      db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, is_bot, ingested_at, updated_at)
           VALUES ('imessage', ?, ?, ?, ?, ?, ?, 'x', ?, ?, ?)`,
        )
        .run(uuidv7(), convId, from === 'me' ? null : from, from === 'me' ? 1 : 0, at, o.kind ?? 'text', o.isBot ? 1 : 0, T0, T0).lastInsertRowid,
    );
  const interactions = () =>
    db
      .prepare('SELECT person_id, kind, session_id, msgs_from_me, msgs_from_them, initiated_by_me FROM interactions ORDER BY started_at, person_id')
      .all() as { person_id: string; kind: string; session_id: string; msgs_from_me: number; msgs_from_them: number; initiated_by_me: number }[];
  return { db, alex, alexIdent, blair, blairIdent, conv, msg, interactions };
}

describe('sessions and derived interactions', () => {
  it('derives one interaction per (person, session), counting the 1:1 counterpart even when only I wrote', () => {
    const w = world();
    const c = w.conv('direct', [w.alexIdent]);
    w.msg(c, T0, 'me');
    w.msg(c, T0 + MIN, 'me');
    w.msg(c, T0 + 3 * HOUR, w.alexIdent);
    w.msg(c, T0 + 3 * HOUR + MIN, 'me');
    w.msg(c, T0 + 3 * HOUR + 2 * MIN, w.alexIdent, { kind: 'system' });
    w.msg(c, T0 + 3 * HOUR + 3 * MIN, 'me', { isBot: true });
    const r = refreshConversations(w.db, new Map([[c, null]]), { now: T0 });
    expect(r.sessionsChanged).toBe(2);
    expect(w.db.prepare('SELECT msg_count, initiated_by_me FROM sessions ORDER BY started_at').all()).toEqual([
      { msg_count: 2, initiated_by_me: 1 },
      { msg_count: 2, initiated_by_me: 0 },
    ]);
    expect(w.interactions().map(({ session_id: _s, ...i }) => i)).toEqual([
      { person_id: w.alex, kind: 'dm_session', msgs_from_me: 2, msgs_from_them: 0, initiated_by_me: 1 },
      { person_id: w.alex, kind: 'dm_session', msgs_from_me: 1, msgs_from_them: 1, initiated_by_me: 0 },
    ]);
  });

  it('group sessions count only the people who posted', () => {
    const w = world();
    const c = w.conv('group', [w.alexIdent, w.blairIdent]);
    w.msg(c, T0, w.alexIdent);
    w.msg(c, T0 + MIN, 'me');
    w.msg(c, T0 + 2 * MIN, w.alexIdent);
    w.msg(c, T0 + 2 * HOUR, w.blairIdent); // >1 h later: a new group session
    refreshConversations(w.db, new Map([[c, null]]), { now: T0 });
    expect(w.interactions().map(({ session_id: _s, ...i }) => i)).toEqual([
      { person_id: w.alex, kind: 'group_session', msgs_from_me: 1, msgs_from_them: 2, initiated_by_me: 0 },
      { person_id: w.blair, kind: 'group_session', msgs_from_me: 0, msgs_from_them: 1, initiated_by_me: 0 },
    ]);
  });

  it('is idempotent and incremental: re-runs change nothing, late messages extend or merge sessions without duplicates', () => {
    const w = world();
    const c = w.conv('direct', [w.alexIdent]);
    w.msg(c, T0, w.alexIdent);
    w.msg(c, T0 + 5 * HOUR, 'me');
    refreshConversations(w.db, new Map([[c, null]]), { now: T0 });
    expect(w.db.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(2);
    const again = refreshConversations(w.db, new Map([[c, null]]), { now: T0 + 1 });
    expect(again).toMatchObject({ sessionsChanged: 0, sessionsRemoved: 0, interactionsUpserted: 0, interactionsDeleted: 0 });

    // A reply 30 min after my message extends the last session (same id) and updates its interaction in place.
    const lastId = w.db.prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1').pluck().get();
    w.msg(c, T0 + 5 * HOUR + 30 * MIN, w.alexIdent);
    const ext = refreshConversations(w.db, new Map([[c, T0 + 5 * HOUR + 30 * MIN]]), { now: T0 + 2 });
    expect(ext.sessionsChanged).toBe(1);
    expect(w.db.prepare('SELECT id, msg_count FROM sessions ORDER BY started_at DESC LIMIT 1').get()).toEqual({ id: lastId, msg_count: 2 });
    expect(w.interactions()).toHaveLength(2);

    // Late-arriving messages that close the gap merge both sessions into one; the dropped session's row goes too.
    w.msg(c, T0 + 1.5 * HOUR, 'me');
    w.msg(c, T0 + 3 * HOUR, w.alexIdent);
    const merged = refreshConversations(w.db, new Map([[c, T0 + 1.5 * HOUR]]), { now: T0 + 3 });
    expect(merged.sessionsRemoved).toBe(1);
    expect(w.db.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(1);
    expect(w.interactions().map(({ session_id: _s, ...i }) => i)).toEqual([
      { person_id: w.alex, kind: 'dm_session', msgs_from_me: 2, msgs_from_them: 3, initiated_by_me: 0 },
    ]);
  });

  it('never derives interactions for service senders, suppressed people or self threads', () => {
    const w = world();
    const self = w.conv('self', []);
    w.msg(self, T0, 'me');
    const c = w.conv('direct', [w.alexIdent]);
    w.msg(c, T0, w.alexIdent);
    refreshConversations(w.db, new Map([[self, null], [c, null]]), { now: T0 });
    expect(w.db.prepare('SELECT count(*) FROM sessions WHERE conversation_id = ?').pluck().get(self)).toBe(0);
    expect(w.interactions()).toHaveLength(1);

    w.db.prepare(`UPDATE people SET status = 'suppressed' WHERE id = ?`).run(w.alex);
    expect(pruneDerivedInteractions(w.db)).toBe(1);
    w.msg(c, T0 + MIN, w.alexIdent);
    refreshConversations(w.db, new Map([[c, T0 + MIN]]), { now: T0 });
    expect(w.interactions()).toHaveLength(0);
  });
});
