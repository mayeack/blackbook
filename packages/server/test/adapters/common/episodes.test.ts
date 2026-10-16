import { afterEach, describe, expect, it } from 'vitest';
import { episodeWriter, reactionKey, SESSIONIZED_SCOPE, type MessageInput } from '../../../src/adapters/common/episodes';
import { readCursor } from '../../../src/adapters/common/cursors';
import { ingestTail } from '../../../src/adapters/imessage/ingest';
import { memDb, seedIdentity, seedPerson, T0 } from '../../helpers';
import { ALEX, dm, FakeCollector, ME_PHONE, newGuid } from '../imessage/fakeCollector';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const count = (db: DB, table: string, where = '1') => db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get() as number;

/** A migrated db with me (one identity) and two synthetic people. */
function world() {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Me' });
  const meIdent = seedIdentity(db, me, 'instagram_id', '9000000001');
  const robin = seedPerson(db, { display_name: 'Robin Example', status: 'provisional' });
  const robinIg = seedIdentity(db, robin, 'instagram_id', '9000000002');
  const sky = seedPerson(db, { display_name: 'Sky Sample', status: 'provisional' });
  const skyIg = seedIdentity(db, sky, 'instagram_id', '9000000003');
  return { db, me, meIdent, robin, robinIg, sky, skyIg };
}

const msg = (conversationId: string, sourceMsgId: string, o: Partial<MessageInput> = {}): MessageInput => ({
  source: 'beeper',
  sourceMsgId,
  conversationId,
  senderIdentityId: null,
  isFromMe: false,
  sentAt: T0,
  kind: 'text',
  text: 'synthetic text',
  ...o,
});

describe('EpisodeWriter: conversations and members', () => {
  it('upserts conversations idempotently on (source, source_conv_id); the time range only widens', () => {
    const { db } = world();
    const w = episodeWriter(db, { now: T0 });
    const a = w.upsertConversation({ source: 'beeper', sourceConvId: 'chat-1', kind: 'direct', firstAt: T0, lastAt: T0 });
    const b = w.upsertConversation({ source: 'beeper', sourceConvId: 'chat-1', kind: 'direct', firstAt: T0, lastAt: T0 });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false, kind: 'direct' });
    expect(w.stats.conversations_updated).toBe(0);
    w.upsertConversation({ source: 'beeper', sourceConvId: 'chat-1', kind: 'direct', title: 'Climbing', firstAt: T0 + MIN, lastAt: T0 - MIN });
    expect(db.prepare('SELECT title, title_source, first_message_at, last_message_at FROM conversations').get()).toEqual({
      title: 'Climbing',
      title_source: 'chat',
      first_message_at: T0,
      last_message_at: T0,
    });
    // Same native id on another source is a different conversation.
    expect(w.upsertConversation({ source: 'whatsapp', sourceConvId: 'chat-1', kind: 'group' }).created).toBe(true);
    expect(count(db, 'conversations')).toBe(2);
  });

  it('members: a roster reactivates, an inactive roster row leaves, me never joins', () => {
    const { db, meIdent, robinIg, skyIg } = world();
    const w = episodeWriter(db, { now: T0 });
    const { id } = w.upsertConversation({ source: 'beeper', sourceConvId: 'g-1', kind: 'group' });
    expect(w.upsertMember(id, robinIg, { source: 'roster', at: T0 })).toBe(true);
    expect(w.upsertMember(id, robinIg, { source: 'roster', at: T0 })).toBe(false);
    expect(w.upsertMember(id, meIdent, { source: 'roster', at: T0 })).toBe(false);
    w.upsertMember(id, skyIg, { source: 'roster', at: T0, isActive: false });
    const rows = () => db.prepare('SELECT identity_id, is_active, left_at FROM conversation_members ORDER BY identity_id').all();
    expect(rows()).toEqual(
      [
        { identity_id: robinIg, is_active: 1, left_at: null },
        { identity_id: skyIg, is_active: 0, left_at: T0 },
      ].sort((x, y) => x.identity_id.localeCompare(y.identity_id)),
    );
    // A later roster lists Sky again; a full roster without Robin marks Robin as left.
    w.upsertMember(id, skyIg, { source: 'roster', at: T0 + MIN });
    expect(w.reconcileRoster(id, [skyIg], T0 + MIN)).toBe(1);
    expect(db.prepare('SELECT is_active FROM conversation_members WHERE identity_id = ?').pluck().get(skyIg)).toBe(1);
    expect(db.prepare('SELECT is_active, left_at FROM conversation_members WHERE identity_id = ?').get(robinIg)).toEqual({ is_active: 0, left_at: T0 + MIN });
    // A post after left_at brings Robin back.
    w.upsertMessage(msg(id, 'm-1', { senderIdentityId: robinIg, sentAt: T0 + 2 * MIN }));
    expect(db.prepare('SELECT is_active, left_at FROM conversation_members WHERE identity_id = ?').get(robinIg)).toEqual({ is_active: 1, left_at: null });
  });

  it('membership events apply to the roster and dedupe', () => {
    const { db, robinIg } = world();
    const w = episodeWriter(db, { now: T0 });
    const { id } = w.upsertConversation({ source: 'whatsapp', sourceConvId: 'g-2', kind: 'group' });
    expect(w.recordMembershipEvent({ conversationId: id, action: 'add', identityId: robinIg, at: T0 })).toBe(true);
    expect(w.recordMembershipEvent({ conversationId: id, action: 'add', identityId: robinIg, at: T0 })).toBe(false);
    w.recordMembershipEvent({ conversationId: id, action: 'leave', identityId: robinIg, at: T0 + MIN });
    w.recordMembershipEvent({ conversationId: id, action: 'rename', identityId: null, newTitle: 'Trail crew', at: T0 + 2 * MIN });
    expect(db.prepare('SELECT is_active, joined_at, left_at FROM conversation_members').get()).toEqual({ is_active: 0, joined_at: T0, left_at: T0 + MIN });
    expect(db.prepare('SELECT title, title_source FROM conversations WHERE id = ?').get(id)).toEqual({ title: 'Trail crew', title_source: 'group_event' });
    expect(count(db, 'membership_events')).toBe(3);
  });
});

