import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { ingestBeeperInstagram } from '../../../src/adapters/beeper/ingest';
import { beeperJobs, BEEPER_TOKEN_SECRET, resolveBeeperToken } from '../../../src/adapters/beeper/jobs';
import { readCursor } from '../../../src/adapters/common/cursors';
import { episodeWriter } from '../../../src/adapters/common/episodes';
import { canonicalId } from '../../../src/db/canon';
import { undoBatch } from '../../../src/journal/undo';
import { Scheduler } from '../../../src/scheduler/scheduler';
import { getSecret } from '../../../src/security/secrets';
import { memDb } from '../../helpers';
import { FakeBeeper, igUser, JORDAN, ME_IG, ME_MATRIX, MIN, ORIGIN, ROBIN, SELF_PARTICIPANT, SKY, T0 } from './fakeBeeper';

type DB = ReturnType<typeof memDb>;
const count = (db: DB, table: string, where = '1', ...args: unknown[]) =>
  db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get(...args) as number;
const identityOf = (db: DB, kind: string, key: string) =>
  db.prepare('SELECT id, person_id, status FROM identities WHERE kind = ? AND key = ?').get(kind, key) as
    | { id: string; person_id: string; status: string }
    | undefined;
const personOf = (db: DB, id: string) =>
  db.prepare('SELECT display_name, kind, status FROM people WHERE id = ?').get(canonicalId(db, id)) as { display_name: string; kind: string; status: string };

const fakes: FakeBeeper[] = [];
const fake = () => {
  const f = new FakeBeeper();
  fakes.push(f);
  return f;
};
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

const DM = '!dm-robin:beeper.local';
const GROUP = '!group-climb:beeper.local';

/** A DM with Robin (I replied) and a group with Robin, Sky and a never-posting Jordan. */
function world() {
  const db = memDb();
  const f = fake();
  f.addChat(DM, { participants: [ROBIN, SELF_PARTICIPANT] });
  const hi = f.add(DM, { from: ROBIN, at: T0, text: 'are you around saturday?' });
  f.add(DM, { from: 'me', at: T0 + MIN, text: 'yes! climbing?', linkedMessageID: hi.id as string });
  f.react(DM, hi.id as string, 'me', '❤️', T0 + 2 * MIN);
  f.addChat(GROUP, { type: 'group', title: 'Climbing crew', participants: [ROBIN, SKY, JORDAN, SELF_PARTICIPANT] });
  f.add(GROUP, { from: SKY, at: T0 + 3 * MIN, text: 'gym at 7?' });
  f.add(GROUP, { from: SKY, at: T0 + 4 * MIN, text: 'bringing the rope' });
  f.add(GROUP, { from: ROBIN, at: T0 + 5 * MIN, type: 'IMAGE', attachments: [{ type: 'img', mimeType: 'image/jpeg', fileSize: 1200, srcURL: 'file:///tmp/x.jpg', fileName: 'x.jpg' }] });
  // Chats on other networks are never read.
  f.addChat('!imsg:beeper.local', { participants: [ROBIN], accountID: 'imessage_abc' });
  f.add('!imsg:beeper.local', { from: ROBIN, at: T0 + 9 * MIN, text: 'not instagram' });
  return { db, f };
}

