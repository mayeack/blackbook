/**
 * The ticket parse (adapters/gmail/parse.ts + jobs.ts): one ticket_parse batch of pseudonymized packets (Haiku 5.5,
 * effort low, no fallbacks, the byte-stable system prompt), the per-item pre-check (egress → blocked, excluded
 * people → skipped, the rest still go out), budget pools, and the consumer through the real client over a fake
 * Anthropic API → ticket_events. No synthetic counterparty surname, underName or owner name reaches any packet.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gmailApi } from '../../../src/adapters/gmail/api';
import { ticketParseJobs } from '../../../src/adapters/gmail/jobs';
import { NOT_A_VENDOR, packetText, reclaimStaleQueued, submitTicketParses, TICKET_PURPOSE } from '../../../src/adapters/gmail/parse';
import { TICKET_SYSTEM, TICKET_VERSION, TicketEmail, type TicketEmail as TicketEmailT } from '../../../src/adapters/gmail/prompt';
import { GMAIL_SOURCE, LIST_SCOPE, syncGmail } from '../../../src/adapters/gmail/sync';
import { deleteGmailData } from '../../../src/adapters/gmail/ledger';
import { connectedClient, GMAIL_REFRESH_TOKEN_SECRET } from '../../../src/adapters/calendar/google';
import { deleteCursor, writeCursor } from '../../../src/adapters/common/cursors';
import type { DB } from '../../../src/db/connection';
import { tx } from '../../../src/db/tx';
import { batchConsumer, collectBatches } from '../../../src/llm/batches';
import { volatileMarkers } from '../../../src/llm/caching';
import { createLlmClient } from '../../../src/llm/client';
import { createEgress, findRawIdentifiers } from '../../../src/llm/egress';
import { insertRequest } from '../../../src/llm/ledger';
import { DEFAULT_MODEL, ROUTES } from '../../../src/llm/models';
import { customId, EgressBlocked, parseCustomId, type Egress, type LlmClient } from '../../../src/llm/types';
import type { JobContext } from '../../../src/scheduler/scheduler';
import type { AgentServices } from '../../../src/services';
import { setSecret } from '../../../src/security/secrets';
import { writeSettings } from '../../../src/settings/registry';
import { FakeLlmClient } from '../../fakes/llm';
import { memDb, seedIdentity, seedPerson } from '../../helpers';
import { FakeAnthropic, reply, type BatchItemReply } from '../../llm/fakeAnthropic';
import { addr, CLIENT, FakeGmail, FRIEND_FROM, orderHtml, OWNER_EMAIL, REFRESH_TOKEN, VENDOR_DOMAIN, VENDOR_FROM } from './fakeGmail';

const KEY = crypto.randomBytes(32);
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 16);
const LATER = NOW + 2 * HOUR;
const NY = 'America/New_York';
const DANA_EMAIL = addr('dana.reyes', 'example.com');
/** Names and secrets that must never reach a packet (owner, counterparty, forwarder, JSON-LD underName / tokens). */
const NEVER = ['Varga', 'Sam ', 'Sammy', 'Dana', 'Reyes', 'Rowan', 'Quill', DANA_EMAIL, OWNER_EMAIL, 'ZXQ7Y81', 'TKT-55-01', '12-34567', 'underName', 'ticketToken', 'reservationNumber', 'https://', '100 Main St'];

let db: DB;
let g: FakeGmail;
let egress: Egress;
let ids: { order: string; transfer: string; forward: string };

