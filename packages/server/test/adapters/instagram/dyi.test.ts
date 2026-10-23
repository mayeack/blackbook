import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sourceRun } from '../../../src/adapters/common/context';
import { episodeWriter } from '../../../src/adapters/common/episodes';
import { importInstagramDyi, mapDyiMessage, personalInfo, relationshipEntries, threadKeyOf } from '../../../src/adapters/instagram/dyi';
import { dyiEntryType } from '../../../src/adapters/instagram/dyiFiles';
import { instagramDyiJobs } from '../../../src/adapters/instagram/jobs';
import { fixMojibake, parseDyiJson } from '../../../src/adapters/instagram/text';
import { canonicalId } from '../../../src/db/canon';
import { attachExternalIdentity } from '../../../src/identity/external';
import { ensureMe } from '../../../src/identity/resolver';
import { Scheduler } from '../../../src/scheduler/scheduler';
import { memDb, T0, tempDir } from '../../helpers';
import {
  dyiJson,
  followersJson,
  followingJson,
  JORDAN,
  mojibake,
  OWNER,
  personalJson,
  ROBIN,
  SKY,
  threadJson,
  writeFolder,
  zipBuffer,
  type ExportFiles,
} from './dyiFixture';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const count = (db: DB, table: string, where = '1', ...args: unknown[]) =>
  db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get(...args) as number;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const dir = () => {
  const t = tempDir('yb-dyi-');
  cleanups.push(t.cleanup);
  return t.dir;
};

const ROOT = 'instagram-owner-2026-10-01';
const ACT = `${ROOT}/your_instagram_activity/messages/inbox`;
const DM_FOLDER = 'robinexample_1234567890';
const GROUP_FOLDER = 'climbingcrew_9876543210';

/** A JSON export: my profile, a DM with Robin, a group with Robin, Sky and Jordan, followers and following. */
function exportFiles(o: { personal?: boolean } = {}): ExportFiles {
  const files: ExportFiles = {
    [`${ACT}/${DM_FOLDER}/message_1.json`]: dyiJson(
      threadJson({
        participants: [ROBIN, OWNER],
        folder: DM_FOLDER,
        messages: [
          { sender_name: ROBIN, timestamp_ms: T0 - 30 * DAY, content: 'café tomorrow? ☕', reactions: [{ reaction: '❤️', actor: OWNER, timestamp: Math.round((T0 - 30 * DAY + MIN) / 1000) }] },
          { sender_name: OWNER, timestamp_ms: T0 - 30 * DAY + 2 * MIN, content: 'yes! 9am' },
          { sender_name: OWNER, timestamp_ms: T0 - 30 * DAY + 3 * MIN, content: 'Liked a message' },
          { sender_name: ROBIN, timestamp_ms: T0 - 30 * DAY + 4 * MIN, photos: [{ uri: 'your_instagram_activity/messages/inbox/x/photos/1.jpg', creation_timestamp: 1 }] },
          { sender_name: ROBIN, timestamp_ms: T0 - 30 * DAY + 5 * MIN, share: { link: 'https://www.instagram.com/reel/AbCdEf/' } },
          { sender_name: ROBIN, timestamp_ms: T0 - 30 * DAY + 6 * MIN, is_unsent: true },
        ],
      }),
    ),
    [`${ACT}/${GROUP_FOLDER}/message_1.json`]: dyiJson(
      threadJson({
        participants: [ROBIN, SKY, JORDAN, OWNER],
        title: 'Climbing crew 🧗',
        folder: GROUP_FOLDER,
        messages: [
          { sender_name: SKY, timestamp_ms: T0 - 20 * DAY, content: 'gym at 7?' },
          { sender_name: SKY, timestamp_ms: T0 - 20 * DAY + MIN, content: 'bringing the rope' },
          { sender_name: ROBIN, timestamp_ms: T0 - 20 * DAY + 2 * MIN, content: 'in', reactions: [{ reaction: '👍', actor: SKY }] },
        ],
      }),
    ),
    [`${ROOT}/connections/followers_and_following/followers_1.json`]: dyiJson(
      followersJson([
        { username: 'robin.example', at: T0 - 400 * DAY },
        { username: 'sky.sample', at: T0 - 100 * DAY },
      ]),
    ),
    [`${ROOT}/connections/followers_and_following/following.json`]: dyiJson(
      followingJson([
        { username: 'robin.example', at: T0 - 399 * DAY },
        { username: 'other.person', at: T0 - 10 * DAY },
      ]),
    ),
    // Media are never opened.
    [`${ACT}/${DM_FOLDER}/photos/1.jpg`]: Buffer.from([0xff, 0xd8, 0xff]),
  };
  if (o.personal ?? true) {
    files[`${ROOT}/personal_information/personal_information/personal_information.json`] = dyiJson(personalJson(OWNER, 'owner.sample'));
  }
  return files;
}