describe('Beeper → Instagram ingest', () => {
  it('reads Instagram only and maps chats, participants, messages, reactions and replies', async () => {
    const { db, f } = world();
    const stats = await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    expect(stats).toMatchObject({ accounts: 1, chats_listed: 2, chats_synced: 2, messages_new: 5 });
    // The chat list was filtered to the Instagram account; no other network's chat was ever opened.
    expect(f.requests.filter((r) => r.path.startsWith('/v1/chats?')).every((r) => r.path.includes('accountIDs=instagramgo.9000000001'))).toBe(true);
    expect(f.requests.some((r) => r.path.includes(encodeURIComponent('!imsg:beeper.local')))).toBe(false);
    expect(f.requests.every((r) => r.method === 'GET')).toBe(true);

    expect(db.prepare(`SELECT source, kind, title, member_count FROM conversations ORDER BY kind`).all()).toEqual([
      { source: 'instagram', kind: 'direct', title: null, member_count: 2 },
      { source: 'instagram', kind: 'group', title: 'Climbing crew', member_count: 4 },
    ]);
    // Participants: numeric IG id + username on one person, fullName as the display name (Beeper precedence).
    const robinId = identityOf(db, 'instagram_id', '9000000002')!;
    const robinUser = identityOf(db, 'instagram_username', 'robin.example')!;
    expect(canonicalId(db, robinUser.person_id)).toBe(canonicalId(db, robinId.person_id));
    expect(personOf(db, robinId.person_id)).toMatchObject({ display_name: 'Robin Example', status: 'provisional' });
    expect(db.prepare(`SELECT name_raw, source FROM alias_obs WHERE identity_id = ?`).all(robinId.id)).toEqual([{ name_raw: 'Robin Example', source: 'beeper' }]);
    // My account, my username and Beeper's self user are mine; I'm never a conversation member.
    const me = db.prepare(`SELECT id FROM people WHERE kind = 'me'`).pluck().get() as string;
    for (const [kind, key] of [['instagram_id', ME_IG], ['instagram_username', 'owner.sample'], ['beeper_user', ME_MATRIX]] as const) {
      expect(identityOf(db, kind, key)?.person_id, `${kind}`).toBe(me);
    }
    expect(count(db, 'conversation_members cm JOIN identities i ON i.id = cm.identity_id', 'i.person_id = ?', me)).toBe(0);

    // Messages: source 'instagram', mine flagged, the reply linked, the image kept as metadata (no URL, no file name).
    const rows = db.prepare(`SELECT source, is_from_me, kind, text, reply_to_msg_id, attachments FROM messages ORDER BY sent_at`).all() as Record<string, unknown>[];
    expect(rows.map((r) => [r.source, r.is_from_me, r.kind])).toEqual([
      ['instagram', 0, 'text'],
      ['instagram', 1, 'text'],
      ['instagram', 0, 'text'],
      ['instagram', 0, 'text'],
      ['instagram', 0, 'attachment'],
    ]);
    expect(rows[1]!.reply_to_msg_id).not.toBeNull();
    expect(JSON.parse(rows[4]!.attachments as string)).toEqual([{ type: 'img', mime: 'image/jpeg', bytes: 1200 }]);
    // The REACTION event is not a message; the reaction is folded onto its target with the event's time.
    expect(db.prepare('SELECT is_from_me, type, emoji, removed, at FROM message_reactions').all()).toEqual([
      { is_from_me: 1, type: 'emoji', emoji: '❤️', removed: 0, at: T0 + 2 * MIN },
    ]);

    // Group roster: everyone listed is a member; Jordan never posted and stays a hidden roster-only person.
    const group = db.prepare(`SELECT id FROM conversations WHERE kind = 'group'`).pluck().get() as string;
    expect(count(db, 'conversation_members', 'conversation_id = ? AND is_active = 1', group)).toBe(3);
    expect(personOf(db, identityOf(db, 'instagram_id', '9000000004')!.person_id).status).toBe('roster_only');
    expect(personOf(db, identityOf(db, 'instagram_id', '9000000003')!.person_id).status).toBe('provisional');

    // Derived activity exists, and everything people-related is journaled in one run.
    expect(count(db, 'interactions', `channel = 'instagram'`)).toBeGreaterThan(0);
    expect(db.prepare(`SELECT DISTINCT kind FROM runs`).pluck().all()).toEqual(['ingest']);
    expect(db.prepare(`SELECT status, last_error FROM source_health WHERE source = 'instagram'`).get()).toEqual({ status: 'ok', last_error: null });
  });

  it('is incremental: an idle pass reads no messages, new activity re-reads the head only', async () => {
    const { db, f } = world();
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    const before = f.messageRequests().length;
    const batches = count(db, 'change_batches');
    const idle = await ingestBeeperInstagram(db, f.client(), { now: T0 + 40 * MIN });
    expect(f.messageRequests().length).toBe(before);
    expect(count(db, 'change_batches')).toBe(batches);
    expect(count(db, 'runs')).toBe(1); // the idle pass left no run behind
    expect(idle).toMatchObject({ chats_synced: 0, chats_listed: 0 });
    expect(count(db, 'messages')).toBe(5);

    f.add(DM, { from: ROBIN, at: T0 + 50 * MIN, text: 'see you at 7' });
    const next = await ingestBeeperInstagram(db, f.client(), { now: T0 + 70 * MIN });
    expect(next).toMatchObject({ chats_synced: 1, messages_new: 1 });
    expect(f.messageRequests().length).toBe(before + 1);
    expect(readCursor(db, 'instagram', DM)?.high_water_at).toBe(T0 + 50 * MIN);
  });

  it('closes a gap of more than one page by walking back to the high-water mark', async () => {
    const { db, f } = world();
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    for (let i = 0; i < 45; i++) f.add(DM, { from: i % 2 ? 'me' : ROBIN, at: T0 + 60 * MIN + i * 1000, text: `msg ${i}` });
    const s = await ingestBeeperInstagram(db, f.client(), { now: T0 + 2 * 60 * MIN });
    expect(s.messages_new).toBe(45);
    expect(count(db, 'messages', `conversation_id = (SELECT id FROM conversations WHERE kind = 'direct')`)).toBe(47);
    expect(JSON.parse(readCursor(db, 'instagram', DM)!.meta!).pending).toEqual([]);
  });

  it('backfills long histories across passes within the request budget', async () => {
    const db = memDb();
    const f = fake();
    f.addChat(DM, { participants: [ROBIN, SELF_PARTICIPANT] });
    for (let i = 0; i < 95; i++) f.add(DM, { from: i % 3 ? ROBIN : 'me', at: T0 + i * MIN, text: `history ${i}` });
    const first = await ingestBeeperInstagram(db, f.client(), { now: T0 + 200 * MIN, maxPagesPerChat: 2 });
    expect(first.messages_new).toBe(60); // head + 2 older pages
    expect(JSON.parse(readCursor(db, 'instagram', DM)!.meta!).complete).toBeFalsy();
    const second = await ingestBeeperInstagram(db, f.client(), { now: T0 + 230 * MIN, maxPagesPerChat: 2 });
    expect(second.messages_new).toBe(35);
    const meta = JSON.parse(readCursor(db, 'instagram', DM)!.meta!);
    expect(meta).toMatchObject({ complete: true, pending: [] });
    expect(count(db, 'messages')).toBe(95);
    // A further pass with no activity reads nothing.
    const n = f.messageRequests().length;
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 260 * MIN });
    expect(f.messageRequests().length).toBe(n);
  });

  it('stops at the request budget and resumes the chats it did not reach', async () => {
    const db = memDb();
    const f = fake();
    for (let i = 0; i < 6; i++) {
      const id = `!dm${i}:beeper.local`;
      f.addChat(id, { participants: [{ id: igUser(`90000001${i}0`), fullName: `Person ${i}` }, SELF_PARTICIPANT] });
      f.add(id, { from: { id: igUser(`90000001${i}0`), fullName: `Person ${i}` }, at: T0 + i * MIN, text: `hi ${i}` });
    }
    const a = await ingestBeeperInstagram(db, f.client(), { now: T0 + HOUR(1), maxRequests: 4 });
    expect(a.chats_synced).toBe(2); // accounts + chat list + 2 heads = the budget
    const b = await ingestBeeperInstagram(db, f.client(), { now: T0 + HOUR(2) });
    expect(a.chats_synced + b.chats_synced).toBe(6);
    expect(count(db, 'messages')).toBe(6);
  });

  it('reactions follow the source: changed emoji updates, a removed reaction is removed', async () => {
    const { db, f } = world();
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    const target = f.chats.get(DM)!.messages[0]!.id as string;
    f.react(DM, target, ROBIN, '😂', T0 + 20 * MIN);
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 30 * MIN });
    expect(db.prepare('SELECT is_from_me, emoji, removed FROM message_reactions ORDER BY at').all()).toEqual([
      { is_from_me: 1, emoji: '❤️', removed: 0 },
      { is_from_me: 0, emoji: '😂', removed: 0 },
    ]);
    f.unreact(DM, target, 'me');
    f.add(DM, { from: ROBIN, at: T0 + 35 * MIN, text: 'nudge' });
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 40 * MIN });
    expect(db.prepare('SELECT is_from_me, removed FROM message_reactions ORDER BY is_from_me DESC').all()).toEqual([
      { is_from_me: 1, removed: 1 },
      { is_from_me: 0, removed: 0 },
    ]);
  });

  it('a member who left the group is marked inactive on the next roster', async () => {
    const { db, f } = world();
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    f.setParticipants(GROUP, [ROBIN, SKY, SELF_PARTICIPANT]);
    f.add(GROUP, { from: SKY, at: T0 + 20 * MIN, text: 'jordan left' });
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 30 * MIN });
    const jordan = identityOf(db, 'instagram_id', '9000000004')!.id;
    expect(db.prepare('SELECT is_active FROM conversation_members WHERE identity_id = ?').pluck().get(jordan)).toBe(0);
  });

  it('a username now on a different Instagram account is not merged into it', async () => {
    const { db, f } = world();
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    // A new account took Robin's old username.
    const newcomer = { id: igUser('9000000009'), fullName: 'Casey Newname', username: 'robin.example' };
    f.addChat('!dm-new:beeper.local', { participants: [newcomer, SELF_PARTICIPANT] });
    f.add('!dm-new:beeper.local', { from: newcomer, at: T0 + 20 * MIN, text: 'hey' });
    const s = await ingestBeeperInstagram(db, f.client(), { now: T0 + 30 * MIN });
    expect(s.username_conflicts).toBe(1);
    const a = canonicalId(db, identityOf(db, 'instagram_id', '9000000002')!.person_id);
    const b = canonicalId(db, identityOf(db, 'instagram_id', '9000000009')!.person_id);
    expect(a).not.toBe(b);
  });

  it('a Beeper message supersedes the DYI row an earlier export import wrote for it', async () => {
    const { db, f } = world();
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    const conv = db.prepare(`SELECT id FROM conversations WHERE kind = 'direct'`).pluck().get() as string;
    const w = episodeWriter(db, { now: T0 });
    w.upsertMessage({ source: 'instagram_dyi', sourceMsgId: 'dyi:x', conversationId: conv, senderIdentityId: null, isFromMe: true, sentAt: T0 + 60 * MIN + 900, kind: 'text', text: 'Running  LATE' });
    f.add(DM, { from: 'me', at: T0 + 60 * MIN, text: 'running late' });
    const s = await ingestBeeperInstagram(db, f.client(), { now: T0 + 70 * MIN });
    expect(s.dyi_superseded).toBe(1);
    expect(db.prepare(`SELECT dup_of IS NOT NULL FROM messages WHERE source_msg_id = 'dyi:x'`).pluck().get()).toBe(1);
  });

  it('agent writes are undoable: undoing a new person suppresses it', async () => {
    const { db, f } = world();
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    const sky = identityOf(db, 'instagram_id', '9000000003')!;
    const batch = db.prepare(`SELECT id FROM change_batches WHERE kind = 'create_person' AND subject_person_id = ?`).pluck().get(sky.person_id) as string;
    // Its username link and promotion depend on it, so the undo cascades.
    undoBatch(db, batch, { now: T0 + 11 * MIN, cascade: true });
    expect(db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(sky.person_id)).toBe('suppressed');
  });

  it('an Instagram account that is not connected makes the source auth_required', async () => {
    const { db, f } = world();
    f.accounts[0]!.status = 'reconnect_required';
    f.accounts[0]!.statusText = 'Reconnect required';
    await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
    const h = db.prepare(`SELECT status, last_error FROM source_health WHERE source = 'instagram'`).get() as { status: string; last_error: string };
    expect(h.status).toBe('auth_required');
    expect(h.last_error).toMatch(/Reconnect required.*reconnect Instagram/);

    const none = fake();
    none.accounts = none.accounts.filter((a) => a.network !== 'Instagram');
    const db2 = memDb();
    const s = await ingestBeeperInstagram(db2, none.client(), { now: T0 });
    expect(s.accounts).toBe(0);
    expect(none.requests.map((r) => r.path)).toEqual(['/v1/accounts']);
    expect(db2.prepare(`SELECT status FROM source_health WHERE source = 'instagram'`).pluck().get()).toBe('auth_required');
  });

  it("a connecting or backfilling account (or one without a status) is healthy, not 'reconnect'", async () => {
    for (const status of ['backfilling', 'connecting', undefined]) {
      const { db, f } = world();
      f.accounts[0]!.status = status as string;
      const s = await ingestBeeperInstagram(db, f.client(), { now: T0 + 10 * MIN });
      expect(s.accounts_not_connected, String(status)).toBe(0);
      const h = db.prepare(`SELECT status, last_error, details FROM source_health WHERE source = 'instagram'`).get() as { status: string; last_error: string | null; details: string };
      expect(h).toMatchObject({ status: 'ok', last_error: null });
      expect(JSON.parse(h.details).accounts_syncing).toBe(status ? 1 : undefined);
    }
  });
});

