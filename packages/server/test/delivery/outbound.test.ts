/**
 * The real collector-backed sender against an undici MockAgent (nothing leaves the process; the suite-wide egress
 * guard is on). The collector origin is a placeholder port, never the real 4321.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { outboundTextHash } from '../../src/adapters/imessage/mapping';
import { CollectorOutboundSender, createOutboundSender, primarySelfHandle } from '../../src/delivery/outbound';
import { BOT_MARKER, MAX_OUTBOUND_PER_HOUR } from '../../src/delivery/types';
import { tempDir } from '../helpers';
import { buildWorld, DAY_DATE, SELF_E164, setSettings, zoned, type World } from './world';

const ORIGIN = 'http://127.0.0.1:47999';
const REF = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

interface Seen {
  body: Record<string, unknown>;
  auth: string | undefined;
  rowStatusDuringCall: string | undefined;
}

let w: World;
let agent: MockAgent;
let tmp: { dir: string; cleanup: () => void };
let tokenFile: string;
let seen: Seen[];
let reply: (body: Record<string, unknown>) => { statusCode: number; data: unknown };
let now: number;

function sender(): CollectorOutboundSender {
  return new CollectorOutboundSender({ db: w.db, collector: { url: ORIGIN, tokenFile }, dispatcher: agent, now: () => now });
}

beforeEach(() => {
  w = buildWorld();
  now = zoned(DAY_DATE, '08:00');
  tmp = tempDir();
  tokenFile = path.join(tmp.dir, 'collector.token');
  fs.writeFileSync(tokenFile, 'synthetic-token-1\n');
  seen = [];
  reply = (b) => ({ statusCode: 200, data: { api: 'v1', status: 'delivered', message_guids: [`GUID-${b.client_ref}`], rowids: [1] } });
  agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(ORIGIN)
    .intercept({ path: '/v1/imessage/send', method: 'POST' })
    .reply((opts) => {
      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      const headers = opts.headers as Record<string, string>;
      seen.push({
        body,
        auth: headers.authorization,
        rowStatusDuringCall: w.db.prepare('SELECT status FROM outbound_messages WHERE client_ref = ?').pluck().get(body.client_ref) as string | undefined,
      });
      const r = reply(body);
      return { statusCode: r.statusCode, data: JSON.stringify(r.data), responseOptions: { headers: { 'content-type': 'application/json' } } };
    })
    .persist();
});

afterEach(async () => {
  await agent.close();
  tmp.cleanup();
});

describe('CollectorOutboundSender', () => {
  it('texts only the primary self handle (first phone, E.164), writing the row before the call and the GUIDs after', async () => {
    expect(primarySelfHandle(w.db)).toBe(SELF_E164);
    const text = `${BOT_MARKER} Wed Oct 14 · 2 for today\nyeackbot.com/today`;
    const r = await sender().sendToSelf(text, 'digest', REF(1), { digestId: 'd1' });
    expect(r).toMatchObject({ status: 'delivered', guids: [`GUID-${REF(1)}`] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toMatchObject({ to: SELF_E164, text, client_ref: REF(1) });
    expect(seen[0]!.auth).toBe('Bearer synthetic-token-1');
    expect(seen[0]!.rowStatusDuringCall).toBe('sending');
    const row = w.db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(r.outboundId) as Record<string, unknown>;
    expect(row).toMatchObject({ client_ref: REF(1), purpose: 'digest', to_handle: SELF_E164, text_hash: outboundTextHash(text), status: 'delivered', digest_id: 'd1', sent_at: now });
    expect(String(row.collector_result)).not.toContain('Oct 14');
    expect(w.db.prepare('SELECT outbound_id FROM outbound_guids WHERE guid = ?').pluck().get(`GUID-${REF(1)}`)).toBe(r.outboundId);
  });

  it('falls back to the email handle when no phone is set up, and is inert without either', async () => {
    setSettings(w.db, { self_handles: ['Owner@Example.com'] });
    await sender().sendToSelf(`${BOT_MARKER} hi`, 'test', REF(2));
    expect(seen[0]!.body.to).toBe('owner@example.com');
    setSettings(w.db, { self_handles: [] });
    const s = sender();
    expect(s.configured).toBe(false);
    expect(await s.sendToSelf(`${BOT_MARKER} hi`, 'test', REF(3))).toMatchObject({ status: 'disabled', reason: 'no_self_handle' });
    expect(seen).toHaveLength(1);
    expect(createOutboundSender({ db: w.db, collector: null }).configured).toBe(false);
  });

  it('refuses rule breaks before writing anything', async () => {
    const s = sender();
    expect(await s.sendToSelf('no marker', 'reply', REF(4))).toMatchObject({ status: 'blocked', reason: 'no_marker' });
    expect(await s.sendToSelf(` ${BOT_MARKER} leading space`, 'reply', REF(5))).toMatchObject({ status: 'blocked', reason: 'no_marker' });
    expect(await s.sendToSelf(`${BOT_MARKER} https://phish.example.net/x`, 'reply', REF(6))).toMatchObject({ status: 'blocked', reason: 'url_not_allowed' });
    expect(await s.sendToSelf(`${BOT_MARKER} call 202-555-0187`, 'reply', REF(7))).toMatchObject({ status: 'blocked', reason: 'contains_identifier' });
    await expect(s.sendToSelf(`${BOT_MARKER} hi`, 'reply', 'not-a-uuid')).rejects.toThrow(/UUID/);
    expect(seen).toHaveLength(0);
    expect(w.db.prepare('SELECT count(*) FROM outbound_messages').pluck().get()).toBe(0);
  });

  it('holds sends in quiet hours unless they answer the owner’s own command', async () => {
    now = zoned(DAY_DATE, '23:30');
    const s = sender();
    expect(await s.sendToSelf(`${BOT_MARKER} late`, 'digest', REF(8))).toMatchObject({ status: 'blocked', reason: 'quiet_hours' });
    expect(await s.sendToSelf(`${BOT_MARKER} ✓ done`, 'reply', REF(9), { bypassQuietHours: true })).toMatchObject({ status: 'delivered' });
    expect(seen).toHaveLength(1);
  });

  it('is idempotent per client_ref and trips the circuit breaker', async () => {
    const s = sender();
    const first = await s.sendToSelf(`${BOT_MARKER} once`, 'reply', REF(10));
    expect(await s.sendToSelf(`${BOT_MARKER} once`, 'reply', REF(10))).toMatchObject({ status: 'duplicate', outboundId: first.outboundId, guids: first.guids });
    for (let i = 1; i < MAX_OUTBOUND_PER_HOUR; i++) await s.sendToSelf(`${BOT_MARKER} n${i}`, 'reply', REF(100 + i));
    expect(await s.sendToSelf(`${BOT_MARKER} too many`, 'reply', REF(99))).toMatchObject({ status: 'blocked', reason: 'circuit_open' });
    expect(seen).toHaveLength(MAX_OUTBOUND_PER_HOUR);
  });

  it('retries a send the collector never answered with the same client_ref; a refusal is final', async () => {
    reply = () => ({ statusCode: 503, data: { error: { code: 'chatdb_unavailable', message: 'x' } } });
    const s = sender();
    const a = await s.sendToSelf(`${BOT_MARKER} retry me`, 'digest', REF(20));
    expect(a).toMatchObject({ status: 'failed', reason: 'collector_unavailable' });
    reply = (b) => ({ statusCode: 200, data: { status: 'sent', message_guids: [`G-${b.client_ref}`], rowids: [] } });
    const b = await s.sendToSelf(`${BOT_MARKER} retry me`, 'digest', REF(20));
    expect(b).toMatchObject({ status: 'sent', outboundId: a.outboundId });
    expect(seen.map((x) => x.body.client_ref)).toEqual([REF(20), REF(20)]);
    expect(w.db.prepare('SELECT count(*) FROM outbound_messages WHERE client_ref = ?').pluck().get(REF(20))).toBe(1);

    reply = () => ({ statusCode: 403, data: { error: { code: 'recipient_not_allowed', message: 'x' } } });
    const c = await s.sendToSelf(`${BOT_MARKER} not allowed`, 'digest', REF(21));
    expect(c).toMatchObject({ status: 'failed', reason: 'no_self_handle' });
    expect(await s.sendToSelf(`${BOT_MARKER} not allowed`, 'digest', REF(21))).toMatchObject({ status: 'duplicate' });
    expect(seen).toHaveLength(3);
  });

  it('re-reads the token once after a 401, and fails closed without a token file', async () => {
    let calls = 0;
    reply = (b) => (++calls === 1 ? { statusCode: 401, data: { error: { code: 'unauthorized', message: 'x' } } } : { statusCode: 200, data: { status: 'delivered', message_guids: [`G-${b.client_ref}`] } });
    const s = sender();
    await s.sendToSelf(`${BOT_MARKER} warm`, 'test', REF(30)); // caches token 1 (first call 401 → re-read → ok)
    expect(seen.map((x) => x.auth)).toEqual(['Bearer synthetic-token-1', 'Bearer synthetic-token-1']);
    fs.rmSync(tokenFile);
    const s2 = sender();
    expect(await s2.sendToSelf(`${BOT_MARKER} no token`, 'test', REF(31))).toMatchObject({ status: 'failed', reason: 'collector_unavailable' });
    expect(seen).toHaveLength(2);
  });
});