const listing = (root: string) =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = path.join(e.parentPath, e.name);
      return `${path.relative(root, p)}:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`;
    })
    .sort();

describe('DYI text and shapes', () => {
  it('undoes Instagram mojibake and leaves proper text alone', () => {
    expect(fixMojibake(mojibake('café ❤️ 🧗 Sámple'))).toBe('café ❤️ 🧗 Sámple');
    expect(fixMojibake('plain ascii')).toBe('plain ascii');
    expect(fixMojibake('already ❤️ fine')).toBe('already ❤️ fine');
    expect(fixMojibake('café')).toBe('café'); // a lone latin1 byte is not UTF-8: kept
    expect(parseDyiJson(dyiJson({ k: ['Sky Sámple', { n: '👍' }] }))).toEqual({ k: ['Sky Sámple', { n: '👍' }] });
  });

  it('classifies export paths (both export layouts)', () => {
    expect(dyiEntryType(`messages/inbox/${DM_FOLDER}/message_1.json`)).toEqual({ type: 'thread', box: 'inbox', folder: DM_FOLDER });
    expect(dyiEntryType(`x/your_instagram_activity/messages/message_requests/a_123456/message_2.json`)?.type).toBe('thread');
    expect(dyiEntryType('connections/followers_and_following/followers_3.json')?.type).toBe('followers');
    expect(dyiEntryType('followers_and_following/following.json')?.type).toBe('following');
    expect(dyiEntryType('personal_information/personal_information/personal_information.json')?.type).toBe('personal');
    expect(dyiEntryType('messages/inbox/x/photos/1.jpg')).toBeNull();
    expect(dyiEntryType('ads_information/ads.json')).toBeNull();
  });

  it('thread keys use the numeric thread id', () => {
    expect(threadKeyOf(DM_FOLDER)).toBe('t1234567890');
    expect(threadKeyOf('weird')).toBe('f:weird');
    expect(threadKeyOf('weird', 'inbox/other_55555555')).toBe('t55555555');
  });

  it('maps message kinds', () => {
    const at = { timestamp_ms: T0 };
    expect(mapDyiMessage({ ...at, content: 'hi' })).toMatchObject({ kind: 'text', text: 'hi' });
    expect(mapDyiMessage({ ...at, content: 'Liked a message' }).kind).toBe('system');
    expect(mapDyiMessage({ ...at, content: 'Reacted 😂 to your message' }).kind).toBe('system');
    expect(mapDyiMessage({ ...at, content: 'Robin Example sent an attachment.' })).toMatchObject({ kind: 'attachment', text: null });
    expect(mapDyiMessage({ ...at, share: { link: 'https://www.instagram.com/p/x/' } })).toMatchObject({ kind: 'link', text: 'https://www.instagram.com/p/x/' });
    expect(mapDyiMessage({ ...at, photos: [{ uri: 'a' }, { uri: 'b' }] })).toEqual({ kind: 'attachment', text: null, attachments: [{ type: 'img' }, { type: 'img' }], retracted: false });
    expect(mapDyiMessage({ ...at, is_unsent: true })).toMatchObject({ kind: 'system', retracted: true });
    expect(mapDyiMessage({ ...at, call_duration: 30, content: 'x' }).kind).toBe('system');
  });

  it('reads followers/following in both layouts, and my profile', () => {
    expect(relationshipEntries(parseDyiJson(dyiJson(followersJson([{ username: 'Robin.Example', at: T0 }]))))).toEqual([{ username: 'robin.example', at: T0 }]);
    expect(relationshipEntries(parseDyiJson(dyiJson(followingJson([{ username: 'sky.sample', at: T0 }]))))).toEqual([{ username: 'sky.sample', at: T0 }]);
    expect(personalInfo(parseDyiJson(dyiJson(personalJson(OWNER, 'owner.sample'))))).toEqual({ name: OWNER, username: 'owner.sample' });
  });
});