const HOUR = (n: number) => n * 60 * MIN;

describe('beeper-instagram job', () => {
  it('keeps the env token encrypted in secrets and falls back to it', () => {
    const db = memDb();
    const key = crypto.randomBytes(32);
    expect(resolveBeeperToken(db, { token: 'tok-a', secretsKey: key })).toBe('tok-a');
    expect(getSecret(db, key, BEEPER_TOKEN_SECRET)).toBe('tok-a');
    expect(resolveBeeperToken(db, { token: null, secretsKey: key })).toBe('tok-a');
    expect(resolveBeeperToken(db, { token: null, secretsKey: null })).toBeNull();
    // The stored value is ciphertext, never the token.
    const raw = db.prepare(`SELECT ciphertext FROM secrets WHERE name = ?`).pluck().get(BEEPER_TOKEN_SECRET) as Buffer;
    expect(raw.toString('utf8')).not.toContain('tok-a');
  });

  it('runs every 30 min; a rejected token → auth_required and skipped; no token → skipped', async () => {
    const { db, f } = world();
    const [job] = beeperJobs({ url: ORIGIN, token: null, secretsKey: null, client: f.client({ token: 'revoked' }) });
    expect(job!.name).toBe('beeper-instagram');
    expect(job!.schedule).toEqual({ kind: 'interval', everyMs: 30 * MIN });
    const s = new Scheduler({ db, jobs: [job!], clock: { now: () => T0 } });
    const r = await s.runNow('beeper-instagram');
    expect(r.status).toBe('skipped');
    expect(db.prepare(`SELECT status FROM source_health WHERE source = 'instagram'`).pluck().get()).toBe('auth_required');

    const [noToken] = beeperJobs({ url: ORIGIN, token: null, secretsKey: null });
    const s2 = new Scheduler({ db, jobs: [noToken!], clock: { now: () => T0 } });
    expect((await s2.runNow('beeper-instagram')).status).toBe('skipped');

    const [ok] = beeperJobs({ url: ORIGIN, token: null, secretsKey: null, client: f.client() });
    const s3 = new Scheduler({ db, jobs: [ok!], clock: { now: () => T0 + 10 * MIN } });
    expect((await s3.runNow('beeper-instagram')).status).toBe('ok');
    expect(count(db, 'messages')).toBe(5);
  });
});