describe('EpisodeWriter: messages', () => {
  it('is idempotent on (source, source_msg_id); re-reads never blank text; edits and retractions stick', () => {
    const { db, robinIg } = world();
    const w = episodeWriter(db, { now: T0 });
    const { id: conv } = w.upsertConversation({ source: 'beeper', sourceConvId: 'dm-1', kind: 'direct' });
    const first = w.upsertMessage(msg(conv, 'm-1', { senderIdentityId: robinIg, text: 'see you at the crag' }));
    const again = w.upsertMessage(msg(conv, 'm-1', { senderIdentityId: robinIg, text: 'see you at the crag' }));
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false, updated: false });
    expect(w.stats).toMatchObject({ messages_new: 1, messages_updated: 0 });
    const row = () =>
      db.prepare('SELECT text, text_source, edited_at, retracted_at, content_key, sender_identity_id FROM messages WHERE id = ?').get(first.id) as Record<
        string,
        unknown
      >;
    expect(row()).toMatchObject({ text: 'see you at the crag', text_source: 'text', sender_identity_id: robinIg });
    expect(row().content_key).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // A page that lacks the body keeps the stored text.
    w.upsertMessage(msg(conv, 'm-1', { senderIdentityId: robinIg, text: null }));
    expect(row().text).toBe('see you at the crag');
    w.upsertMessage(msg(conv, 'm-1', { senderIdentityId: robinIg, text: 'see you at the gym', editedAt: T0 + MIN }));
    expect(row()).toMatchObject({ text: 'see you at the gym', edited_at: T0 + MIN });
    w.upsertMessage(msg(conv, 'm-1', { senderIdentityId: robinIg, text: null, retractedAt: T0 + 2 * MIN }));
    expect(row()).toMatchObject({ text: null, retracted_at: T0 + 2 * MIN, edited_at: T0 + MIN });
    // FTS follows the edits.
    expect(count(db, 'messages_fts', "messages_fts MATCH 'gym'")).toBe(0);

    // Same native id on another source is another message.
    expect(w.upsertMessage(msg(conv, 'm-1', { source: 'whatsapp' })).created).toBe(true);
    expect(count(db, 'messages')).toBe(2);
  });

  it('links a quoted reply now, or once its target lands', () => {
    const { db, robinIg } = world();
    const w = episodeWriter(db, { now: T0 });
    const { id: conv } = w.upsertConversation({ source: 'beeper', sourceConvId: 'dm-2', kind: 'direct' });
    const reply = w.upsertMessage(msg(conv, 'r-1', { isFromMe: true, sentAt: T0 + MIN, replyToSourceId: 'q-1' }));
    expect(db.prepare('SELECT reply_to_msg_id, reply_to_source_id FROM messages WHERE id = ?').get(reply.id)).toEqual({
      reply_to_msg_id: null,
      reply_to_source_id: 'q-1',
    });
    const target = w.upsertMessage(msg(conv, 'q-1', { senderIdentityId: robinIg }));
    expect(w.linkPendingReplies('beeper')).toBe(1);
    expect(db.prepare('SELECT reply_to_msg_id FROM messages WHERE id = ?').pluck().get(reply.id)).toBe(target.id);
    const direct = w.upsertMessage(msg(conv, 'r-2', { isFromMe: true, sentAt: T0 + 2 * MIN, replyToSourceId: 'q-1' }));
    expect(db.prepare('SELECT reply_to_msg_id FROM messages WHERE id = ?').pluck().get(direct.id)).toBe(target.id);
    expect(w.linkPendingReplies('beeper')).toBe(0);
  });
});

