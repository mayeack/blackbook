/**
 * A small synthetic world for the read-API tests. Every name, number and address is invented: phones are in the
 * fictional 555-01xx range and emails use example.com.
 */
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';

export const MIN = 60_000;
export const DAY = 86_400_000;

export interface World {
  db: DB;
  alice: string;
  aliceDup: string;
  bea: string;
  emile: string;
  zed: string;
  cher: string;
  hidden: string;
  provisional: string;
  me: string;
  ids: {
    alicePhone: string;
    aliceEmail: string;
    aliceIg: string;
    aliceDupEmail: string;
    beaPhone: string;
    hiddenPhone: string;
    provisionalPhone: string;
  };
  sessions: { dm: string; group: string; beaOnly: string };
  callId: string;
  hiddenName: string;
}

function conversation(db: DB, kind: 'direct' | 'group', title: string | null, members: string[]): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, title, member_count, created_at, updated_at)
     VALUES (?, 'imessage', ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, kind, title, members.length + 1, T0, T0);
  const ins = db.prepare(
    `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
  );
  for (const m of members) ins.run(id, m, T0, T0);
  return id;
}

function message(db: DB, conv: string, at: number, from: string | null, text: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
         VALUES ('imessage', ?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
      )
      .run(uuidv7(), conv, from, from ? 0 : 1, at, text, T0, T0).lastInsertRowid,
  );
}

function session(db: DB, conv: string, msgs: { id: number; at: number; mine: boolean }[]): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, started_at, ended_at, first_msg, last_msg, msg_count, initiated_by_me)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, conv, msgs[0]!.at, msgs[msgs.length - 1]!.at, msgs[0]!.id, msgs[msgs.length - 1]!.id, msgs.length, msgs[0]!.mine ? 1 : 0);
  return id;
}

export function buildWorld(): World {
  const db = memDb();
  const person = (first: string | null, last: string | null, extra: Record<string, unknown> = {}) =>
    seedPerson(db, { first_name: first, last_name: last, display_name: [first, last].filter(Boolean).join(' '), ...extra });

  const alice = person('Alice', 'Avery', { company: 'Acme Robotics', job_title: 'Engineer', created_at: T0 - 5 * DAY });
  const aliceDup = person('Alice', 'Avery-Dup', { created_at: T0 - 9 * DAY });
  const bea = person('Bea', 'Brook', { created_at: T0 - 4 * DAY });
  const emile = person('Émile', 'Ébert', { created_at: T0 - 3 * DAY });
  const zed = person('zed', 'zane', { created_at: T0 - 2 * DAY, is_priority: 1 });
  const cher = person('Cher', null, { created_at: T0 - DAY });
  const hiddenName = 'Halvard Hushwell';
  const hidden = person('Halvard', 'Hushwell', { is_hidden: 1, created_at: T0 });
  const provisional = person('Pat', 'Provo', { status: 'provisional', created_at: T0 });
  const me = person('Owner', 'Self', { kind: 'me', created_at: T0 });

  // aliceDup was merged into alice: a pointer, not a rewrite.
  db.prepare(`UPDATE people SET status = 'merged', merged_into_id = ? WHERE id = ?`).run(alice, aliceDup);
  rebuildPersonCanon(db);

  const ids = {
    alicePhone: seedIdentity(db, alice, 'phone', '+15555550101', { source: 'addressbook', match_method: 'addressbook', label: 'mobile' }),
    aliceEmail: seedIdentity(db, alice, 'email', 'alice@example.com', { source: 'addressbook', match_method: 'addressbook' }),
    aliceIg: seedIdentity(db, alice, 'instagram_username', 'alice.avery', { source: 'instagram', match_method: 'deterministic', confidence: 0.9 }),
    aliceDupEmail: seedIdentity(db, aliceDup, 'email', 'alice.dup@example.com', { source: 'imessage', match_method: 'exact' }),
    beaPhone: seedIdentity(db, bea, 'phone', '+15555550102', { source: 'imessage' }),
    hiddenPhone: seedIdentity(db, hidden, 'phone', '+15555550109', { source: 'imessage', display_name: hiddenName }),
    provisionalPhone: seedIdentity(db, provisional, 'phone', '+15555550110', { source: 'imessage' }),
  };

  // DM with Alice on day 0.
  const dm = conversation(db, 'direct', null, [ids.alicePhone]);
  const d1 = message(db, dm, T0, ids.alicePhone, 'are we still on for tea?');
  const d2 = message(db, dm, T0 + MIN, null, 'yes, see you at four');
  const dmSession = session(db, dm, [
    { id: d1, at: T0, mine: false },
    { id: d2, at: T0 + MIN, mine: true },
  ]);

  // Group with Alice and the hidden person on day 1.
  const group = conversation(db, 'group', 'Climbing crew', [ids.aliceEmail, ids.hiddenPhone]);
  const g1 = message(db, group, T0 + DAY, ids.aliceEmail, 'who has the ropes?');
  const g2 = message(db, group, T0 + DAY + MIN, ids.hiddenPhone, 'I have two');
  const g3 = message(db, group, T0 + DAY + 2 * MIN, null, 'great, bring both');
  const groupSession = session(db, group, [
    { id: g1, at: T0 + DAY, mine: false },
    { id: g2, at: T0 + DAY + MIN, mine: false },
    { id: g3, at: T0 + DAY + 2 * MIN, mine: true },
  ]);
  db.prepare(
    `INSERT INTO message_reactions (source_reaction_id, message_id, is_from_me, type, emoji, at) VALUES ('r1', ?, 1, 'love', '❤️', ?)`,
  ).run(g1, T0 + DAY + 3 * MIN);

  // A conversation only Bea is in: never on Alice's timeline.
  const beaConv = conversation(db, 'direct', null, [ids.beaPhone]);
  const b1 = message(db, beaConv, T0 + 3 * DAY, ids.beaPhone, 'lunch friday?');
  const beaOnly = session(db, beaConv, [{ id: b1, at: T0 + 3 * DAY, mine: false }]);

  // A phone call logged against the merged-away record: it shows on Alice through canon.
  const callId = uuidv7();
  db.prepare(
    `INSERT INTO interactions (id, person_id, kind, channel, started_at, ended_at, origin, created_at, updated_at)
     VALUES (?, ?, 'call', 'phone', ?, ?, 'user', ?, ?)`,
  ).run(callId, aliceDup, T0 + 2 * DAY, T0 + 2 * DAY + 10 * MIN, T0, T0);

  return { db, alice, aliceDup, bea, emile, zed, cher, hidden, provisional, me, ids, sessions: { dm: dmSession, group: groupSession, beaOnly }, callId, hiddenName };
}