describe('DYI import', () => {
  it('imports an extracted export: own conversations, weak identities, me, reactions, follows', async () => {
    const db = memDb();
    const imports = dir();
    writeFolder(imports, exportFiles());
    const before = listing(imports);
    const s = await importInstagramDyi(db, { importsDir: imports, now: T0 });
    expect(s).toMatchObject({ files_imported: 5, files_failed: 0, threads: 2, threads_matched: 0, threads_new_conversations: 2 });
    // The owner's files are untouched.
    expect(listing(imports)).toEqual(before);

    expect(db.prepare('SELECT source, source_conv_id, kind, title, member_count FROM conversations ORDER BY kind').all()).toEqual([
      { source: 'instagram_dyi', source_conv_id: 't1234567890', kind: 'direct', title: null, member_count: 2 },
      { source: 'instagram_dyi', source_conv_id: 't9876543210', kind: 'group', title: 'Climbing crew 🧗', member_count: 4 },
    ]);
    const msgs = db.prepare(`SELECT is_from_me, kind, text, retracted_at IS NOT NULL AS gone FROM messages WHERE source = 'instagram_dyi' ORDER BY sent_at`).all();
    expect(msgs).toEqual([
      { is_from_me: 0, kind: 'text', text: 'café tomorrow? ☕', gone: 0 },
      { is_from_me: 1, kind: 'text', text: 'yes! 9am', gone: 0 },
      { is_from_me: 1, kind: 'system', text: 'Liked a message', gone: 0 },
      { is_from_me: 0, kind: 'attachment', text: null, gone: 0 },
      { is_from_me: 0, kind: 'link', text: 'https://www.instagram.com/reel/AbCdEf/', gone: 0 },
      { is_from_me: 0, kind: 'system', text: null, gone: 1 },
      { is_from_me: 0, kind: 'text', text: 'gym at 7?', gone: 0 },
      { is_from_me: 0, kind: 'text', text: 'bringing the rope', gone: 0 },
      { is_from_me: 0, kind: 'text', text: 'in', gone: 0 },
    ]);
    // Attachment rows carry types only (no media paths).
    expect(db.prepare(`SELECT attachments FROM messages WHERE kind = 'attachment'`).pluck().get()).toBe('[{"type":"img"}]');
    expect(db.prepare('SELECT is_from_me, emoji FROM message_reactions ORDER BY at').all()).toEqual([
      { is_from_me: 1, emoji: '❤️' },
      { is_from_me: 0, emoji: '👍' },
    ]);

    // Display names are observations on weak, per-thread identities; never keys across threads.
    const weak = db.prepare(`SELECT key, confidence FROM identities WHERE kind = 'instagram_name' ORDER BY key`).all();
    expect(weak).toEqual([
      { key: 'ig_dyi:t1234567890:Robin Example', confidence: 0.5 },
      { key: 'ig_dyi:t9876543210:Jordan Placeholder', confidence: 0.5 },
      { key: 'ig_dyi:t9876543210:Robin Example', confidence: 0.5 },
      { key: 'ig_dyi:t9876543210:Sky Sámple', confidence: 0.5 },
    ]);
    const statusOf = (key: string) =>
      db.prepare(`SELECT p.status, p.display_name FROM identities i JOIN people p ON p.id = i.person_id WHERE i.key = ?`).get(key);
    expect(statusOf('ig_dyi:t1234567890:Robin Example')).toEqual({ status: 'provisional', display_name: 'Robin Example' }); // I wrote to them
    expect(statusOf('ig_dyi:t9876543210:Sky Sámple')).toEqual({ status: 'provisional', display_name: 'Sky Sámple' }); // posted twice
    expect((statusOf('ig_dyi:t9876543210:Jordan Placeholder') as { status: string }).status).toBe('roster_only'); // never posted
    expect(count(db, 'alias_obs', `source = 'ig_dyi'`)).toBe(4);
    // My own name is never a person; my username from the profile is mine.
    expect(count(db, 'identities', `key LIKE '%Owner Sample%'`)).toBe(0);
    const me = db.prepare(`SELECT id FROM people WHERE kind = 'me'`).pluck().get();
    expect(db.prepare(`SELECT person_id FROM identities WHERE kind = 'instagram_username' AND key = 'owner.sample'`).pluck().get()).toBe(me);

    // Followers / following: username identities with dates, nothing on 'me'.
    expect(
      db
        .prepare(`SELECT i.key, f.direction, f.followed_at FROM instagram_follows f JOIN identities i ON i.id = f.identity_id ORDER BY i.key, f.direction`)
        .all(),
    ).toEqual([
      { key: 'other.person', direction: 'following', followed_at: T0 - 10 * DAY },
      { key: 'robin.example', direction: 'follower', followed_at: T0 - 400 * DAY },
      { key: 'robin.example', direction: 'following', followed_at: T0 - 399 * DAY },
      { key: 'sky.sample', direction: 'follower', followed_at: T0 - 100 * DAY },
    ]);
    expect(db.prepare(`SELECT DISTINCT p.status FROM identities i JOIN people p ON p.id = i.person_id WHERE i.kind = 'instagram_username' AND p.kind = 'person'`).pluck().all()).toEqual(['roster_only']);
    expect(db.prepare(`SELECT status, details FROM source_health WHERE source = 'instagram_dyi'`).get()).toMatchObject({ status: 'ok' });
    expect(count(db, 'import_files', `status = 'imported'`)).toBe(5);
  });

  it('re-imports are no-ops: same files, a touched file, a renamed zip, or the zip next to its folder', async () => {
    const db = memDb();
    const imports = dir();
    writeFolder(imports, exportFiles());
    await importInstagramDyi(db, { importsDir: imports, now: T0 });
    const snapshot = () => ({
      messages: count(db, 'messages'),
      reactions: count(db, 'message_reactions'),
      people: count(db, 'people'),
      batches: count(db, 'change_batches'),
      follows: count(db, 'instagram_follows'),
    });
    const after1 = snapshot();
    const again = await importInstagramDyi(db, { importsDir: imports, now: T0 + MIN });
    expect(again).toMatchObject({ files_known: 5, files_imported: 0 });
    // Touching a file changes its mtime but not its hash: recognised, not re-imported.
    const f = path.join(imports, `${ACT}/${DM_FOLDER}/message_1.json`);
    fs.utimesSync(f, new Date(T0 + DAY), new Date(T0 + DAY));
    expect(await importInstagramDyi(db, { importsDir: imports, now: T0 + 2 * MIN })).toMatchObject({ files_known: 5, files_imported: 0 });
    // The same export as a zip: new file, same messages.
    fs.writeFileSync(path.join(imports, 'instagram-export.zip'), zipBuffer(exportFiles()));
    const zip = await importInstagramDyi(db, { importsDir: imports, now: T0 + 3 * MIN });
    expect(zip).toMatchObject({ files_imported: 1, threads: 2 });
    expect(snapshot()).toEqual(after1);
    fs.renameSync(path.join(imports, 'instagram-export.zip'), path.join(imports, 'renamed.zip'));
    expect(await importInstagramDyi(db, { importsDir: imports, now: T0 + 4 * MIN })).toMatchObject({ files_known: 6, files_imported: 0 });
    expect(snapshot()).toEqual(after1);
  });

  it('imports a zip export the same way as the folder', async () => {
    const a = memDb();
    const b = memDb();
    const folder = dir();
    writeFolder(folder, exportFiles());
    const zipped = dir();
    fs.writeFileSync(path.join(zipped, 'instagram-owner.zip'), zipBuffer(exportFiles()));
    await importInstagramDyi(a, { importsDir: folder, now: T0 });
    const s = await importInstagramDyi(b, { importsDir: zipped, now: T0 });
    expect(s).toMatchObject({ files_imported: 1, threads: 2, follows: 4 });
    const shape = (db: DB) => db.prepare(`SELECT source_msg_id, is_from_me, kind, text FROM messages ORDER BY source_msg_id`).all();
    expect(shape(b)).toEqual(shape(a));
  });

  it('keeps the earliest follow time across exports (a re-follow or a later export never moves it later)', async () => {
    const db = memDb();
    const followed = () =>
      db
        .prepare(`SELECT i.key, f.direction, f.followed_at FROM instagram_follows f JOIN identities i ON i.id = f.identity_id ORDER BY i.key, f.direction`)
        .all();
    const first = dir();
    writeFolder(first, {
      [`${ROOT}/connections/followers_and_following/following.json`]: dyiJson(
        followingJson([
          { username: 'robin.example', at: T0 - 300 * DAY },
          { username: 'sky.sample', at: T0 - 50 * DAY },
          // The same username twice in one file: the earlier time wins.
          { username: 'sky.sample', at: T0 - 60 * DAY },
        ]),
      ),
    });
    expect(await importInstagramDyi(db, { importsDir: first, now: T0 })).toMatchObject({ files_imported: 1 });
    expect(followed()).toEqual([
      { key: 'robin.example', direction: 'following', followed_at: T0 - 300 * DAY },
      { key: 'sky.sample', direction: 'following', followed_at: T0 - 60 * DAY },
    ]);
    // A later export: Robin was unfollowed and re-followed (later date: ignored), Sky's follow is older than we knew.
    const second = dir();
    writeFolder(second, {
      [`${ROOT}/connections/followers_and_following/following.json`]: dyiJson(
        followingJson([
          { username: 'robin.example', at: T0 - 10 * DAY },
          { username: 'sky.sample', at: T0 - 90 * DAY },
        ]),
      ),
    });
    expect(await importInstagramDyi(db, { importsDir: second, now: T0 + DAY })).toMatchObject({ files_imported: 1 });
    expect(followed()).toEqual([
      { key: 'robin.example', direction: 'following', followed_at: T0 - 300 * DAY },
      { key: 'sky.sample', direction: 'following', followed_at: T0 - 90 * DAY },
    ]);
    // last_seen_at still moves forward for both.
    expect(db.prepare('SELECT DISTINCT last_seen_at FROM instagram_follows').pluck().all()).toEqual([T0 + DAY]);
  });

  it('maps a thread onto its Beeper conversation: duplicates skipped, older history added, senders inherit identities', async () => {
    const db = memDb();
    // Beeper already has the recent part of the DM with Robin.
    const ctx = sourceRun(db, 'instagram', { now: T0 }).ctx;
    const me = ensureMe(ctx, []).personId;
    const robinIg = attachExternalIdentity(ctx, { kind: 'instagram_id', key: '9000000002', displayName: ROBIN })!;
    const w = episodeWriter(db, { now: T0 });
    const conv = w.upsertConversation({ source: 'instagram', sourceConvId: '!dm-robin:beeper.local', kind: 'direct' }).id;
    w.upsertMember(conv, robinIg, { source: 'roster', at: T0 });
    const beeper = [
      { from: 'robin', at: T0 - 2 * DAY, text: 'Are you around Saturday?' },
      { from: 'me', at: T0 - 2 * DAY + MIN, text: 'yes! climbing?' },
      { from: 'robin', at: T0 - 2 * DAY + 2 * MIN, text: 'yes 7pm' },
      { from: 'me', at: T0 - 2 * DAY + 3 * MIN, text: 'see you there' },
      { from: 'robin', at: T0 - 2 * DAY + 4 * MIN, text: null, kind: 'attachment' as const },
    ];
    beeper.forEach((m, i) =>
      w.upsertMessage({
        source: 'instagram',
        sourceMsgId: `b${i}`,
        conversationId: conv,
        senderIdentityId: m.from === 'me' ? null : robinIg,
        isFromMe: m.from === 'me',
        sentAt: m.at,
        kind: m.kind ?? 'text',
        text: m.text,
      }),
    );
    w.refresh();

    // The export has those (timestamps off by up to a second) plus older history; no personal_information file.
    const imports = dir();
    const offset = 900;
    writeFolder(imports, {
      [`${ACT}/${DM_FOLDER}/message_1.json`]: dyiJson(
        threadJson({
          participants: [ROBIN, OWNER],
          folder: DM_FOLDER,
          messages: [
            { sender_name: ROBIN, timestamp_ms: T0 - 90 * DAY, content: 'long time no see' },
            { sender_name: OWNER, timestamp_ms: T0 - 90 * DAY + MIN, content: 'too long!' },
            { sender_name: ROBIN, timestamp_ms: T0 - 2 * DAY + offset, content: 'are you around saturday?' },
            { sender_name: OWNER, timestamp_ms: T0 - 2 * DAY + MIN - offset, content: 'yes!  climbing?' },
            { sender_name: ROBIN, timestamp_ms: T0 - 2 * DAY + 2 * MIN + offset, content: 'yes 7pm' },
            { sender_name: OWNER, timestamp_ms: T0 - 2 * DAY + 3 * MIN, content: 'see you there' },
            { sender_name: ROBIN, timestamp_ms: T0 - 2 * DAY + 4 * MIN + offset, photos: [{ uri: 'p.jpg', creation_timestamp: 1 }] },
          ],
        }),
      ),
    });
    const s = await importInstagramDyi(db, { importsDir: imports, now: T0 });
    expect(s).toMatchObject({ threads: 1, threads_matched: 1, threads_new_conversations: 0, duplicates_skipped: 5, dyi_messages: 2 });
    expect(db.prepare('SELECT matched, votes, conversation_id FROM ig_dyi_threads').get()).toEqual({ matched: 1, votes: 4, conversation_id: conv });
    // The older history lands in the Beeper conversation, attributed to Robin's Beeper identity and to me.
    expect(
      db.prepare(`SELECT conversation_id, sender_identity_id, is_from_me, text FROM messages WHERE source = 'instagram_dyi' ORDER BY sent_at`).all(),
    ).toEqual([
      { conversation_id: conv, sender_identity_id: robinIg, is_from_me: 0, text: 'long time no see' },
      { conversation_id: conv, sender_identity_id: null, is_from_me: 1, text: 'too long!' },
    ]);
    // No weak identities were needed; the DYI display name is an alias on Robin's identity; my name was learned.
    expect(count(db, 'identities', `kind = 'instagram_name'`)).toBe(0);
    expect(db.prepare(`SELECT source FROM alias_obs WHERE identity_id = ? ORDER BY source`).pluck().all(robinIg)).toEqual(['beeper', 'ig_dyi']);
    expect(canonicalId(db, me)).toBe(me);
    expect(db.prepare(`SELECT first_message_at FROM conversations WHERE id = ?`).pluck().get(conv)).toBe(T0 - 90 * DAY);
    expect(count(db, 'sessions', 'conversation_id = ?', conv)).toBe(2);
  });

  it('HTML exports are ignored with a clear message; broken JSON fails and is retried a bounded number of times', async () => {
    const db = memDb();
    const imports = dir();
    fs.writeFileSync(path.join(imports, 'html-export.zip'), zipBuffer({ [`messages/inbox/${DM_FOLDER}/message_1.html`]: '<html></html>' }));
    const s = await importInstagramDyi(db, { importsDir: imports, now: T0 });
    expect(s).toMatchObject({ files_ignored: 1, html_exports: 1 });
    expect(db.prepare(`SELECT status, last_error FROM source_health WHERE source = 'instagram_dyi'`).get()).toEqual({
      status: 'error',
      last_error: expect.stringMatching(/HTML format.*JSON/),
    });

    writeFolder(imports, { [`messages/inbox/${DM_FOLDER}/message_1.json`]: '{ not json' });
    // (Two threads and no profile: guessing my name reads both, and must survive the broken one.)
    writeFolder(imports, { [`messages/inbox/${GROUP_FOLDER}/message_1.json`]: dyiJson(threadJson({ participants: [SKY, OWNER], folder: GROUP_FOLDER, messages: [{ sender_name: SKY, timestamp_ms: T0, content: 'hey' }] })) });
    for (let i = 0; i < 3; i++) expect((await importInstagramDyi(db, { importsDir: imports, now: T0 + i })).files_failed).toBe(1);
    expect(await importInstagramDyi(db, { importsDir: imports, now: T0 + 9 })).toMatchObject({ files_failed: 0, files_known: 3 });
    expect(count(db, 'messages')).toBe(1);
    expect(db.prepare(`SELECT status, attempts, error FROM import_files WHERE path LIKE '%.json'`).get()).toEqual({ status: 'failed', attempts: 3, error: 'invalid_json' });
  });

  it('instagram-dyi job: hourly, skipped when there is nothing new', async () => {
    const db = memDb();
    const imports = dir();
    const missing = path.join(imports, 'not-there');
    const [job] = instagramDyiJobs({ importsDir: missing });
    expect(job!.schedule).toEqual({ kind: 'interval', everyMs: 60 * MIN });
    const s = new Scheduler({ db, jobs: [job!], clock: { now: () => T0 } });
    expect((await s.runNow('instagram-dyi')).status).toBe('skipped');
    expect(fs.existsSync(missing)).toBe(false); // never created

    writeFolder(imports, exportFiles());
    const [real] = instagramDyiJobs({ importsDir: imports });
    const s2 = new Scheduler({ db, jobs: [real!], clock: { now: () => T0 } });
    expect((await s2.runNow('instagram-dyi')).status).toBe('ok');
    expect((await s2.runNow('instagram-dyi')).status).toBe('skipped');
  });
});