beforeEach(async () => {
  db = memDb();
  writeSettings(db, { tz: NY, 'gmail.extra_senders': [VENDOR_DOMAIN] }, { actor: 'user', now: NOW });
  const me = seedPerson(db, { kind: 'me', display_name: 'Sam Varga', first_name: 'Sam', last_name: 'Varga', nickname: 'Sammy', status: 'active' });
  seedIdentity(db, me, 'email', OWNER_EMAIL);
  g = new FakeGmail();
  setSecret(db, KEY, GMAIL_REFRESH_TOKEN_SECRET, REFRESH_TOKEN, NOW);
  ids = {
    order: g.add({ at: NOW - 9 * HOUR, from: VENDOR_FROM, subject: 'Sam, your order confirmation', html: orderHtml({ seats: 2 }) }),
    transfer: g.add({
      at: NOW - 10 * HOUR,
      from: VENDOR_FROM,
      subject: 'Your tickets are on their way to Dana Reyes',
      text: `Hi Sammy,\nYou sent 2 tickets to Dana Reyes (${DANA_EMAIL}) for Lumen Arcade, Sat, Nov 7.\nTicket holder: Dana Reyes\nDana has 7 days to accept. Questions? 212-555-0142\n${'Ticket details. '.repeat(15)}`,
    }),
    forward: g.add({
      at: NOW - 11 * HOUR,
      from: FRIEND_FROM,
      subject: 'Fwd: Your order confirmation',
      text: `Sam - you're in! Rowan\n---------- Forwarded message ---------\nFrom: Tickets Example <${addr('noreply', VENDOR_DOMAIN)}>\nTo: Rowan Quill <${addr('rowan.quill', 'example.com')}>\n\nHi Rowan,\nYour order is confirmed: 2 tickets to Halcy Drift, Sat, Nov 14. Order #: AB-1234. Purchaser: Rowan Quill\n${'Details. '.repeat(30)}`,
    }),
  };
  await syncGmail(db, gmailApi(connectedClient(db, KEY, CLIENT, g.fetch, 'gmail')!), { now: NOW });
  egress = createEgress(db);
});
afterEach(async () => {
  await g.close();
});

const submit = (llm: LlmClient, e: Egress = egress, now = NOW) => submitTicketParses(db, { llm, egress: e }, { now });
const batchCalls = (llm: FakeLlmClient) => llm.calls.filter((c) => c.method === 'batch');
const status = (id: string) => db.prepare('SELECT parse_status, clean_text IS NOT NULL AS has_text, custom_id, error_class FROM gmail_messages WHERE gmail_id = ?').get(id) as {
  parse_status: string;
  has_text: number;
  custom_id: string | null;
  error_class: string | null;
};