describe('EpisodeWriter: reactions', () => {
  it('namespaces non-iMessage reaction ids', () => {
    expect(reactionKey('imessage', 'ABC')).toBe('ABC');
    expect(reactionKey('beeper', 'ABC')).toBe('beeper:ABC');
  });

  it('parks a reaction until its target arrives, per source (a same-id message of another source is not its target)', () => {
    const { db, robinIg, skyIg } = world();
    const w = episodeWriter(db, { now: T0 });
    const wa = w.upsertConversation({ source: 'whatsapp', sourceConvId: 'dm-wa', kind: 'direct' }).id;
    const bp = w.upsertConversation({ source: 'beeper', sourceConvId: 'dm-bp', kind: 'direct' }).id;
    w.upsertMessage(msg(wa, 'shared-id', { source: 'whatsapp', senderIdentityId: skyIg }));
    const reaction = {
      source: 'beeper',
      sourceReactionId: 'rx-1',
      targetSourceMsgId: 'shared-id',
      actorIdentityId: robinIg,
      isFromMe: false,
      type: 'emoji',
      emoji: '🔥',
      at: T0 + MIN,
    };
    expect(w.upsertReaction(reaction)).toBe('parked');
    expect(w.upsertReaction(reaction)).toBe('unchanged');
    // The same raw reaction id from WhatsApp is a different reaction.
    expect(w.upsertReaction({ ...reaction, source: 'whatsapp' })).toBe('stored');
    expect(db.prepare('SELECT source_reaction_id FROM message_reactions').pluck().all()).toEqual(['whatsapp:rx-1']);
    expect(db.prepare('SELECT source, source_reaction_id FROM pending_reactions').all()).toEqual([{ source: 'beeper', source_reaction_id: 'beeper:rx-1' }]);

    expect(w.resolvePendingReactions('whatsapp')).toBe(0);
    expect(w.resolvePendingReactions('beeper')).toBe(0);
    const target = w.upsertMessage(msg(bp, 'shared-id', { senderIdentityId: skyIg }));
    expect(w.resolvePendingReactions('beeper')).toBe(1);
    expect(count(db, 'pending_reactions')).toBe(0);
    expect(db.prepare(`SELECT message_id, emoji, removed FROM message_reactions WHERE source_reaction_id = 'beeper:rx-1'`).get()).toEqual({
      message_id: target.id,
      emoji: '🔥',
      removed: 0,
    });
    // Re-reading the reaction is a no-op once applied.
    expect(w.upsertReaction(reaction)).toBe('unchanged');
  });

  it('a parked removal applies after the add; removals stick across re-reads; a later re-add revives', () => {
    const { db, robinIg } = world();
    const w = episodeWriter(db, { now: T0 });
    const conv = w.upsertConversation({ source: 'beeper', sourceConvId: 'dm-3', kind: 'direct' }).id;
    const add = { source: 'beeper', sourceReactionId: 'rx-2', targetSourceMsgId: 'late', actorIdentityId: robinIg, isFromMe: false, type: 'like', at: T0 + MIN };
    w.upsertReaction(add);
    // A separate removal event (own id) parked behind the add.
    w.upsertReaction({ ...add, sourceReactionId: 'rx-2-off', removal: true, at: T0 + 2 * MIN });
    expect(count(db, 'pending_reactions')).toBe(2);
    w.upsertMessage(msg(conv, 'late', { isFromMe: true }));
    w.resolvePendingReactions('beeper');
    expect(db.prepare('SELECT removed, at FROM message_reactions').get()).toEqual({ removed: 1, at: T0 + 2 * MIN });
    expect(w.upsertReaction(add)).toBe('unchanged');
    expect(db.prepare('SELECT removed FROM message_reactions').pluck().get()).toBe(1);
    expect(w.upsertReaction({ ...add, type: 'love', at: T0 + 3 * MIN })).toBe('updated');
    expect(db.prepare('SELECT type, removed FROM message_reactions').get()).toEqual({ type: 'love', removed: 0 });
    // Removal by the reaction's own id.
    expect(w.upsertReaction({ ...add, removal: true, at: T0 + 4 * MIN })).toBe('removed');
    expect(w.upsertReaction({ ...add, removal: true, at: T0 + 4 * MIN })).toBe('unchanged');
    expect(count(db, 'message_reactions')).toBe(1);
  });

  it('expires parked reactions per source', () => {
    const { db } = world();
    const w = episodeWriter(db, { now: T0 });
    w.upsertReaction({ source: 'beeper', sourceReactionId: 'x', targetSourceMsgId: 'never', actorIdentityId: null, isFromMe: true, type: 'like', at: T0 });
    w.upsertReaction({ source: 'whatsapp', sourceReactionId: 'x', targetSourceMsgId: 'never', actorIdentityId: null, isFromMe: true, type: 'like', at: T0 });
    expect(w.expirePendingReactions('beeper', T0 + 1)).toBe(1);
    expect(db.prepare('SELECT source FROM pending_reactions').pluck().all()).toEqual(['whatsapp']);
  });
});

