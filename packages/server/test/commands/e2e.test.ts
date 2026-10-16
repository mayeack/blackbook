/**
 * Ingest → commands → reply → ingest again, over the synthetic collector: the iMessage tail stages the owner's
 * self-thread rows, the executor acts and texts back (fake sender, to self only), and the bot's own reply coming
 * back through chat.db is recognized (GUID, marker) and never staged as a command. Synthetic data only.
 */
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { ingestTail } from '../../src/adapters/imessage/ingest';
import { outboundTextHash } from '../../src/adapters/imessage/mapping';
import { processCommands } from '../../src/commands/executor';
import { createOutboundSender } from '../../src/delivery/outbound';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { memDb, seedPerson } from '../helpers';
import { BASE, FakeCollector, ME_EMAIL, ME_PHONE, MIN, newGuid, selfChat, T0 } from '../adapters/imessage/fakeCollector';

vi.mock('../../src/pipeline/suggestions/feedback', () => ({
  applySuggestionFeedback: vi.fn(async (db: ReturnType<typeof memDb>, id: string, f: { action: string }) => {
    if (f.action === 'done') db.prepare(`UPDATE suggestions SET status = 'done' WHERE id = ?`).run(id);
    return { suggestionId: id, status: f.action === 'done' ? 'done' : 'delivered', batchId: null, why: null, openers: null };
  }),
  whyThis: vi.fn(),
}));