describe('submit', () => {
  it('one low-effort Haiku batch of pseudonymized packets: byte-stable system, ticket custom ids, no names or tokens', async () => {
    const llm = new FakeLlmClient();
    const lines: unknown[] = [];
    const log = { debug: () => {}, info: (e: string, f?: unknown) => void lines.push([e, f]), warn: (e: string, f?: unknown) => void lines.push([e, f]), error: (e: string, f?: unknown) => void lines.push([e, f]) };
    const r = await submitTicketParses(db, { llm, egress }, { now: NOW, log });
    expect(r).toMatchObject({ status: 'ok', stats: { pending: 3, rendered: 3, submitted: 3, blocked: 0, excluded: 0 } });
    // Logs: counts only.
    const logged = JSON.stringify(lines);
    expect(logged).toContain('gmail.ticket_parse_submitted');
    for (const never of [...NEVER, 'Lumen', 'order confirmation', ids.order]) expect(logged, never).not.toContain(never);
    const calls = batchCalls(llm);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c).toMatchObject({ kind: 'ticket', route: 'ticket_parse', model: DEFAULT_MODEL, effort: 'low', thinking: 'disabled', fallbacks: false, maxTokens: ROUTES.ticket_parse.maxTokens });
      expect(c.system).toBe(TICKET_SYSTEM);
      expect(parseCustomId(c.customId!)).toMatchObject({ kind: 'ticket', version: TICKET_VERSION, attempt: 0 });
      expect(c.subjectRef).toMatch(/^gmail:19f/);
      expect(findRawIdentifiers(c.userText)).toEqual([]);
      for (const never of NEVER) expect(c.userText, never).not.toContain(never);
      expect(c.userText).toMatch(/^### email\nFROM DOMAIN: .+\nSUBJECT: .*\nEMAIL DATE: 2026-10-21 \(Wednesday\) \d\d:\d\d\nOWNER TZ: America\/New_York\nSTRUCTURED DATA: .*\nTEXT:\n/);
    }
    expect(volatileMarkers(TICKET_SYSTEM)).toEqual([]);
    const order = calls.find((c) => c.subjectRef === `gmail:${ids.order}`)!;
    expect(order.userText).toContain('SUBJECT: <me>, your order confirmation');
    expect(order.userText).toContain(
      'STRUCTURED DATA: {"name":"Lumen Arcade: Night Signals Tour","startDate":"2026-11-07T20:00:00-05:00","venue":"The Copper Hall","city":"Springfield","performers":["Lumen Arcade","Halcy Drift"]}',
    );
    const transfer = calls.find((c) => c.subjectRef === `gmail:${ids.transfer}`)!;
    expect(transfer.userText).toContain('You sent 2 tickets to <person> (<person>)');
    expect(transfer.userText).toContain('Hi <me>,');
    expect(transfer.userText).toContain('Ticket holder: <person>');
    const fwd = calls.find((c) => c.subjectRef === `gmail:${ids.forward}`)!;
    // A friend's (possibly personal) domain never travels: only a vendor's does.
    expect(fwd.userText).toContain(`FROM DOMAIN: ${NOT_A_VENDOR}`);
    expect(order.userText).toContain(`FROM DOMAIN: ${VENDOR_DOMAIN}`);
    expect(fwd.userText).toContain('Purchaser: <person>');
    // Bookkeeping: queued with the custom id; nothing left pending.
    for (const id of Object.values(ids)) expect(status(id)).toMatchObject({ parse_status: 'queued', has_text: 1 });
    expect(db.prepare('SELECT DISTINCT prompt_version FROM gmail_messages WHERE parse_status = ?').pluck().all('queued')).toEqual([TICKET_VERSION]);
    expect((await submit(llm)).stats.pending).toBe(0);
  });

  it('per-item pre-check: an egress block or an excluded person drops that item only; the rest still go out', async () => {
    // Someone the owner excluded from the model, whose number appears in the transfer mail.
    const ex = seedPerson(db, { display_name: 'Ex Person', first_name: 'Ex', last_name: 'Person', status: 'active' });
    seedIdentity(db, ex, 'phone', '+12125550142');
    writeSettings(db, { 'llm.excluded_person_ids': [ex] }, { actor: 'user', now: NOW });
    // An egress that refuses the forwarded mail (as if a raw identifier survived).
    const real = createEgress(db);
    const strict: Egress = {
      ...real,
      tokenFor: (id) => real.tokenFor(id),
      resolveToken: (t) => real.resolveToken(t),
      detokenize: (t, m) => real.detokenize(t, m),
      scan: (t) => real.scan(t),
      pseudonymize: (p) => {
        if (p.sections.some((s) => s.text.includes('Halcy Drift, Sat, Nov 14'))) throw new EgressBlocked([{ kind: 'email', count: 1 }]);
        return real.pseudonymize(p);
      },
    };
    const llm = new FakeLlmClient();
    const r = await submit(llm, strict);
    expect(r.stats).toMatchObject({ rendered: 1, blocked: 1, excluded: 1, submitted: 1 });
    expect(batchCalls(llm).map((c) => c.subjectRef)).toEqual([`gmail:${ids.order}`]);
    expect(status(ids.forward)).toMatchObject({ parse_status: 'blocked', has_text: 0, error_class: 'egress_blocked' });
    expect(status(ids.transfer)).toMatchObject({ parse_status: 'skipped', has_text: 0, error_class: 'llm_excluded' });
  });

  it('without an API key or budget nothing is sent and nothing changes', async () => {
    expect(await submit(new FakeLlmClient({ configured: false }))).toMatchObject({ status: 'skipped', reason: 'no_key' });
    const broke = new FakeLlmClient({ budget: { steady: 0, backfill: 0 } });
    expect((await submit(broke)).status).toBe('skipped');
    expect(batchCalls(broke)).toHaveLength(0);
    // Steady exhausted but backfill open: steady items wait as pending.
    const half = new FakeLlmClient({ budget: { steady: 0, backfill: null } });
    expect(await submit(half)).toMatchObject({ status: 'partial', stats: { unavailable: 3, submitted: 0 } });
    for (const id of Object.values(ids)) expect(status(id)).toMatchObject({ parse_status: 'pending', has_text: 1, custom_id: null });
  });

  it('a submit that throws puts its rows back to pending and closes the run as an error', async () => {
    const llm = new FakeLlmClient();
    llm.submitBatch = async () => {
      throw new Error('synthetic failure');
    };
    await expect(submit(llm)).rejects.toThrow('synthetic failure');
    for (const id of Object.values(ids)) expect(status(id)).toMatchObject({ parse_status: 'pending', has_text: 1, custom_id: null });
    expect(db.prepare(`SELECT status FROM runs WHERE kind = 'ingest' ORDER BY started_at DESC LIMIT 1`).pluck().get()).toBe('error');
  });

  it('mail older than where a running backfill started pays from the backfill pool', async () => {
    writeCursor(db, GMAIL_SOURCE, LIST_SCOPE, 'v1', NOW, { meta: { backfillFrom: NOW - 10 * HOUR + 1, backfillBefore: NOW - 5 * 86_400_000 } });
    const llm = new FakeLlmClient();
    expect((await submit(llm)).stats.submitted).toBe(3);
    // FakeLlmClient keeps each submitted batch's items (one batch per pool).
    const items = [...(llm as unknown as { batches: Map<string, { subjectRef: string; pool: string }[]> }).batches.values()].flat();
    expect(Object.fromEntries(items.map((i) => [i.subjectRef.slice(6), i.pool]))).toEqual({ [ids.order]: 'steady', [ids.transfer]: 'backfill', [ids.forward]: 'backfill' });
  });

  it('a queued row whose request vanished goes back to pending with the next attempt', async () => {
    await submit(new FakeLlmClient());
    expect(reclaimStaleQueued(db, NOW + HOUR)).toBe(0);
    expect(reclaimStaleQueued(db, NOW + 73 * HOUR)).toBe(3);
    expect(db.prepare('SELECT parse_status, attempts, custom_id FROM gmail_messages WHERE gmail_id = ?').get(ids.order)).toEqual({ parse_status: 'pending', attempts: 1, custom_id: null });
    const llm = new FakeLlmClient();
    await submit(llm, egress, NOW + 74 * HOUR);
    expect(parseCustomId(batchCalls(llm)[0]!.customId!)!.attempt).toBe(1);
  });

  it('an attempt the LLM ledger already holds is never reused: the next free one, so one colliding item never fails the batch', async () => {
    const held = (id: string, subjectRef: string, attempt: number, o: { batchId?: string | null; status?: string } = {}) => {
      insertRequest(
        db,
        { customId: id, kind: 'ticket', subjectRef, attempt, promptVersion: TICKET_VERSION, model: DEFAULT_MODEL, inputHash: 'h', pool: 'steady', mode: 'batch', runId: null, purpose: TICKET_PURPOSE, effort: 'low', maxTokens: 1000, params: null, estimateUsd: null },
        NOW,
      );
      const handled = o.status === undefined || ['applied', 'dead_letter', 'refused'].includes(o.status);
      db.prepare('UPDATE llm_requests SET batch_id = ?, status = ?, applied_at = ? WHERE custom_id = ?').run(o.batchId === undefined ? 'msgbatch_old' : o.batchId, o.status ?? 'applied', handled ? NOW : null, id);
    };
    const cid = (gmailId: string, attempt: number) => customId('ticket', TICKET_VERSION, gmailId, attempt);
    // The order's attempt-0 id is held by another subject (custom_id keeps only [A-Za-z0-9_] of a subject).
    held(cid(ids.order, 0), 'gmail:elsewhere', 0);
    // The transfer was sent at attempt 0 and the batch layer re-queued it as attempt 1 (dead-lettered since); the
    // row was reclaimed at attempts 1 — the re-queue's id.
    held(cid(ids.transfer, 0), `gmail:${ids.transfer}`, 0, { status: 'dead_letter' });
    held(cid(ids.transfer, 1), `gmail:${ids.transfer}`, 1, { status: 'dead_letter' });
    db.prepare('UPDATE gmail_messages SET attempts = 1 WHERE gmail_id = ?').run(ids.transfer);
    // The forward's attempt 0 never reached the API (a failed submit): that id is re-used, not burnt.
    held(cid(ids.forward, 0), `gmail:${ids.forward}`, 0, { batchId: null, status: 'errored' });
    const llm = new FakeLlmClient();
    expect((await submit(llm)).stats).toMatchObject({ rendered: 3, submitted: 3, unavailable: 0 });
    const attempts = Object.fromEntries(batchCalls(llm).map((c) => [c.subjectRef!.slice(6), parseCustomId(c.customId!)!.attempt]));
    expect(attempts).toEqual({ [ids.order]: 1, [ids.transfer]: 2, [ids.forward]: 0 });
    expect(db.prepare('SELECT attempts FROM gmail_messages WHERE gmail_id = ?').pluck().get(ids.transfer)).toBe(2);
  });

  it('packetText is plain and stable (the email date in the owner’s zone, with the weekday)', () => {
    const row = { internal_at: NOW, from_domain: VENDOR_DOMAIN, vendor: VENDOR_DOMAIN, refs: '{}', clean_text: JSON.stringify({ s: 'S', t: 'T' }) };
    expect(packetText(row, NY)).toBe(`FROM DOMAIN: ${VENDOR_DOMAIN}\nSUBJECT: S\nEMAIL DATE: 2026-10-21 (Wednesday) 12:00\nOWNER TZ: ${NY}\nSTRUCTURED DATA: none\nTEXT:\nT`);
    expect(packetText({ ...row, from_domain: 'rowanquill.example', vendor: null }, NY)).toMatch(/^FROM DOMAIN: \(not a ticket vendor/);
  });
});