describe('EpisodeWriter: refresh', () => {
  it('sessionizes touched conversations into interactions, is idempotent, and catches up from the watermark', () => {
    const { db, robin, robinIg } = world();
    const w = episodeWriter(db, { now: T0 });
    const conv = w.upsertConversation({ source: 'beeper', sourceConvId: 'dm-4', kind: 'direct' }).id;
    w.upsertMember(conv, robinIg, { source: 'roster', at: T0 });
    w.upsertMessage(msg(conv, 'a', { senderIdentityId: robinIg, sentAt: T0 }));
    w.upsertMessage(msg(conv, 'b', { isFromMe: true, sentAt: T0 + MIN }));
    w.upsertMessage(msg(conv, 'c', { senderIdentityId: robinIg, sentAt: T0 + 5 * 60 * MIN }));
    const r = w.refresh();
    expect(r.sessionsChanged).toBe(2);
    expect(db.prepare('SELECT person_id, kind, channel, msgs_from_me, msgs_from_them FROM interactions ORDER BY started_at').all()).toEqual([
      { person_id: robin, kind: 'dm_session', channel: 'beeper', msgs_from_me: 1, msgs_from_them: 1 },
      { person_id: robin, kind: 'dm_session', channel: 'beeper', msgs_from_me: 0, msgs_from_them: 1 },
    ]);
    const maxId = db.prepare(`SELECT max(id) FROM messages WHERE source = 'beeper'`).pluck().get();
    expect(readCursor(db, 'beeper', SESSIONIZED_SCOPE)?.cursor).toBe(String(maxId));
    expect(w.refresh().sessionsChanged).toBe(0);

    // A pass that committed messages but died before refresh(): the next writer catches up from the watermark.
    const crashed = episodeWriter(db, { now: T0 });
    crashed.upsertMessage(msg(conv, 'd', { isFromMe: true, sentAt: T0 + 5 * 60 * MIN + MIN }));
    const next = episodeWriter(db, { now: T0 });
    expect(next.refresh({ sources: ['beeper'] }).sessionsChanged).toBe(1);
    expect(db.prepare('SELECT msgs_from_me FROM interactions ORDER BY started_at DESC LIMIT 1').pluck().get()).toBe(1);
  });
});

describe('iMessage ingest beside other sources', () => {
  const fakes: FakeCollector[] = [];
  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.close();
  });

  it("never applies (or expires) another source's parked reactions", async () => {
    const f = new FakeCollector().writeToken();
    fakes.push(f);
    const db = memDb();
    db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('self_handles', ?, ?, ?)`).run(JSON.stringify([ME_PHONE]), T0, T0);
    const guid = newGuid();
    episodeWriter(db, { now: T0 }).upsertReaction({
      source: 'beeper',
      sourceReactionId: 'rx',
      targetSourceMsgId: guid,
      actorIdentityId: null,
      isFromMe: true,
      type: 'like',
      at: T0,
    });
    f.add(dm(ALEX), { from: ALEX, at: T0, text: 'synthetic hello', guid });
    await ingestTail(db, f.client(), { now: T0 + 60 * MIN });
    expect(count(db, 'messages')).toBe(1);
    expect(count(db, 'message_reactions')).toBe(0);
    expect(db.prepare('SELECT source FROM pending_reactions').pluck().all()).toEqual(['beeper']);
  });
});
