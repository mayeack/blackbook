import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../src/db/connection';
import { migrateLegacy } from '../../src/migration/index';
import { memDb, tempDir } from '../helpers';
import { buildLegacyStore, cd, legacyUuid, type Fixture } from './fixture';
import { NOW, scenario, T, TZ } from './scenario';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const P = (pk: number) => legacyUuid('Contact', pk);
const count = (db: DB, sql: string, ...p: unknown[]) => Number(db.prepare(sql).pluck().get(...p));

const interactions: Fixture['interactions'] = [
  { pk: 1, contact: 1, date: cd(T), direction: 'Received', summary: 'see you at 7' },
  { pk: 2, contact: 1, date: cd(T + 60_000), direction: 'Sent', summary: 'on my way' },
  { pk: 3, contact: 1, date: cd(T + 1_000), direction: 'Received', summary: 'Loved “see you at 7”' },
  { pk: 4, contact: 9, date: cd(T + 120_000), direction: 'Received', summary: 'unmatched hello' },
  { pk: 5, contact: 6, date: cd(T + 180_000), type: 'Call', duration: 300 },
  { pk: 6, contact: 3, date: cd(T + 240_000), direction: 'Received', summary: 'from the old address' },
  { pk: 7, contact: 1, date: cd(T + 300_000), direction: 'Received', summary: 'too far apart' },
];

function setup() {
  const t = tempDir('yb-legacy-');
  cleanups.push(t.cleanup);
  fs.mkdirSync(path.join(t.dir, 'source'));
  const sourcePath = buildLegacyStore(path.join(t.dir, 'source', 'default.store'), scenario({ interactions }));
  const db = memDb();
  const go = (o: Partial<Parameters<typeof migrateLegacy>[0]> = {}) =>
    migrateLegacy({ db, sourcePath, importsDir: path.join(t.dir, 'imports'), timeZone: TZ, now: NOW, ...o });
  expect(go().ok).toBe(true);
  return { db, go };
}