describe('apply (the real client over a fake API)', () => {
  const answers: Record<string, TicketEmailT> = {};
  let unregister: (() => void) | null = null;
  beforeEach(() => {
    const base: TicketEmailT = {
      kind: 'order',
      title: 'Lumen Arcade',
      performers: ['Lumen Arcade', 'Halcy Drift'],
      category: 'concert',
      genres: ['synthpop'],
      venue: 'The Copper Hall',
      city: 'Springfield',
      start_local: '2026-11-07T20:00',
      end_local: null,
      timezone: NY,
      quantity: 2,
    };
    answers[ids.order] = base;
    answers[ids.transfer] = { ...base, kind: 'transfer_out', quantity: 2 };
    answers[ids.forward] = { ...base, title: 'Halcy Drift', performers: ['Halcy Drift'], start_local: '2026-11-14T20:00', quantity: 2 };
  });
  afterEach(() => unregister?.());

  function realLlm(refuse: Set<string> = new Set()): { llm: LlmClient; api: FakeAnthropic } {
    const api = new FakeAnthropic().onBatchItem((r): BatchItemReply => {
      const id = r.custom_id.split('-')[1]!;
      if (refuse.has(id)) return { message: reply({ stop: 'refusal', category: 'cyber' }) };
      return { message: reply({ json: answers[id] }) };
    });
    return { api, llm: createLlmClient({ db, apiKey: 'synthetic-test-key', egress, fetch: api.fetch, now: () => LATER, maxRetries: 0 }) };
  }

  it('submit → collect → the ledger: events, parties, final states with the excerpt cleared', async () => {
    const jobs = ticketParseJobs({ services: () => ({}) as AgentServices });
    unregister = () => undefined;
    expect(batchConsumer(TICKET_PURPOSE)).toBeDefined();
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([['ticket-parse', { kind: 'interval', everyMs: 30 * 60_000 }]]);
    const { llm, api } = realLlm(new Set([ids.forward]));
    const r = await submitTicketParses(db, { llm, egress }, { now: NOW });
    expect(r.stats.submitted).toBe(3);
    const sent = api.requests.find((q) => q.method === 'POST' && q.path === '/v1/messages/batches')!;
    const first = (sent.body!.requests as { params: Record<string, unknown> }[])[0]!.params;
    expect(first).toMatchObject({
      model: DEFAULT_MODEL,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
    expect(first).not.toHaveProperty('fallbacks');
    const userTurns = JSON.stringify((sent.body!.requests as { params: { messages: unknown } }[]).map((q) => q.params.messages));
    for (const never of NEVER) expect(userTurns, never).not.toContain(never);

    const stats = await collectBatches({ db, llm, now: () => LATER });
    expect(stats).toMatchObject({ applied: 2, refused: 1 });
    expect(status(ids.order)).toMatchObject({ parse_status: 'parsed', has_text: 0 });
    expect(status(ids.transfer)).toMatchObject({ parse_status: 'parsed', has_text: 0 });
    expect(status(ids.forward)).toMatchObject({ parse_status: 'failed', has_text: 0, error_class: 'refused' });
    const ev = db.prepare('SELECT * FROM ticket_events WHERE merged_into_id IS NULL').all() as Record<string, unknown>[];
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ title: 'Lumen Arcade', local_date: '2026-11-07', qty_bought: 2, qty_sent: 2, held: 0, status: 'gave_away', emails: 2 });
    expect(JSON.parse(ev[0]!.partiful_ids as string)).toEqual(['AbCdEf123456']);
    expect(db.prepare('SELECT ticket_event_id FROM ticket_parties').pluck().get()).toBe(ev[0]!.id);
    // A replay of the same results changes nothing.
    const before = JSON.stringify(db.prepare('SELECT * FROM ticket_events').all());
    await collectBatches({ db, llm, now: () => LATER + HOUR });
    expect(JSON.stringify(db.prepare('SELECT * FROM ticket_events').all())).toBe(before);
  });

  it('the job skips without a key and submits with one', async () => {
    const run = async (llm: LlmClient) => {
      const [job] = ticketParseJobs({ services: () => ({ llm, egress }) as unknown as AgentServices });
      const c: JobContext = { db, jobRunId: 1, trigger: 'manual', now: () => NOW, log: { debug() {}, info() {}, warn() {}, error() {} }, signal: new AbortController().signal };
      return job!.run(c);
    };
    expect(await run(new FakeLlmClient({ configured: false }))).toEqual({ status: 'skipped' });
    expect(await run(new FakeLlmClient())).toMatchObject({ status: 'ok', stats: { pending: 3, rendered: 3, submitted: 3 } });
  });

  /** POST /gmail/disconnect {deleteData:true} (the product's cursor goes too), then a reconnect and a gmail pass. */
  async function deleteAndReconnect(at: number): Promise<{ messages: number; requests: number }> {
    const d = tx(db, () => deleteGmailData(db, { now: at }));
    deleteCursor(db, GMAIL_SOURCE, LIST_SCOPE);
    await syncGmail(db, gmailApi(connectedClient(db, KEY, CLIENT, g.fetch, 'gmail')!), { now: at });
    return d;
  }

  it('re-created rows (deleteData, then a reconnect) never reuse a sent custom_id; new mail still goes out', async () => {
    ticketParseJobs({ services: () => ({}) as AgentServices });
    const { llm } = realLlm();
    expect((await submitTicketParses(db, { llm, egress }, { now: NOW })).stats.submitted).toBe(3);
    expect(await collectBatches({ db, llm, now: () => LATER })).toMatchObject({ applied: 3 });
    // The same three mails come back at attempt 0, next to a new order.
    const fresh = g.add({ at: LATER - HOUR, from: VENDOR_FROM, subject: 'Your order confirmation', html: orderHtml({ seats: 1 }) });
    answers[fresh] = { ...answers[ids.order]!, quantity: 1 };
    expect(await deleteAndReconnect(LATER)).toMatchObject({ messages: 3, requests: 3 });
    // The retired requests keep their attempt, status and cost; the Gmail-derived packet and answer are gone.
    expect(db.prepare(`SELECT count(*) FROM llm_requests WHERE params IS NOT NULL OR output IS NOT NULL`).pluck().get()).toBe(0);
    const again = await submitTicketParses(db, { llm, egress }, { now: LATER });
    expect(again).toMatchObject({ status: 'ok', stats: { pending: 4, submitted: 4, unavailable: 0 } });
    const attempt = (id: string) => parseCustomId(db.prepare('SELECT custom_id FROM gmail_messages WHERE gmail_id = ?').pluck().get(id) as string)!.attempt;
    expect([ids.order, ids.transfer, ids.forward, fresh].map(attempt)).toEqual([1, 1, 1, 0]);
    expect(await collectBatches({ db, llm, now: () => LATER + HOUR })).toMatchObject({ applied: 4 });
    for (const id of [ids.order, ids.transfer, ids.forward, fresh]) expect(status(id).parse_status).toBe('parsed');
  });

  it('a re-created row whose request is still in a batch waits for that answer instead of racing its re-queue', async () => {
    ticketParseJobs({ services: () => ({}) as AgentServices });
    const { llm } = realLlm();
    expect((await submitTicketParses(db, { llm, egress }, { now: NOW })).stats.submitted).toBe(3);
    // Still in flight: nothing of it is retired.
    expect(await deleteAndReconnect(LATER)).toMatchObject({ messages: 3, requests: 0 });
    const again = await submitTicketParses(db, { llm, egress }, { now: LATER });
    expect(again).toMatchObject({ stats: { pending: 3, in_flight: 3, submitted: 0 } });
    for (const id of Object.values(ids)) expect(status(id)).toMatchObject({ parse_status: 'pending', has_text: 1, custom_id: null });
    // The open requests' answers land on the re-created rows (the same messages).
    expect(await collectBatches({ db, llm, now: () => LATER })).toMatchObject({ applied: 3 });
    for (const id of Object.values(ids)) expect(status(id).parse_status).toBe('parsed');
  });
});

describe('the schema', () => {
  it('has the kinds the amendments need and stays small', () => {
    expect(TicketEmail.shape.kind.options).toContain('transfer_accepted');
    expect(TicketEmail.shape.kind.options).toHaveLength(15);
    expect(Object.keys(TicketEmail.shape)).toEqual(['kind', 'title', 'performers', 'category', 'genres', 'venue', 'city', 'start_local', 'end_local', 'timezone', 'quantity']);
  });

  it('the owner accepting or claiming tickets sent to him is transfer_accepted (never counted), not transfer_in', () => {
    const def = (kind: string) => TICKET_SYSTEM.split('\n').find((l) => l.trimStart().startsWith(`- ${kind}:`))!;
    expect(def('transfer_in')).not.toMatch(/accept|claim/i);
    expect(def('transfer_accepted')).toMatch(/the owner accepted or claimed tickets someone sent him/);
    const rule = TICKET_SYSTEM.split('\n').find((l) => l.startsWith('2. Transfers'))!;
    expect(rule).not.toMatch(/or he accepted/);
    expect(rule).toMatch(/transfer_accepted/);
  });
});