const fakes: FakeCollector[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

describe('two-way texting end to end', () => {
  it('stages, acts on and answers "done 1"; the reply row that comes back is the bot\'s own', async () => {
    const f = new FakeCollector().writeToken();
    fakes.push(f);
    const db = memDb();
    const put = (k: string, v: unknown) =>
      db.prepare('INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)').run(k, JSON.stringify(v), T0, T0);
    put('self_handles', [ME_PHONE, ME_EMAIL]);
    put('tz', 'America/Chicago');
    const client = f.client();
    let now = T0;
    await ingestTail(db, client, { now }); // first pass: the cursor (and the command floor) start here

    // This morning's brief: one item about an invented person, sent through the ledger.
    const person = seedPerson(db, { first_name: 'Rowan', last_name: 'Ellis', display_name: 'Rowan Ellis' });
    const digestId = uuidv7(T0);
    const suggestionId = uuidv7(T0);
    db.prepare(`INSERT INTO digests (id, local_date, status, sent_at) VALUES (?, '2026-10-14', 'sent', ?)`).run(digestId, T0 + MIN);
    db.prepare(
      `INSERT INTO suggestions (id, kind, person_id, dedupe_key, score, signals, status, created_at, updated_at)
       VALUES (?, 'fading', ?, 'fading:x', 0.6, '{}', 'delivered', ?, ?)`,
    ).run(suggestionId, person, T0, T0);
    db.prepare('INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, 1, ?)').run(digestId, suggestionId);
    const briefText = `${BOT_MARKER} Wed Oct 14 · 1 for today\n\n1 Rowan E. · quiet a while`;
    const briefGuid = newGuid();
    db.prepare(
      `INSERT INTO outbound_messages (id, client_ref, purpose, to_handle, text_hash, status, message_guids, digest_id, created_at, sent_at)
       VALUES ('ob-1', ?, 'digest', ?, ?, 'delivered', ?, ?, ?, ?)`,
    ).run(uuidv7(T0), ME_PHONE, outboundTextHash(briefText), JSON.stringify([briefGuid]), digestId, T0 + MIN, T0 + MIN);
    db.prepare(`INSERT INTO outbound_guids (guid, outbound_id) VALUES (?, 'ob-1')`).run(briefGuid);

    const s = selfChat();
    f.add(s, { from: 'me', at: T0 + MIN, guid: briefGuid, text: briefText });
    f.add(s, { from: 'me', at: T0 + 3 * MIN, text: 'done 1', threadOriginator: `p:0/${briefGuid}` });
    f.add(s, { from: 'me', at: T0 + 4 * MIN, text: 'grocery list: eggs, rice' });
    now = T0 + 5 * MIN;
    await ingestTail(db, client, { now });
    expect(db.prepare(`SELECT raw_text FROM inbound_commands ORDER BY created_at`).pluck().all()).toEqual(['done 1', 'grocery list: eggs, rice']);

    const outbound = new FakeOutboundSender({ db, now: () => now, selfHandle: ME_PHONE });
    const services = () => ({ llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress(), outbound, push: new FakePushSender() });
    now = T0 + 6 * MIN;
    const stats = await processCommands(db, { services, now: () => now });
    expect(stats).toMatchObject({ handled: 1, replies: 1 });
    expect(db.prepare('SELECT status FROM suggestions WHERE id = ?').pluck().get(suggestionId)).toBe('done');
    expect(outbound.sent.map((x) => x.text)).toEqual([`${BOT_MARKER} ✓ 1 done (Rowan E.) · undo to revert`]);
    // The grocery list is a note to self: within 12 h of the brief, but without the AI key it stays private.
    expect(db.prepare(`SELECT status, response_outbound_id FROM inbound_commands WHERE raw_text LIKE 'grocery%'`).get()).toEqual({
      status: 'ignored',
      response_outbound_id: null,
    });
    const ob = db.prepare(`SELECT to_handle, purpose, text_hash FROM outbound_messages WHERE purpose = 'reply'`).get();
    expect(ob).toEqual({ to_handle: ME_PHONE, purpose: 'reply', text_hash: outboundTextHash(outbound.sent[0]!.text) });

    // The ack lands in chat.db (with the GUID the sender recorded) plus an iPhone-shaped copy: both are bot rows.
    f.add(s, { from: 'me', at: now + 2000, guid: 'FAKE-GUID-1', text: outbound.sent[0]!.text });
    f.add(s, { from: ME_PHONE, at: now + 2500, text: outbound.sent[0]!.text });
    now += 10_000;
    await ingestTail(db, client, { now });
    expect(db.prepare('SELECT count(*) FROM inbound_commands').pluck().get()).toBe(2);
    expect(db.prepare(`SELECT count(*) FROM messages WHERE is_bot = 1`).pluck().get()).toBe(3);
    const again = await processCommands(db, { services, now: () => now });
    expect(again.pending).toBe(0);
    expect(outbound.sent).toHaveLength(1);
  });
});

describe('two-way texting through the real outbound sender', () => {
  it('the reply is POSTed to the collector for the self handle only, recorded with its text hash and GUID', async () => {
    const f = new FakeCollector().writeToken();
    fakes.push(f);
    const db = memDb();
    const put = (k: string, v: unknown) =>
      db.prepare('INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)').run(k, JSON.stringify(v), T0, T0);
    put('self_handles', [ME_PHONE, ME_EMAIL]);
    put('tz', 'America/Chicago');
    const conv = uuidv7(T0);
    db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'imessage', 'self', 'self', ?, ?)`).run(conv, T0, T0);
    const mid = Number(
      db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
           VALUES ('imessage', 'G-1', ?, 1, ?, 'text', '? who do I know in Austin', ?, ?)`,
        )
        .run(conv, T0, T0, T0).lastInsertRowid,
    );
    db.prepare(`INSERT INTO inbound_commands (id, message_id, raw_text, status, created_at) VALUES (?, ?, '? who do I know in Austin', 'pending', ?)`).run(uuidv7(T0), mid, T0);

    const agent = new MockAgent();
    agent.disableNetConnect();
    const posted: { to: string; text: string; client_ref: string }[] = [];
    agent
      .get(BASE)
      .intercept({ path: '/v1/imessage/send', method: 'POST' })
      .reply((opts) => {
        posted.push(JSON.parse(String(opts.body)));
        return { statusCode: 200, data: { api: 'v1', status: 'delivered', message_guids: ['SENT-GUID-1'], rowids: [] } };
      })
      .persist();
    const outbound = createOutboundSender({ db, collector: { url: BASE, tokenFile: f.tokenFile }, dispatcher: agent, now: () => T0 + MIN });
    const services = () => ({ llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress(), outbound, push: new FakePushSender() });
    const stats = await processCommands(db, { services, now: () => T0 + MIN });
    await agent.close();

    expect(stats).toMatchObject({ handled: 1, replies: 1 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.to).toBe(ME_PHONE);
    expect(posted[0]!.text.startsWith(BOT_MARKER)).toBe(true);
    expect(db.prepare(`SELECT purpose, text_hash FROM outbound_messages`).get()).toEqual({ purpose: 'answer', text_hash: outboundTextHash(posted[0]!.text) });
    expect(db.prepare('SELECT guid FROM outbound_guids').pluck().all()).toEqual(['SENT-GUID-1']);
  });
});