/** Ingested chat.db history (what the iMessage backfill would have written). */
function seedImessage(db: DB) {
  const ident = (kind: string, key: string) => db.prepare('SELECT id FROM identities WHERE kind = ? AND key = ?').pluck().get(kind, key) as string;
  const alexPhone = ident('phone', '+12125550101');
  const alexOldEmail = ident('email', 'alex.r@example.org');
  const conv = (member: string) => {
    const id = uuidv7();
    db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'imessage', ?, 'direct', ?, ?)`).run(id, id, NOW, NOW);
    db.prepare(
      `INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`,
    ).run(id, member, NOW, NOW);
    return id;
  };
  const c1 = conv(alexPhone);
  const c2 = conv(alexOldEmail);
  const other = uuidv7();
  db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'imessage', ?, 'direct', ?, ?)`).run(other, other, NOW, NOW);
  const msg = (convId: string, sender: string | null, fromMe: boolean, at: number, text: string) =>
    db
      .prepare(
        `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
         VALUES ('imessage', ?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
      )
      .run(uuidv7(), convId, sender, fromMe ? 1 : 0, at, text, NOW, NOW);
  msg(c1, alexPhone, false, T + 1_500, 'see you at 7');
  msg(other, null, true, T + 60_000, 'on my way'); // same time, wrong conversation: must not match
  msg(c1, null, true, T + 59_200, 'on my way');
  msg(c2, alexOldEmail, false, T + 240_500, 'from the old address');
  msg(c1, alexPhone, false, T + 303_000, 'too far apart'); // 3 s off: outside ±2 s
}

describe('legacy migration — reconcile phase', () => {
  it('refuses to run before any iMessage history is ingested', () => {
    const { db, go } = setup();
    const r = go({ phase: 'reconcile' });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/after the backfill/);
    expect(count(db, "SELECT count(*) FROM messages WHERE source = 'legacy'")).toBe(0);
  });

  it('matches by identity + direction + ±2 s, drops tapbacks, imports the rest as legacy messages', () => {
    const { db, go } = setup();
    seedImessage(db);
    const r = go({ phase: 'reconcile', now: NOW + 1000 });
    expect(r.problems).toEqual([]);
    expect(r.reconcile).toMatchObject({
      total: 7,
      tapbacksDropped: 1,
      nonText: 1,
      eligible: 5,
      matched: 3,
      matchedByText: 3,
      insertedMessages: 2,
      insertedConversations: 2,
      insertedInteractions: 1,
      targetMet: false,
    });
    expect(r.reconcile!.matchRate).toBeCloseTo(0.6);
    const legacy = db
      .prepare(
        `SELECT m.source_msg_id, m.is_from_me, m.sent_at, c.source_conv_id, i.kind AS ident_kind, i.person_id
         FROM messages m JOIN conversations c ON c.id = m.conversation_id LEFT JOIN identities i ON i.id = m.sender_identity_id
         WHERE m.source = 'legacy' ORDER BY m.sent_at`,
      )
      .all();
    expect(legacy).toEqual([
      { source_msg_id: legacyUuid('Interaction', 4), is_from_me: 0, sent_at: T + 120_000, source_conv_id: `legacy:${P(9)}`, ident_kind: 'legacy_id', person_id: P(9) },
      { source_msg_id: legacyUuid('Interaction', 7), is_from_me: 0, sent_at: T + 300_000, source_conv_id: `legacy:${P(1)}`, ident_kind: 'legacy_id', person_id: P(1) },
    ]);
    expect(db.prepare("SELECT kind, person_id, ended_at - started_at AS dur FROM interactions WHERE origin = 'legacy'").all()).toEqual([
      { kind: 'call', person_id: P(6), dur: 300_000 },
    ]);
    // tapbacks never become messages
    expect(count(db, "SELECT count(*) FROM messages WHERE text LIKE 'Loved%'")).toBe(0);
    // unmatched history is sessionized: one session + one derived dm_session per legacy conversation
    expect(r.reconcile).toMatchObject({ legacySessions: 2, legacyDerivedInteractions: 2 });
    const derived = db
      .prepare(
        `SELECT i.person_id, i.kind, i.channel, i.msgs_from_them, s.msg_count FROM interactions i
         JOIN sessions s ON s.id = i.session_id JOIN conversations c ON c.id = s.conversation_id
         WHERE i.origin = 'derived' AND c.source = 'legacy' ORDER BY i.started_at`,
      )
      .all();
    expect(derived).toEqual([
      { person_id: P(9), kind: 'dm_session', channel: 'legacy', msgs_from_them: 1, msg_count: 1 },
      { person_id: P(1), kind: 'dm_session', channel: 'legacy', msgs_from_them: 1, msg_count: 1 },
    ]);
  });

  it('is idempotent, and its dry run rolls back', () => {
    const { db, go } = setup();
    seedImessage(db);
    const dry = go({ phase: 'reconcile', dryRun: true });
    expect(dry.reconcile!.insertedMessages).toBe(2);
    expect(count(db, "SELECT count(*) FROM messages WHERE source = 'legacy'")).toBe(0);
    expect(count(db, "SELECT count(*) FROM identities WHERE kind = 'legacy_id'")).toBe(0);
    go({ phase: 'reconcile' });
    const again = go({ phase: 'reconcile', now: NOW + 5000 });
    expect(again.reconcile).toMatchObject({ matched: 3, alreadyImported: 2, insertedMessages: 0, insertedConversations: 0, insertedInteractions: 0 });
    expect(count(db, "SELECT count(*) FROM messages WHERE source = 'legacy'")).toBe(2);
    expect(count(db, "SELECT count(*) FROM sessions s JOIN conversations c ON c.id = s.conversation_id WHERE c.source = 'legacy'")).toBe(2);
    expect(count(db, "SELECT count(*) FROM interactions WHERE origin = 'derived' AND channel = 'legacy'")).toBe(2);
  });
});
