import { afterEach, describe, expect, it } from 'vitest';
import { ingestOverlap, ingestTail, readCursor } from '../../../src/adapters/imessage/ingest';
import { outboundTextHash } from '../../../src/adapters/imessage/mapping';
import { undoBatch } from '../../../src/journal/undo';
import { memDb } from '../../helpers';
import {
  ALEX,
  BLAIR,
  CASEY,
  dm,
  DREW,
  EMERY,
  FakeCollector,
  group,
  HOUR,
  ME_EMAIL,
  ME_PHONE,
  MIN,
  newGuid,
  OTP_SENDER,
  PARTIFUL_BIZ,
  PARTIFUL_SHORT,
  selfChat,
  SHORT_CODE,
  T0,
} from './fakeCollector';

const fakes: FakeCollector[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function setup(selfHandles: string[] = [ME_PHONE, ME_EMAIL]) {
  const f = new FakeCollector().writeToken();
  fakes.push(f);
  const db = memDb();
  db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('self_handles', ?, ?, ?)`).run(JSON.stringify(selfHandles), T0, T0);
  const client = f.client();
  return {
    f,
    db,
    tail: (now = T0 + 2 * HOUR, pageSize?: number) => ingestTail(db, client, { now, pageSize }),
    overlap: (now = T0 + 2 * HOUR) => ingestOverlap(db, client, { now }),
  };
}

type DB = ReturnType<typeof memDb>;

const count = (db: DB, table: string, where = '1') => db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get() as number;

const TABLES = [
  'messages',
  'message_reactions',
  'conversations',
  'conversation_members',
  'membership_events',
  'people',
  'identities',
  'change_batches',
  'sessions',
  'interactions',
  'inbound_commands',
  'partiful_text_signals',
] as const;
const snapshot = (db: DB) => Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));

interface PersonRow {
  id: string;
  status: string;
  kind: string;
  display_name: string;
  identity_status: string;
  identity_id: string;
}
const personFor = (db: DB, kind: string, key: string) =>
  db
    .prepare(
      `SELECT p.id, p.status, p.kind, p.display_name, i.status AS identity_status, i.id AS identity_id
       FROM identities i JOIN people p ON p.id = i.person_id WHERE i.kind = ? AND i.key = ?`,
    )
    .get(kind, key) as PersonRow | undefined;
const phone = (db: DB, e164: string) => personFor(db, 'phone', e164);
const visible = (db: DB, personId: string) => count(db, 'person_visible', `id = '${personId}'`) === 1;

describe('iMessage ingest: cursor and idempotency', () => {
  it('pages by after_rowid until has_more=false and keeps the cursor', async () => {
    const { f, db, tail } = setup();
    for (let i = 0; i < 7; i++) f.add(dm(ALEX), { from: i % 2 ? 'me' : ALEX, at: T0 + i * MIN, text: `msg ${i}` });
    const s1 = await tail(T0 + HOUR, 3);
    expect(s1.pages).toBe(3);
    expect(s1.messages_new).toBe(7);
    expect(f.calls.filter((c) => c.startsWith('/v1/imessage/messages?'))).toEqual([
      '/v1/imessage/messages?after_rowid=0&limit=3',
      '/v1/imessage/messages?after_rowid=3&limit=3',
      '/v1/imessage/messages?after_rowid=6&limit=3',
    ]);
    expect(readCursor(db, 'messages')!.cursor).toBe('7');

    f.calls.length = 0;
    const s2 = await tail(T0 + HOUR, 3);
    expect(s2.messages_new).toBe(0);
    expect(f.calls.filter((c) => c.startsWith('/v1/imessage/messages?'))).toEqual(['/v1/imessage/messages?after_rowid=7&limit=3']);

    f.add(dm(ALEX), { from: ALEX, at: T0 + 10 * MIN, text: 'one more' });
    expect((await tail(T0 + HOUR, 3)).messages_new).toBe(1);
    expect(readCursor(db, 'messages')!.cursor).toBe('8');
    expect(count(db, 'messages')).toBe(8);
  });

  it('a pass that fails midway keeps its committed pages, and the next pass sessionizes them', async () => {
    const { f, db, tail } = setup();
    for (let i = 0; i < 4; i++) f.add(dm(ALEX), { from: i % 2 ? 'me' : ALEX, at: T0 + i * MIN, text: `msg ${i}` });
    f.failMessagesAfter = 2;
    await expect(tail(T0 + HOUR, 2)).rejects.toThrow(/chatdb_unavailable/);
    expect(count(db, 'messages')).toBe(2);
    expect(readCursor(db, 'messages')!.cursor).toBe('2');
    expect(count(db, 'sessions')).toBe(0);

    f.failMessagesAfter = null;
    await tail(T0 + HOUR, 2);
    expect(count(db, 'messages')).toBe(4);
    expect(db.prepare('SELECT msg_count FROM sessions').pluck().all()).toEqual([4]);
    expect(db.prepare('SELECT msgs_from_me, msgs_from_them FROM interactions').all()).toEqual([{ msgs_from_me: 2, msgs_from_them: 2 }]);
    // The failed pass journaled the people it created; its run is closed as partial, not left running.
    expect(db.prepare(`SELECT status FROM runs ORDER BY started_at`).pluck().all()).toEqual(['partial']);
  });

  it('re-ingesting any range (overlap re-read, cursor reset) adds nothing', async () => {
    const { f, db, tail, overlap } = setup();
    const g = group(1, 'Trail Runners');
    f.addChat(g, [ALEX, BLAIR, CASEY, DREW]);
    const hi = f.add(dm(ALEX), { from: ALEX, at: T0, text: 'dinner thursday?' });
    f.add(dm(ALEX), { from: 'me', at: T0 + MIN, text: 'yes! 7pm' });
    f.add(dm(ALEX), { from: 'me', at: T0 + 2 * MIN, assoc: { type: 2000, target_guid: `p:0/${String(hi.guid)}` }, text: null });
    f.add(g, { from: BLAIR, at: T0 + 5 * MIN, text: 'who is in for sunday' });
    f.add(g, { from: 'me', at: T0 + 6 * MIN, text: 'me' });
    f.add(g, { from: CASEY, at: T0 + 7 * MIN, text: 'count me in' });
    f.add(g, { from: ALEX, at: T0 + 8 * MIN, itemType: 2, groupTitle: 'Sunday Runners', text: null });
    f.add(dm(PARTIFUL_BIZ), { from: PARTIFUL_BIZ, at: T0 + 9 * MIN, text: '🤘 You’re now on the list for Pie Social!' });

    await tail(T0 + HOUR);
    const first = snapshot(db);
    expect(first.messages).toBe(7);
    expect(first.message_reactions).toBe(1);
    expect(first.membership_events).toBe(1);
    expect(first.partiful_text_signals).toBe(1);

    await overlap(T0 + 2 * HOUR);
    expect(snapshot(db)).toEqual(first);

    db.prepare(`UPDATE source_cursors SET cursor = '0' WHERE source = 'imessage'`).run();
    await tail(T0 + 3 * HOUR);
    expect(snapshot(db)).toEqual(first);
  });
});

describe('iMessage ingest: episodes', () => {
  it('folds tapbacks into message_reactions (never messages or interactions) and applies removals', async () => {
    const { f, db, tail } = setup();
    const theirs = f.add(dm(ALEX), { from: ALEX, at: T0, text: 'got the tickets' });
    const mine = f.add(dm(ALEX), { from: 'me', at: T0 + MIN, text: 'amazing' });
    f.add(dm(ALEX), { from: 'me', at: T0 + 2 * MIN, assoc: { type: 2000, target_guid: `p:0/${String(theirs.guid)}` }, text: 'Loved “got the tickets”' });
    f.add(dm(ALEX), { from: ALEX, at: T0 + 3 * MIN, assoc: { type: 2003, target_guid: `bp:${String(mine.guid)}` }, text: 'Laughed at “amazing”' });
    await tail();
    expect(count(db, 'messages')).toBe(2);
    const reactions = db.prepare('SELECT type, is_from_me, removed FROM message_reactions ORDER BY at').all();
    expect(reactions).toEqual([
      { type: 'love', is_from_me: 1, removed: 0 },
      { type: 'laugh', is_from_me: 0, removed: 0 },
    ]);
    const inter = db.prepare('SELECT msgs_from_me, msgs_from_them FROM interactions').all();
    expect(inter).toEqual([{ msgs_from_me: 1, msgs_from_them: 1 }]);

    f.add(dm(ALEX), { from: 'me', at: T0 + 4 * MIN, assoc: { type: 3000, target_guid: `p:0/${String(theirs.guid)}` }, text: null });
    await tail();
    expect(db.prepare(`SELECT removed FROM message_reactions WHERE type = 'love'`).pluck().get()).toBe(1);
    expect(count(db, 'messages')).toBe(2);
  });

  it('keeps tapbacks and replies that sync before their target (iCloud out-of-order rowids) and links them later', async () => {
    const { f, db, tail } = setup();
    const targetGuid = newGuid();
    // The tapback and an inline reply get lower rowids than the message they point at.
    f.add(dm(ALEX), { from: 'me', at: T0 + 2 * MIN, assoc: { type: 2001, target_guid: `p:0/${targetGuid}` }, text: 'Liked “see you sat”' });
    f.add(dm(ALEX), { from: 'me', at: T0 + 3 * MIN, text: 'can’t wait', threadOriginator: targetGuid });
    await tail();
    expect(count(db, 'message_reactions')).toBe(0);
    expect(count(db, 'pending_reactions')).toBe(1);
    expect(count(db, 'messages', 'reply_to_msg_id IS NOT NULL')).toBe(0);

    f.add(dm(ALEX), { from: ALEX, at: T0, text: 'see you sat', guid: targetGuid });
    await tail();
    expect(count(db, 'pending_reactions')).toBe(0);
    const target = db.prepare('SELECT id FROM messages WHERE source_msg_id = ?').pluck().get(targetGuid) as number;
    expect(db.prepare('SELECT message_id, type, is_from_me FROM message_reactions').all()).toEqual([
      { message_id: target, type: 'like', is_from_me: 1 },
    ]);
    expect(db.prepare('SELECT reply_to_msg_id FROM messages WHERE reply_to_msg_id IS NOT NULL').pluck().all()).toEqual([target]);

    // Idempotent: a full re-read neither duplicates the reaction nor re-parks it.
    db.prepare(`UPDATE source_cursors SET cursor = '0' WHERE source = 'imessage' AND scope = 'messages'`).run();
    await tail(T0 + 3 * HOUR);
    expect(count(db, 'message_reactions')).toBe(1);
    expect(count(db, 'pending_reactions')).toBe(0);
  });

  it('drops parked tapbacks whose target never syncs after 30 days (nightly pass)', async () => {
    const { f, db, tail, overlap } = setup();
    f.add(dm(ALEX), { from: 'me', at: T0, assoc: { type: 2001, target_guid: newGuid() }, text: 'Liked “gone”' });
    await tail(T0 + HOUR);
    expect(count(db, 'pending_reactions')).toBe(1);
    await overlap(T0 + 10 * 24 * HOUR);
    expect(count(db, 'pending_reactions')).toBe(1);
    await overlap(T0 + 31 * 24 * HOUR);
    expect(count(db, 'pending_reactions')).toBe(0);
  });

  it('marks a URL-balloon row that repeats the link of the text beside it as a duplicate', async () => {
    const { f, db, tail } = setup();
    f.add(dm(ALEX), { from: ALEX, at: T0, text: 'this place looks great https://example.com/menu' });
    f.add(dm(ALEX), { from: ALEX, at: T0 + 1000, text: 'https://example.com/menu', balloon: 'com.apple.messages.URLBalloonProvider' });
    f.add(dm(ALEX), { from: 'me', at: T0 + MIN, text: 'https://example.com/other' });
    await tail();
    expect(db.prepare('SELECT kind, dup_of IS NOT NULL AS dup FROM messages ORDER BY sent_at').all()).toEqual([
      { kind: 'text', dup: 0 },
      { kind: 'link', dup: 1 },
      { kind: 'link', dup: 0 },
    ]);
    expect(db.prepare('SELECT msg_count FROM sessions').pluck().all()).toEqual([2]);
  });

  it('attributes group sends with no sender handle (handle_id=0) to me', async () => {
    const { f, db, tail } = setup();
    const g = group(2, 'Book Club');
    f.addChat(g, [ALEX, BLAIR]);
    f.add(g, { from: 'me', at: T0, text: 'chapter 3 by friday?' });
    f.add(g, { from: ALEX, at: T0 + MIN, text: 'deal' });
    await tail();
    const mine = db.prepare(`SELECT is_from_me, sender_identity_id FROM messages WHERE text = 'chapter 3 by friday?'`).get();
    expect(mine).toEqual({ is_from_me: 1, sender_identity_id: null });
    const alex = phone(db, ALEX)!;
    expect(db.prepare('SELECT kind, msgs_from_me, msgs_from_them, initiated_by_me FROM interactions WHERE person_id = ?').get(alex.id)).toEqual({
      kind: 'group_session',
      msgs_from_me: 1,
      msgs_from_them: 1,
      initiated_by_me: 1,
    });
    // Only posters get group interactions; me never does.
    expect(count(db, 'interactions')).toBe(1);
    expect(db.prepare(`SELECT kind FROM conversations`).pluck().get()).toBe('group');
  });

  it('records membership events (add by handle rowid, leave, rename, remove) and keeps rosters current', async () => {
    const { f, db, tail, overlap } = setup();
    // chat.db joins the chat's CURRENT name onto every row, so it wins over the (older) rename event's title.
    const g = group(3, 'Hike Club');
    f.addChat(g, [ALEX]); // the current roster: Blair left, Drew was removed
    const drewRowid = f.addHandle(DREW);
    f.add(g, { from: 'me', at: T0, itemType: 1, groupActionType: 0, otherHandle: drewRowid, text: null });
    f.add(g, { from: BLAIR, at: T0 + MIN, itemType: 3, groupActionType: 0, text: null });
    f.add(g, { from: ALEX, at: T0 + 2 * MIN, itemType: 2, groupTitle: 'Hike Club', text: null });
    f.add(g, { from: ALEX, at: T0 + 3 * MIN, itemType: 1, groupActionType: 1, otherHandle: DREW, text: null });
    await tail();
    expect(db.prepare('SELECT action FROM membership_events ORDER BY at').pluck().all()).toEqual(['add', 'leave', 'rename', 'remove']);
    expect(db.prepare('SELECT title FROM conversations').pluck().get()).toBe('Hike Club');
    expect(db.prepare(`SELECT new_title FROM membership_events WHERE action = 'rename'`).pluck().get()).toBe('Hike Club');
    const active = (handle: string) =>
      db.prepare(`SELECT cm.is_active FROM conversation_members cm JOIN identities i ON i.id = cm.identity_id WHERE i.key = ?`).pluck().get(handle);
    expect([active(ALEX), active(BLAIR), active(DREW)]).toEqual([1, 0, 0]);
    expect(f.calls.filter((c) => c === '/v1/imessage/handles')).toHaveLength(1);

    await overlap(T0 + HOUR);
    expect(count(db, 'membership_events')).toBe(4);
    expect([active(ALEX), active(BLAIR), active(DREW)]).toEqual([1, 0, 0]);
  });

  it('applies edits from the edited endpoint', async () => {
    const { f, db, tail, overlap } = setup();
    const row = f.add(dm(ALEX), { from: ALEX, at: T0, text: 'see you at 7' });
    await tail(T0 + MIN);
    f.edit(row, 'see you at 8', T0 + 5 * MIN);
    await overlap(T0 + 10 * MIN);
    expect(db.prepare('SELECT text, edited_at FROM messages').get()).toEqual({ text: 'see you at 8', edited_at: T0 + 5 * MIN });
    expect(Number(readCursor(db, 'edited')!.cursor)).toBe(T0 + 5 * MIN);
  });

  it('an interrupted overlap pass fails (so the job retries) and never advances the edits mark past unseen rows', async () => {
    const { f, db, tail } = setup();
    const rows = [0, 1, 2].map((i) => f.add(dm(ALEX), { from: ALEX, at: T0 + i * MIN, text: `plan ${i}` }));
    await tail(T0 + 5 * MIN);
    // rowid order ≠ date_edited order: the last page holds the earliest edit
    f.edit(rows[0]!, 'plan 0 (edited)', T0 + 9 * MIN);
    f.edit(rows[1]!, 'plan 1 (edited)', T0 + 8 * MIN);
    f.edit(rows[2]!, 'plan 2 (edited)', T0 + 7 * MIN);
    const editedCalls = () => f.calls.filter((c) => c.startsWith('/v1/imessage/edited')).length;
    const stopAfterFirstEditedPage = { get aborted() { return editedCalls() >= 1; } } as AbortSignal;
    await expect(
      ingestOverlap(db, f.client(), { now: T0 + 10 * MIN, pageSize: 1, signal: stopAfterFirstEditedPage }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(readCursor(db, 'edited')).toBeUndefined();
    expect(db.prepare(`SELECT count(*) FROM runs WHERE status = 'running'`).pluck().get()).toBe(0);

    await ingestOverlap(db, f.client(), { now: T0 + 10 * MIN, pageSize: 1 });
    expect(db.prepare('SELECT text FROM messages ORDER BY sent_at').pluck().all()).toEqual(['plan 0 (edited)', 'plan 1 (edited)', 'plan 2 (edited)']);
    expect(Number(readCursor(db, 'edited')!.cursor)).toBe(T0 + 9 * MIN);
  });
});

describe('iMessage ingest: self thread', () => {
  it('stages non-bot self-thread text as pending commands and never bot rows', async () => {
    const { f, db, tail, overlap } = setup();
    await tail(T0); // first pass sets the cursor; nothing older than this is ever a command
    const me = db.prepare(`SELECT id FROM people WHERE kind = 'me'`).pluck().get() as string;
    expect(db.prepare('SELECT key FROM identities WHERE person_id = ? ORDER BY key').pluck().all(me)).toEqual([ME_PHONE, ME_EMAIL].sort());

    const sentGuid = newGuid();
    db.prepare(
      `INSERT INTO outbound_messages (id, client_ref, purpose, to_handle, text_hash, status, created_at) VALUES ('o1', 'r1', 'digest', ?, 'h', 'sent', ?)`,
    ).run(ME_PHONE, T0);
    db.prepare(`INSERT INTO outbound_guids (guid, outbound_id) VALUES (?, 'o1')`).run(sentGuid);

    const s = selfChat();
    f.add(s, { from: 'me', at: T0 - HOUR, text: 'old note to self' });
    const digest = f.add(s, { from: 'me', at: T0 + MIN, text: '\u{1F168} Today: 1. Reply to Alex' });
    f.add(s, { from: 'me', at: T0 + MIN + 1000, guid: sentGuid, text: 'Today: 1. Reply to Alex' });
    f.add(s, { from: 'me', at: T0 + 2 * MIN, text: 'done 1' });
    f.add(s, { from: ME_PHONE, at: T0 + 2 * MIN + 1500, text: 'done 1' }); // iPhone-typed copy of the same row
    f.add(s, { from: 'me', at: T0 + 3 * MIN, text: 'https://example.com/list' });
    f.add(s, { from: 'me', at: T0 + 4 * MIN, assoc: { type: 2001, target_guid: `p:0/${String(digest.guid)}` }, text: null });
    f.add(s, { from: ME_PHONE, at: T0 + 10 * MIN, text: 'snooze 2 1w' });
    await tail(T0 + 20 * MIN);

    expect(db.prepare('SELECT kind FROM conversations').pluck().all()).toEqual(['self']);
    expect(db.prepare(`SELECT raw_text, status FROM inbound_commands ORDER BY created_at, raw_text`).all()).toEqual([
      { raw_text: 'done 1', status: 'pending' },
      { raw_text: 'snooze 2 1w', status: 'pending' },
    ]);
    expect(db.prepare('SELECT count(*) FROM messages WHERE is_bot = 1').pluck().get()).toBe(2);
    // The iPhone-typed copy is mine, not a new person.
    expect(db.prepare(`SELECT count(*) FROM messages WHERE is_from_me = 0`).pluck().get()).toBe(0);
    expect(count(db, 'people', `kind = 'person'`)).toBe(0);
    expect(count(db, 'sessions')).toBe(0);

    await overlap(T0 + 30 * MIN);
    expect(count(db, 'inbound_commands')).toBe(2);
  });

  it('a row of mine whose raw text hashes like a send in flight is the bot\'s own, even without the marker', async () => {
    const { f, db, tail } = setup();
    await tail(T0);
    const text = 'Today: 1. Reply to Alex';
    db.prepare(
      `INSERT INTO outbound_messages (id, client_ref, purpose, to_handle, text_hash, status, created_at) VALUES ('o1', 'r1', 'digest', ?, ?, 'sending', ?)`,
    ).run(ME_PHONE, outboundTextHash(text), T0 + MIN);
    const s = selfChat();
    f.add(s, { from: 'me', at: T0 + MIN + 2000, text }); // the send, GUIDs not recorded yet
    f.add(s, { from: 'me', at: T0 + 5 * MIN, text }); // typed by me minutes later: a command
    await tail(T0 + 10 * MIN);
    expect(db.prepare('SELECT is_bot FROM messages ORDER BY sent_at').pluck().all()).toEqual([1, 0]);
    expect(db.prepare('SELECT raw_text FROM inbound_commands').pluck().all()).toEqual([text]);
  });

  it('self handles configured after ingest started: your number moves to you and its stand-in person is retired', async () => {
    const { f, db, tail } = setup([]);
    f.add(selfChat(), { from: 'me', at: T0, text: 'buy milk' });
    await tail(T0 + MIN);
    const standIn = phone(db, ME_PHONE)!;
    expect(standIn).toMatchObject({ status: 'provisional' });
    expect(count(db, 'interactions')).toBe(1);

    db.prepare(`UPDATE settings SET value = ? WHERE key = 'self_handles'`).run(JSON.stringify([ME_PHONE]));
    await tail(T0 + 2 * MIN);
    const me = db.prepare(`SELECT id FROM people WHERE kind = 'me'`).pluck().get();
    expect(phone(db, ME_PHONE)!.id).toBe(me);
    expect(db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(standIn.id)).toBe('suppressed');
    expect(db.prepare('SELECT kind FROM conversations').pluck().get()).toBe('self');
    expect(count(db, 'sessions')).toBe(0);
    expect(count(db, 'interactions')).toBe(0);
  });
});

describe('identity resolution from iMessage', () => {
  it('files service senders (short code, business chat, OTP, no-reply, toll-free, spam) as service, never people', async () => {
    const { f, db, tail } = setup();
    f.add(dm(SHORT_CODE, 'SMS'), { from: SHORT_CODE, at: T0, text: 'Your package is out for delivery' });
    f.add(dm(PARTIFUL_BIZ), { from: PARTIFUL_BIZ, at: T0 + MIN, text: '⏰ Pie Social is in 2 hours, at Rosewood Hall, 12 Main St!' });
    f.add(dm(PARTIFUL_SHORT, 'SMS'), { from: PARTIFUL_SHORT, at: T0 + 2 * MIN, text: '📣 The host of Pie Social sent a Text Blast: bring a fork' });
    f.add(dm(OTP_SENDER, 'SMS'), { from: OTP_SENDER, at: T0 + 3 * MIN, text: 'Your verification code is 482913' });
    f.add(dm(OTP_SENDER, 'SMS'), { from: OTP_SENDER, at: T0 + 4 * MIN, text: '771204 is your login code. Msg & data rates may apply' });
    f.add(dm('alerts@shop.example'), { from: 'alerts@shop.example', at: T0 + 5 * MIN, text: 'Your receipt' });
    f.add(dm('+18005550100', 'SMS'), { from: '+18005550100', at: T0 + 6 * MIN, text: 'Thanks for calling' });
    f.add(dm('+15125550198', 'SMS'), { from: '+15125550198', at: T0 + 7 * MIN, text: 'You won a prize', isSpam: true });
    await tail();

    const services = [
      personFor(db, 'shortcode', SHORT_CODE),
      personFor(db, 'business_chat', PARTIFUL_BIZ),
      personFor(db, 'shortcode', PARTIFUL_SHORT),
      phone(db, OTP_SENDER),
      personFor(db, 'email', 'alerts@shop.example'),
      phone(db, '+18005550100'),
      phone(db, '+15125550198'),
    ];
    for (const p of services) {
      expect(p).toMatchObject({ status: 'service', identity_status: 'service' });
      expect(visible(db, p!.id)).toBe(false);
    }
    expect(personFor(db, 'shortcode', SHORT_CODE)!.kind).toBe('shortcode');
    expect(personFor(db, 'business_chat', PARTIFUL_BIZ)!.display_name).toBe('Partiful');
    // Messages are kept as episodes, in business conversations where the sender is a business.
    expect(count(db, 'messages')).toBe(8);
    expect(count(db, 'conversations', `kind = 'business'`)).toBe(3);
    expect(count(db, 'interactions')).toBe(0);
    expect(count(db, 'person_visible')).toBe(0);
    expect(db.prepare('SELECT kind FROM partiful_text_signals ORDER BY sent_at').pluck().all()).toEqual(['reminder', 'blast']);
  });

  it('creates provisional people per §1.4 and keeps roster-only members hidden', async () => {
    const { f, db, tail } = setup();
    const g = group(4, 'Ski Trip');
    const g2 = group(5, 'Ski Trip Carpool');
    const FINN = '+15125550105';
    f.addChat(g, [ALEX, CASEY, DREW, EMERY, FINN]);
    f.addChat(g2, [EMERY]);
    f.add(dm(ALEX), { from: 'me', at: T0, text: 'hey, it is Sam from the climbing gym' });
    f.add(dm(BLAIR), { from: BLAIR, at: T0 + MIN, text: 'is this still your number?' });
    f.add(g, { from: CASEY, at: T0 + 2 * MIN, text: 'lift tickets are live' });
    // Two bare links in a group are a friend sharing, not a marketing sender (the OTP/link rule is 1:1 only).
    f.add(g, { from: DREW, at: T0 + 3 * MIN, text: 'https://example.com/a' });
    f.add(g, { from: DREW, at: T0 + 4 * MIN, text: 'https://example.com/b' });
    await tail(T0 + HOUR);

    expect(phone(db, ALEX)!.status).toBe('provisional'); // I sent ≥1 message
    expect(phone(db, BLAIR)!.status).toBe('roster_only'); // one inbound message is not enough
    expect(phone(db, CASEY)!.status).toBe('provisional'); // posted in a group with a known person
    expect(phone(db, DREW)!.status).toBe('provisional'); // posted twice (links) in a group: a person, not a service
    expect(personFor(db, 'email', EMERY)!.status).toBe('provisional'); // in two groups
    expect(phone(db, FINN)!.status).toBe('roster_only'); // roster entry that never posted
    // Provisional people are visible (the API flags them as "New people"); roster-only ones appear nowhere.
    expect(visible(db, phone(db, ALEX)!.id)).toBe(true);
    expect(visible(db, phone(db, FINN)!.id)).toBe(false);
    expect(phone(db, ALEX)!.display_name).toBe('(512) •••-••01');
    expect(personFor(db, 'email', EMERY)!.display_name).toBe('e•••@example.com');

    // Each new person is one create_person batch (provisional ones are not created-then-promoted).
    const alex = phone(db, ALEX)!;
    expect(db.prepare('SELECT kind FROM change_batches WHERE subject_person_id = ?').pluck().all(alex.id)).toEqual(['create_person']);

    f.add(dm(BLAIR), { from: BLAIR, at: T0 + 2 * HOUR, text: 'it is Blair btw' });
    const s = await tail(T0 + 3 * HOUR);
    expect(s.promoted).toBe(1);
    const blair = phone(db, BLAIR)!;
    expect(blair.status).toBe('provisional');
    expect(db.prepare('SELECT kind FROM change_batches WHERE subject_person_id = ? ORDER BY seq').pluck().all(blair.id)).toEqual([
      'create_person',
      'person_update',
    ]);
  });

  it('undo of a create_person batch suppresses the person, and re-ingest never recreates it', async () => {
    const { f, db, tail, overlap } = setup();
    f.add(dm(ALEX), { from: 'me', at: T0, text: 'lunch?' });
    f.add(dm(ALEX), { from: ALEX, at: T0 + MIN, text: 'sure' });
    await tail(T0 + HOUR);
    const alex = phone(db, ALEX)!;
    expect(count(db, 'interactions', `person_id = '${alex.id}'`)).toBe(1);
    const batch = db.prepare(`SELECT id FROM change_batches WHERE kind = 'create_person' AND subject_person_id = ?`).pluck().get(alex.id) as string;

    undoBatch(db, batch, { now: T0 + 2 * HOUR });
    expect(phone(db, ALEX)).toMatchObject({ id: alex.id, status: 'suppressed', identity_status: 'active' });
    expect(visible(db, alex.id)).toBe(false);
    const people = count(db, 'people');

    f.add(dm(ALEX), { from: ALEX, at: T0 + 3 * HOUR, text: 'still on?' });
    await overlap(T0 + 4 * HOUR);
    db.prepare(`UPDATE source_cursors SET cursor = '0' WHERE source = 'imessage' AND scope = 'messages'`).run();
    await tail(T0 + 5 * HOUR);

    expect(count(db, 'people')).toBe(people);
    expect(phone(db, ALEX)).toMatchObject({ id: alex.id, status: 'suppressed' });
    expect(count(db, 'messages')).toBe(3);
    expect(count(db, 'interactions', `person_id = '${alex.id}'`)).toBe(0);
    expect(count(db, 'change_batches', `kind = 'create_person' AND subject_person_id = '${alex.id}'`)).toBe(1);
  });
});

describe('Partiful texts in iMessage', () => {
  it('parses invite and RSVP texts and pairs each with its separate link row', async () => {
    const { f, db, tail } = setup();
    f.add(dm(PARTIFUL_BIZ), {
      from: PARTIFUL_BIZ,
      at: T0,
      text: '🎉 Hey Sam, Riley Park invited you to Taco Night!\nReply X to stop invites from this host',
    });
    f.add(dm(PARTIFUL_BIZ), { from: PARTIFUL_BIZ, at: T0 + 2000, text: 'https://partiful.com/e/AbC123xyz?ac=true' });
    f.add(dm(PARTIFUL_SHORT, 'SMS'), { from: PARTIFUL_SHORT, at: T0 + HOUR, text: '🤘 You’re now on the list for Taco Night!' });
    f.add(dm(PARTIFUL_SHORT, 'SMS'), { from: PARTIFUL_SHORT, at: T0 + HOUR + 1500, text: 'https://partiful.com/e/AbC123xyz?c=1&rsvped=true' });
    await tail(T0 + 2 * HOUR);
    const rows = db
      .prepare(`SELECT kind, event_id, title, inviter_name, rsvp, paired_message_id IS NOT NULL AS paired FROM partiful_text_signals ORDER BY sent_at`)
      .all();
    expect(rows).toEqual([
      { kind: 'invite', event_id: 'AbC123xyz', title: 'Taco Night', inviter_name: 'Riley Park', rsvp: 'invited', paired: 1 },
      { kind: 'link', event_id: 'AbC123xyz', title: null, inviter_name: null, rsvp: null, paired: 1 },
      { kind: 'rsvp', event_id: 'AbC123xyz', title: 'Taco Night', inviter_name: null, rsvp: 'going', paired: 1 },
      { kind: 'link', event_id: 'AbC123xyz', title: null, inviter_name: null, rsvp: 'going', paired: 1 },
    ]);
  });
});
